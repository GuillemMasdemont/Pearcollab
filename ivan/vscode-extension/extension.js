'use strict'

const vscode = require('vscode')
const path = require('path')
const fsp = require('fs').promises
const { mkdirSync, existsSync } = require('fs')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const Protomux = require('protomux')
const cenc = require('compact-encoding')
const b4a = require('b4a')
const chokidar = require('chokidar')

let activeSession = null
let out = null
let bar = null

function log (...args) {
  const ts = new Date().toISOString().slice(11, 23)
  out.appendLine(`[${ts}] ${args.join(' ')}`)
}

function setBar (text) {
  bar.text = `$(sync) Pear Sync: ${text}`
}

// ── Loop-guard ────────────────────────────────────────────────────────────────
// Prevents the file watcher from echoing remote writes back into Autobase.
const applying = new Map()

function markApplying (relPath) {
  clearTimeout(applying.get(relPath))
  applying.set(relPath, setTimeout(() => applying.delete(relPath), 2000))
}

// ── Filesystem sink ───────────────────────────────────────────────────────────

async function applyToFs (op, folder) {
  const absPath = path.join(folder, op.path)
  if (absPath !== folder && !absPath.startsWith(folder + path.sep)) return
  markApplying(op.path)
  if (op.type === 'write') {
    await fsp.mkdir(path.dirname(absPath), { recursive: true })
    await fsp.writeFile(absPath, b4a.from(op.content, 'base64'))
    log('sync +', op.path)
  } else if (op.type === 'delete') {
    await fsp.unlink(absPath).catch(() => {})
    log('sync -', op.path)
  }
}

// ── Autobase apply function ───────────────────────────────────────────────────

async function apply (nodes, view, host, folder) {
  const b = view.batch()
  for (const node of nodes) {
    const op = node.value
    if (op.addWriter) {
      try {
        await host.addWriter(b4a.from(op.addWriter, 'hex'), { indexer: true })
        log('writer registered:', op.addWriter.slice(0, 16) + '...')
      } catch (err) {
        log('writer registration skipped:', err.message)
      }
      continue
    }
    if (op.type === 'write') {
      await b.put(op.path, { content: op.content })
    } else if (op.type === 'delete') {
      await b.del(op.path)
    }
    await applyToFs(op, folder)
  }
  await b.flush()
}

// ── Initial sync ──────────────────────────────────────────────────────────────

async function * walkDir (dir) {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield * walkDir(full)
    else yield full
  }
}

async function initialSync (base, folder) {
  if (!base.writable || !base.view) return
  for await (const absPath of walkDir(folder)) {
    const relPath = path.relative(folder, absPath)
    if (applying.has(relPath)) continue
    const existing = await base.view.get(relPath).catch(() => null)
    if (existing) continue
    const content = await fsp.readFile(absPath).catch(() => null)
    if (!content) continue
    log('initial +', relPath)
    await base.append({ type: 'write', path: relPath, content: content.toString('base64') }).catch(log)
  }
}

// ── Core session ──────────────────────────────────────────────────────────────

async function startSession (storePath, folder, bootstrapKey, { onPeerConnect } = {}) {
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true })

  const store = new Corestore(storePath)

  const base = new Autobase(store, bootstrapKey, {
    valueEncoding: 'json',
    apply: (nodes, view, host) => apply(nodes, view, host, folder),
    open: (s) => new Hyperbee(s.get({ name: 'view' }), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
  })

  await base.ready()

  const writerKey = b4a.toString(base.local.key, 'hex')
  const bsKey = b4a.toString(base.key, 'hex')

  const swarm = new Hyperswarm()
  swarm.on('error', (err) => log('swarm error:', err.message))

  let firstPeer = true

  swarm.on('connection', (socket, peerInfo) => {
    const peerKey = b4a.toString(peerInfo.publicKey, 'hex').slice(0, 16) + '...'
    log(`+ peer connected: ${peerKey}`)
    socket.on('error', (err) => log(`socket error [${peerKey}]:`, err.message))
    socket.on('close', () => {
      log(`- peer disconnected [${peerKey}]`)
      setBar(`${swarm.connections.size} peer(s)`)
    })

    const repl = store.replicate(socket)
    repl.on('error', (err) => log(`replication error [${peerKey}]:`, err.message))

    // Pull new data immediately instead of waiting for the 1-second poll.
    base.update().catch((err) => log('update error:', err.message))

    const mux = Protomux.from(repl)
    const channel = mux.createChannel({
      protocol: 'folder-sync/v1',
      onopen () { log(`handshake open [${peerKey}]`) },
      onclose () { log(`handshake closed [${peerKey}]`) }
    })

    const handshake = channel.addMessage({
      encoding: cenc.string,
      onmessage: async (peerWriterKey) => {
        log(`received writer key from [${peerKey}]`)
        if (!base.writable) {
          // Not writable yet — schedule a retry once Autobase grants write access.
          base.once('writable', async () => {
            await base.append({ addWriter: peerWriterKey }).catch((err) =>
              log(`addWriter retry error [${peerKey}]:`, err.message)
            )
          })
          return
        }
        await base.append({ addWriter: peerWriterKey }).catch((err) =>
          log(`addWriter error [${peerKey}]:`, err.message)
        )
      }
    })

    channel.open()
    handshake.send(writerKey)

    if (firstPeer) {
      firstPeer = false
      if (onPeerConnect) onPeerConnect()
    }

    setBar(`${swarm.connections.size} peer(s)`)
  })

  swarm.join(base.discoveryKey)
  await swarm.flush()
  log('announced on DHT, peers:', swarm.connections.size)

  await base.update()
  log('base ready  writable:', base.writable, ' length:', base.length)

  await initialSync(base, folder)
  base.once('writable', () => initialSync(base, folder).catch(log))

  const watcher = chokidar.watch(folder, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  })

  async function onFileEvent (type, filePath) {
    const relPath = path.relative(folder, filePath)
    if (applying.has(relPath)) return
    if (!base.writable) { log('(not writable yet)'); return }
    let op
    if (type === 'delete') {
      op = { type: 'delete', path: relPath }
    } else {
      const content = await fsp.readFile(filePath).catch(() => null)
      if (!content) return
      op = { type: 'write', path: relPath, content: content.toString('base64') }
    }
    const icon = type === 'delete' ? '-' : type === 'add' ? '+' : '~'
    log(icon, relPath)
    await base.append(op).catch(log)
  }

  watcher.on('add',    (p) => onFileEvent('add', p))
  watcher.on('change', (p) => onFileEvent('change', p))
  watcher.on('unlink', (p) => onFileEvent('delete', p))

  const updateInterval = setInterval(() =>
    base.update().catch((err) => log('update poll error:', err.message)), 1000)

  const statusInterval = setInterval(() => {
    setBar(`${swarm.connections.size} peer(s)`)
    log(`peers=${swarm.connections.size}  writable=${base.writable}  length=${base.length}`)
  }, 10000)

  return {
    bsKey,
    async stop () {
      clearInterval(updateInterval)
      clearInterval(statusInterval)
      await Promise.allSettled([watcher.close(), swarm.destroy(), store.close()])
    }
  }
}

// ── Extension entry points ────────────────────────────────────────────────────

async function activate (context) {
  out = vscode.window.createOutputChannel('Pear Sync')
  context.subscriptions.push(out)

  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10)
  bar.command = 'pear-sync.stop'
  bar.tooltip = 'Pear Sync active — click to stop'
  context.subscriptions.push(bar)

  function getFolder () {
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      vscode.window.showErrorMessage('Pear Sync: open a workspace folder first.')
      return null
    }
    return folders[0].uri.fsPath
  }

  function getStorePath (suffix = 'host') {
    const base = context.globalStorageUri.fsPath
    if (!existsSync(base)) mkdirSync(base, { recursive: true })
    return path.join(base, 'store-' + suffix)
  }

  // ── pear-sync.start ──────────────────────────────────────────────────────────
  context.subscriptions.push(vscode.commands.registerCommand('pear-sync.start', async () => {
    if (activeSession) { vscode.window.showWarningMessage('Pear Sync is already running.'); return }
    const folder = getFolder()
    if (!folder) return

    out.show()
    log('Starting new session for:', folder)
    setBar('starting…')
    bar.show()

    try {
      activeSession = await startSession(getStorePath(), folder, null)
      log('Bootstrap key:', activeSession.bsKey)
      setBar('0 peer(s)')

      const action = await vscode.window.showInformationMessage(
        'Pear Sync: session started. Share this bootstrap key with your peer.',
        'Copy Key'
      )
      if (action === 'Copy Key') {
        await vscode.env.clipboard.writeText(activeSession.bsKey)
        vscode.window.showInformationMessage('Bootstrap key copied to clipboard.')
      }
    } catch (err) {
      log('Error:', err.message)
      vscode.window.showErrorMessage(`Pear Sync: ${err.message}`)
      activeSession = null
      bar.hide()
    }
  }))

  // ── pear-sync.join ───────────────────────────────────────────────────────────
  context.subscriptions.push(vscode.commands.registerCommand('pear-sync.join', async () => {
    if (activeSession) { vscode.window.showWarningMessage('Pear Sync is already running.'); return }
    const folder = getFolder()
    if (!folder) return

    const bsKey = await vscode.window.showInputBox({
      prompt: 'Paste the bootstrap key from the host peer',
      placeHolder: '64-character hex string…',
      validateInput: (v) => (v && v.length === 64 ? null : 'Must be a 64-character hex string')
    })
    if (!bsKey) return

    out.show()
    log('Joining session:', bsKey)
    setBar('connecting…')
    bar.show()

    try {
      activeSession = await startSession(
        getStorePath(bsKey.slice(0, 16)),
        folder,
        b4a.from(bsKey, 'hex'),
        {
          onPeerConnect: () => {
            vscode.window.showInformationMessage('Pear Sync: peer connected — syncing files now.')
          }
        }
      )
      log('Joined session:', activeSession.bsKey)
      setBar('0 peer(s)')
      vscode.window.showInformationMessage('Pear Sync: session joined. Waiting for peer to connect…')
    } catch (err) {
      log('Error:', err.message)
      vscode.window.showErrorMessage(`Pear Sync: ${err.message}`)
      activeSession = null
      bar.hide()
    }
  }))

  // ── pear-sync.stop ───────────────────────────────────────────────────────────
  context.subscriptions.push(vscode.commands.registerCommand('pear-sync.stop', async () => {
    if (!activeSession) { vscode.window.showInformationMessage('Pear Sync is not running.'); return }
    log('Stopping session…')
    await activeSession.stop()
    activeSession = null
    bar.hide()
    log('Session stopped.')
    vscode.window.showInformationMessage('Pear Sync stopped.')
  }))

  // ── pear-sync.clearStore ─────────────────────────────────────────────────────
  context.subscriptions.push(vscode.commands.registerCommand('pear-sync.clearStore', async () => {
    if (activeSession) { vscode.window.showWarningMessage('Stop the session before clearing the store.'); return }
    const base = context.globalStorageUri.fsPath
    await fsp.rm(base, { recursive: true, force: true })
    log('Store cleared:', base)
    vscode.window.showInformationMessage('Pear Sync: store cleared.')
  }))
}

async function deactivate () {
  if (activeSession) {
    await activeSession.stop()
    activeSession = null
  }
}

module.exports = { activate, deactivate }
