import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as readline from 'readline';
import ignore from 'ignore';

// ── Constants ──────────────────────────────────────────────────────────────────
const PEER_COLORS = [
  '#e06c75', '#98c379', '#e5c07b', '#61afef',
  '#c678dd', '#56b6c2', '#d19a66', '#abb2bf'
];
const DEBOUNCE_MS = 50;
const PRESENCE_THROTTLE_MS = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SENSITIVE_PATTERNS = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)secrets\.[^/]*/i,
  /\.(key|pem|p12)$/i,
];
// Directories to skip entirely when walking the workspace
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.hg', '.svn', 'dist', 'out', 'build', '__pycache__',
  '.vscode', '.idea',
]);

// ── Types ──────────────────────────────────────────────────────────────────────
interface PeerState {
  id: string;
  displayName: string;
  color: string;
  filePath?: string;
  line?: number;
  char?: number;
  selAnchorLine?: number;
  selAnchorChar?: number;
  selActiveLine?: number;
  selActiveChar?: number;
  cursorDeco: vscode.TextEditorDecorationType;
  selDeco: vscode.TextEditorDecorationType;
}

interface DocEntry {
  doc: Y.Doc;
  text: Y.Text;
}

interface Session {
  roomName: string;
  displayName: string;
  color: string;
  peers: Map<string, PeerState>;
  docs: Map<string, DocEntry>;
  suppressedFiles: Map<string, number>;
  colorIdx: number;
}

// ── Module-level state ─────────────────────────────────────────────────────────
let session: Session | null = null;
let sidecarProc: cp.ChildProcess | null = null;
let sidecarReady = false;
let ipcQueue: string[] = [];
let statusBar: vscode.StatusBarItem;
let sidebarProvider: SidebarProvider;
let debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let pendingBroadcastUpdates = new Map<string, Buffer>();
let applyQueues = new Map<string, Promise<void>>();
let lastPresenceSend = 0;
let msgId = 0;
let ignoreFilter: ReturnType<typeof ignore> | null = null;

// ── Suppression helpers (ref-counted to handle concurrent async applies) ───────
function suppressFile(filePath: string): void {
  if (!session) return;
  session.suppressedFiles.set(filePath, (session.suppressedFiles.get(filePath) ?? 0) + 1);
}

function unsuppressFile(filePath: string): void {
  if (!session) return;
  const n = session.suppressedFiles.get(filePath) ?? 0;
  if (n <= 1) session.suppressedFiles.delete(filePath);
  else session.suppressedFiles.set(filePath, n - 1);
}

function isFileSuppressed(filePath: string): boolean {
  return (session?.suppressedFiles.get(filePath) ?? 0) > 0;
}

// ── IPC ────────────────────────────────────────────────────────────────────────
function sendToSidecar(obj: object) {
  const line = JSON.stringify(obj) + '\n';
  if (!sidecarProc || !sidecarReady) {
    ipcQueue.push(line);
    return;
  }
  sidecarProc.stdin!.write(line);
}

function callSidecar(method: string, params: object): number {
  const id = ++msgId;
  sendToSidecar({ jsonrpc: '2.0', method, params, id });
  return id;
}

function flushIpcQueue() {
  for (const line of ipcQueue) {
    sidecarProc!.stdin!.write(line);
  }
  ipcQueue = [];
}

// ── Utility ────────────────────────────────────────────────────────────────────
function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function getRelativePath(uri: vscode.Uri): string | null {
  const root = getWorkspaceRoot();
  if (!root) return null;
  const rel = path.relative(root, uri.fsPath);
  if (rel.startsWith('..')) return null;
  return rel.replace(/\\/g, '/');
}

function getAbsPath(relPath: string): string | null {
  const root = getWorkspaceRoot();
  if (!root) return null;
  return path.join(root, relPath);
}

function fnvHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < Math.min(s.length, 4096); i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  return h || 1;
}

function isFileExcluded(relPath: string): boolean {
  for (const pat of SENSITIVE_PATTERNS) {
    if (pat.test('/' + relPath)) return true;
  }
  if (ignoreFilter?.ignores(relPath)) return true;
  const abs = getAbsPath(relPath);
  if (abs) {
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) return true;
    } catch (_) {}
  }
  return false;
}

function pickColor(): string {
  if (!session) return PEER_COLORS[0];
  const color = PEER_COLORS[session.colorIdx % PEER_COLORS.length];
  session.colorIdx++;
  return color;
}

// ── Workspace file walker ──────────────────────────────────────────────────────
/**
 * Recursively yields relative POSIX paths for every file in the workspace
 * that passes the exclusion filters. Skips common large/irrelevant directories.
 */
function* walkWorkspace(dir: string, root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkWorkspace(path.join(dir, entry.name), root);
    } else if (entry.isFile()) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (!isFileExcluded(rel)) {
        yield rel;
      }
    }
  }
}

/**
 * Reads all eligible workspace files and seeds them into Yjs.
 * Returns the count of files seeded.
 */
function seedWorkspaceFiles(root: string): number {
  let count = 0;
  for (const relPath of walkWorkspace(root, root)) {
    const abs = path.join(root, relPath);
    try {
      // Only handle text files — skip binary by checking for null bytes
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue; // binary file
      const content = buf.toString('utf8');
      getOrCreateDoc(relPath, content);
      count++;
    } catch (_) {}
  }
  return count;
}

// ── Yjs document management ────────────────────────────────────────────────────
function getOrCreateDoc(filePath: string, initialContent?: string): DocEntry {
  if (session?.docs.has(filePath)) {
    return session!.docs.get(filePath)!;
  }

  const doc = new Y.Doc();
  const text = doc.getText('content');

  if (initialContent !== undefined && initialContent.length > 0) {
    // Use content hash as stable client ID so peers with the same file
    // produce identical Yjs ops (deduplicated on merge).
    (doc as any).clientID = fnvHash(initialContent);
    doc.transact(() => {
      text.insert(0, initialContent);
    }, 'initial');
    // Switch to a unique client ID for all subsequent edits
    (doc as any).clientID = (Math.random() * 0xFFFFFFFF) >>> 0 || Date.now();
  }

  // Broadcast local changes to peers (debounced)
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'initial' || origin === 'remote') return;
    if (!session) return;
    // Accumulate updates for this file; send the merged update after debounce
    const existing = pendingBroadcastUpdates.get(filePath);
    if (existing) {
      const merged = Y.mergeUpdates([existing, Buffer.from(update)]);
      pendingBroadcastUpdates.set(filePath, Buffer.from(merged));
    } else {
      pendingBroadcastUpdates.set(filePath, Buffer.from(update));
    }
    debounce('doc:' + filePath, () => flushDocUpdate(filePath), DEBOUNCE_MS);
  });

  // Apply remote changes to the open editor using the precise Yjs delta.
  // Calls are serialized per file so each delta is applied against the correct VS Code state.
  text.observe((event: Y.YTextEvent) => {
    if (event.transaction.origin !== 'remote') return;
    const delta = event.delta;
    const prev = applyQueues.get(filePath) ?? Promise.resolve();
    const next = prev
      .then(() => applyRemoteDeltaToEditor(filePath, text, delta))
      .catch(e => console.error('[PearCollab] applyRemoteDelta failed:', e));
    applyQueues.set(filePath, next);
  });

  const entry: DocEntry = { doc, text };
  session!.docs.set(filePath, entry);
  return entry;
}

function flushDocUpdate(filePath: string) {
  const buf = pendingBroadcastUpdates.get(filePath);
  if (!buf) return;
  pendingBroadcastUpdates.delete(filePath);
  callSidecar('doc.update', { filePath, update: buf.toString('base64') });
}

async function applyRemoteDeltaToEditor(
  filePath: string,
  ytext: Y.Text,
  delta: Array<{ retain?: number; insert?: string | object; delete?: number }>
) {
  const abs = getAbsPath(filePath);
  if (!abs) return;

  const newContent = ytext.toString();
  const uri = vscode.Uri.file(abs);

  // New file: create on disk and open — VS Code reads the correct content from disk.
  if (!fs.existsSync(abs)) {
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, newContent, 'utf8');
    } catch (e) {
      console.error('[PearCollab] Failed to create file:', filePath, e);
      return;
    }
    suppressFile(filePath);
    try {
      const d = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(d, { preview: false });
    } finally {
      unsuppressFile(filePath);
    }
    return; // disk content already matches Yjs state
  }

  // Ensure the document is open in VS Code.
  let vsDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === abs);
  if (!vsDoc) {
    suppressFile(filePath);
    vsDoc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(vsDoc, { preview: false });
    unsuppressFile(filePath);
    // After opening, if VS Code content already matches Yjs (e.g. read from disk) we're done.
    if (vsDoc.getText() === newContent) return;
    // Disk diverged from Yjs — fall through to full replace below.
    delta = [{ delete: vsDoc.getText().length }, { insert: newContent }];
  }

  // Translate the Yjs delta into VS Code edits.
  // Consecutive inserts before a delete (or at end) are collapsed into a single replace
  // so VS Code gets one unambiguous operation per changed region.
  type Chunk = { startOffset: number; endOffset: number; newText: string };
  const chunks: Chunk[] = [];
  let offset = 0;
  let pendingInsert = '';

  const flushInsert = () => {
    if (!pendingInsert) return;
    chunks.push({ startOffset: offset, endOffset: offset, newText: pendingInsert });
    pendingInsert = '';
  };

  for (const op of delta) {
    if (op.retain !== undefined) {
      flushInsert();
      offset += op.retain;
    } else if (op.insert !== undefined) {
      pendingInsert += typeof op.insert === 'string' ? op.insert : '';
    } else if (op.delete !== undefined) {
      // Combine a pending insert + this delete into a single replace chunk.
      chunks.push({ startOffset: offset, endOffset: offset + op.delete, newText: pendingInsert });
      pendingInsert = '';
      offset += op.delete;
    }
  }
  flushInsert();

  if (chunks.length === 0) return;

  const workEdit = new vscode.WorkspaceEdit();
  for (const { startOffset, endOffset, newText } of chunks) {
    const startPos = vsDoc.positionAt(startOffset);
    const endPos   = vsDoc.positionAt(endOffset);
    workEdit.replace(vsDoc.uri, new vscode.Range(startPos, endPos), newText);
  }

  suppressFile(filePath);
  try {
    await vscode.workspace.applyEdit(workEdit);
  } finally {
    unsuppressFile(filePath);
  }
}

// ── Local document change handler ─────────────────────────────────────────────
function onDocumentChange(event: vscode.TextDocumentChangeEvent) {
  if (!session) return;
  if (event.contentChanges.length === 0) return;
  const filePath = getRelativePath(event.document.uri);
  if (!filePath) return;
  if (isFileSuppressed(filePath)) return;
  if (isFileExcluded(filePath)) return;

  const entry = getOrCreateDoc(filePath);
  // Sort descending by offset: process end→start so earlier offsets stay valid
  // when multiple changes arrive (e.g. multi-cursor edits).
  const changes = [...event.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
  entry.doc.transact(() => {
    for (const change of changes) {
      if (change.rangeLength > 0) {
        entry.text.delete(change.rangeOffset, change.rangeLength);
      }
      if (change.text.length > 0) {
        entry.text.insert(change.rangeOffset, change.text);
      }
    }
  }, 'local');
}

// ── Cursor presence ────────────────────────────────────────────────────────────
function onSelectionChange(event: vscode.TextEditorSelectionChangeEvent) {
  if (!session) return;
  const filePath = getRelativePath(event.textEditor.document.uri);
  if (!filePath) return;

  const now = Date.now();
  if (now - lastPresenceSend < PRESENCE_THROTTLE_MS) return;
  lastPresenceSend = now;

  const sel = event.selections[0];
  callSidecar('presence.update', {
    filePath,
    line: sel.active.line,
    char: sel.active.character,
    selAnchorLine: sel.anchor.line,
    selAnchorChar: sel.anchor.character,
    selActiveLine: sel.active.line,
    selActiveChar: sel.active.character,
    color: session.color,
    displayName: session.displayName
  });
}

// ── Cursor decorations ─────────────────────────────────────────────────────────
/**
 * Creates decorations for a peer's cursor and selection.
 * The cursor is a colored vertical bar — no name label is shown.
 */
function createDecos(color: string) {
  const cursor = vscode.window.createTextEditorDecorationType({
    borderColor: color,
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  const selection = vscode.window.createTextEditorDecorationType({
    backgroundColor: color + '33',
    borderRadius: '2px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  return { cursor, selection };
}

function updateCursorDecos(peer: PeerState) {
  if (peer.filePath === undefined || peer.line === undefined || peer.char === undefined) return;
  const abs = getAbsPath(peer.filePath);
  if (!abs) return;

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.fsPath !== abs) continue;

    const doc = editor.document;
    const cursorPos = new vscode.Position(
      Math.min(peer.line, doc.lineCount - 1),
      peer.char
    );
    const cursorRange = new vscode.Range(cursorPos, cursorPos);

    editor.setDecorations(peer.cursorDeco, [cursorRange]);

    // Selection decoration
    if (
      peer.selAnchorLine !== undefined &&
      peer.selAnchorChar !== undefined &&
      peer.selActiveLine !== undefined &&
      peer.selActiveChar !== undefined
    ) {
      const anchor = new vscode.Position(
        Math.min(peer.selAnchorLine, doc.lineCount - 1),
        peer.selAnchorChar
      );
      const active = new vscode.Position(
        Math.min(peer.selActiveLine, doc.lineCount - 1),
        peer.selActiveChar
      );
      const selRange = new vscode.Range(
        anchor.isBefore(active) ? anchor : active,
        anchor.isBefore(active) ? active : anchor
      );
      editor.setDecorations(peer.selDeco, selRange.isEmpty ? [] : [selRange]);
    }
  }
}

function clearPeerDecos(peer: PeerState) {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(peer.cursorDeco, []);
    editor.setDecorations(peer.selDeco, []);
  }
  peer.cursorDeco.dispose();
  peer.selDeco.dispose();
}

// ── Sidecar message handler ────────────────────────────────────────────────────
function handleSidecarMessage(msg: any) {
  const { method, params } = msg;

  switch (method) {
    case 'peer.connected': {
      if (!session) return;
      const color = pickColor();
      const { cursor, selection } = createDecos(color);
      const peer: PeerState = {
        id: params.peerId,
        displayName: params.displayName,
        color,
        cursorDeco: cursor,
        selDeco: selection,
      };
      session.peers.set(params.peerId, peer);
      updateStatusBar();
      sidebarProvider.refresh(session);
      showInfo(`PearCollab: ${params.displayName} joined the session.`);

      // Send full state of all known docs to the new peer
      for (const [filePath, entry] of session.docs) {
        const fullState = Y.encodeStateAsUpdate(entry.doc);
        callSidecar('doc.update', {
          filePath,
          update: Buffer.from(fullState).toString('base64'),
          targetPeerId: params.peerId,
        });
      }
      break;
    }

    case 'peer.disconnected': {
      if (!session) return;
      const peer = session.peers.get(params.peerId);
      if (peer) {
        clearPeerDecos(peer);
        session.peers.delete(params.peerId);
        showInfo(`PearCollab: ${peer.displayName} left the session.`);
      }
      updateStatusBar();
      sidebarProvider.refresh(session);
      break;
    }

    case 'doc.remoteUpdate': {
      if (!session) return;
      const entry = getOrCreateDoc(params.filePath);
      const updateBuf = Buffer.from(params.update, 'base64');
      Y.applyUpdate(entry.doc, updateBuf, 'remote');
      break;
    }

    case 'presence.remoteUpdate': {
      if (!session) return;
      const peer = session.peers.get(params.peerId);
      if (!peer) return;
      peer.filePath = params.filePath;
      peer.line = params.line;
      peer.char = params.char;
      peer.selAnchorLine = params.selAnchorLine;
      peer.selAnchorChar = params.selAnchorChar;
      peer.selActiveLine = params.selActiveLine;
      peer.selActiveChar = params.selActiveChar;
      updateCursorDecos(peer);
      sidebarProvider.refresh(session);
      break;
    }

    case 'network.status': {
      if (!session) return;
      if (params.status === 'relay') {
        showInfo('PearCollab: Using relay connection (direct connection unavailable).');
      } else if (params.status === 'disconnected') {
        updateStatusBar('disconnected');
      } else if (params.status === 'waiting') {
        updateStatusBar('waiting');
      }
      break;
    }

    case 'error': {
      if (params.code === 'DHT_FAILURE') {
        vscode.window.showErrorMessage(
          'PearCollab: Could not reach the DHT network. Check your internet connection.'
        );
      } else {
        vscode.window.showErrorMessage(`PearCollab: ${params.message}`);
      }
      break;
    }
  }
}

// ── Sidecar process ────────────────────────────────────────────────────────────
async function spawnSidecar(context: vscode.ExtensionContext): Promise<void> {
  const sidecarPath = path.join(context.extensionPath, 'sidecar', 'index.js');

  // Detect node
  let nodeCmd = 'node';
  try {
    cp.execSync('node --version', { timeout: 3000 });
  } catch (_) {
    vscode.window.showErrorMessage(
      'PearCollab: Node.js not found. Please install Node.js ≥18 from https://nodejs.org'
    );
    throw new Error('node not found');
  }

  sidecarProc = cp.spawn(nodeCmd, [sidecarPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  sidecarProc.stderr?.on('data', (data: Buffer) => {
    console.error('[PearCollab sidecar]', data.toString());
  });

  sidecarProc.on('exit', (code) => {
    if (session) {
      vscode.window.showErrorMessage(
        'PearCollab: Internal error. Session ended. Please restart the session.'
      );
      endSessionInternal();
    }
    sidecarProc = null;
    sidecarReady = false;
  });

  const rl = readline.createInterface({ input: sidecarProc.stdout! });
  rl.on('line', line => {
    try {
      const msg = JSON.parse(line.trim());
      handleSidecarMessage(msg);
    } catch (_) {}
  });

  sidecarReady = true;
  flushIpcQueue();
}

// ── Session lifecycle ──────────────────────────────────────────────────────────
async function beginSession(
  roomName: string,
  displayName: string,
  context: vscode.ExtensionContext
) {
  if (session) {
    vscode.window.showWarningMessage('PearCollab: A session is already active. End it first.');
    return;
  }

  session = {
    roomName,
    displayName,
    color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
    peers: new Map(),
    docs: new Map(),
    suppressedFiles: new Map(),
    colorIdx: 0,
  };

  // Build gitignore filter for this workspace
  ignoreFilter = null;
  const root = getWorkspaceRoot();
  if (root) {
    const gitignorePath = path.join(root, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      ignoreFilter = ignore();
      ignoreFilter.add(fs.readFileSync(gitignorePath, 'utf8'));
    }
  }

  updateStatusBar('starting');

  if (!sidecarProc) {
    await spawnSidecar(context);
  }

  callSidecar('session.start', { roomName, displayName });
}

function endSessionInternal() {
  if (!session) return;

  // Clear all peer decorations
  for (const peer of session.peers.values()) {
    clearPeerDecos(peer);
  }

  session = null;
  ignoreFilter = null;
  debounceTimers.forEach(t => clearTimeout(t));
  debounceTimers.clear();
  pendingBroadcastUpdates.clear();
  applyQueues.clear();

  updateStatusBar();
  sidebarProvider.refresh(null);
}

// ── Commands ───────────────────────────────────────────────────────────────────
async function cmdStartSession(context: vscode.ExtensionContext) {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('PearCollab: Open a folder first before starting a session.');
    return;
  }

  const displayName = await ensureDisplayName();
  if (!displayName) return;

  const roomName = await vscode.window.showInputBox({
    prompt: 'Enter a room name (share this with collaborators)',
    placeHolder: 'purple-falcon-42',
    validateInput: v => (!v || v.trim().length < 3)
      ? 'Room name must be at least 3 characters.'
      : undefined,
  });
  if (!roomName) return;

  await beginSession(roomName.trim(), displayName, context);

  // Seed every eligible file in the workspace into Yjs so peers receive
  // the full folder state when they connect.
  const count = seedWorkspaceFiles(root);
  vscode.window.showInformationMessage(
    `PearCollab: Session started. Sharing ${count} file${count !== 1 ? 's' : ''} — room "${roomName.trim()}".`
  );
}

async function cmdJoinSession(context: vscode.ExtensionContext) {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('PearCollab: Open a folder first before joining a session.');
    return;
  }

  const displayName = await ensureDisplayName();
  if (!displayName) return;

  const roomName = await vscode.window.showInputBox({
    prompt: 'Enter the room name to join',
    placeHolder: 'purple-falcon-42',
    validateInput: v => (!v || v.trim().length < 3)
      ? 'Room name must be at least 3 characters.'
      : undefined,
  });
  if (!roomName) return;

  await beginSession(roomName.trim(), displayName, context);

  // Seed any locally existing files so Yjs can merge them with the
  // remote state when the host sends its full doc updates.
  // Files that only exist on the host will be created via applyRemoteDeltaToEditor.
  seedWorkspaceFiles(root);
}

function cmdEndSession() {
  if (!session) {
    vscode.window.showInformationMessage('PearCollab: No active session.');
    return;
  }
  callSidecar('session.end', {});
  endSessionInternal();
  vscode.window.showInformationMessage('PearCollab: Session ended.');
}

function cmdCopyRoomName() {
  if (!session) {
    vscode.window.showWarningMessage('PearCollab: No active session.');
    return;
  }
  vscode.env.clipboard.writeText(session.roomName);
  vscode.window.showInformationMessage(`PearCollab: Room name "${session.roomName}" copied to clipboard.`);
}

async function ensureDisplayName(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration('pearcollab');
  const stored = config.get<string>('displayName');
  if (stored && stored.trim()) return stored.trim();

  const entered = await vscode.window.showInputBox({
    prompt: 'Enter your display name for collaborative sessions',
    placeHolder: 'Your Name',
    validateInput: v => (!v || !v.trim()) ? 'Display name cannot be empty.' : undefined,
  });

  if (!entered || !entered.trim()) return undefined;
  await config.update('displayName', entered.trim(), vscode.ConfigurationTarget.Global);
  return entered.trim();
}

// ── Status bar ─────────────────────────────────────────────────────────────────
function updateStatusBar(state?: string) {
  if (!session) {
    statusBar.text = '$(broadcast) PearCollab';
    statusBar.tooltip = 'Click to start a session';
    statusBar.command = 'pearcollab.startSession';
    statusBar.backgroundColor = undefined;
    return;
  }

  const peerCount = session.peers.size;

  if (state === 'starting') {
    statusBar.text = '$(sync~spin) PearCollab: starting...';
    statusBar.tooltip = session.roomName;
    statusBar.command = 'pearcollab.endSession';
    return;
  }

  if (state === 'waiting') {
    statusBar.text = '$(broadcast) PearCollab: waiting for peers…';
    statusBar.tooltip = `Room: ${session.roomName} — Click to end`;
    statusBar.command = 'pearcollab.copyRoomName';
    return;
  }

  if (state === 'disconnected') {
    statusBar.text = '$(warning) PearCollab: disconnected';
    statusBar.tooltip = 'Lost connection — editing locally';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  statusBar.backgroundColor = undefined;
  if (peerCount === 0) {
    statusBar.text = '$(broadcast) PearCollab: waiting for peers…';
    statusBar.tooltip = `Room: ${session.roomName}`;
    statusBar.command = 'pearcollab.copyRoomName';
  } else {
    const names = [...session.peers.values()].map(p => p.displayName).join(', ');
    statusBar.text = `$(broadcast) PearCollab: ${peerCount} peer${peerCount > 1 ? 's' : ''}`;
    statusBar.tooltip = `Connected: ${names}\nRoom: ${session.roomName}`;
    statusBar.command = 'pearcollab.endSession';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function debounce(key: string, fn: () => void, ms: number) {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    fn();
  }, ms));
}

function showInfo(msg: string) {
  vscode.window.showInformationMessage(msg);
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private readonly _extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(msg => {
      // Use executeCommand so VS Code transfers focus away from the webview
      // before showing native input boxes — otherwise showInputBox loses focus
      // immediately back to the webview and can't be typed into.
      switch (msg.command) {
        case 'startSession':  vscode.commands.executeCommand('pearcollab.startSession'); break;
        case 'joinSession':   vscode.commands.executeCommand('pearcollab.joinSession'); break;
        case 'copyRoomName':  vscode.commands.executeCommand('pearcollab.copyRoomName'); break;
        case 'endSession':    vscode.commands.executeCommand('pearcollab.endSession'); break;
      }
    });
  }

  refresh(sess: Session | null) {
    if (!this._view) return;
    const peers = sess
      ? [...sess.peers.values()].map(p => ({
          displayName: p.displayName,
          color: p.color,
          filePath: p.filePath ?? null,
        }))
      : [];
    this._view.webview.postMessage({
      type: 'update',
      session: sess
        ? { roomName: sess.roomName, displayName: sess.displayName, color: sess.color, peers }
        : null,
    });
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --radius: 4px;
    --gap: 8px;
  }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    padding: 8px 12px;
    margin: 0;
  }
  #no-session {
    display: flex;
    flex-direction: column;
    gap: var(--gap);
    align-items: flex-start;
  }
  #session {
    display: none;
    flex-direction: column;
    gap: 12px;
  }
  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 2px;
  }
  .room-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .room-name {
    font-weight: bold;
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
    border-radius: var(--radius);
    padding: 2px 6px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: var(--radius);
    padding: 3px 8px;
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .peer-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .peer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: var(--radius);
    background: var(--vscode-list-hoverBackground);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .peer-name { font-weight: 500; flex: 1; }
  .peer-file {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 120px;
    text-align: right;
  }
  .self-peer { opacity: 0.7; }
  .waiting { color: var(--vscode-descriptionForeground); font-style: italic; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
</style>
</head>
<body>
<div id="no-session">
  <div class="label">PearCollab</div>
  <p style="margin:0;color:var(--vscode-descriptionForeground)">No active session.</p>
  <div class="actions">
    <button onclick="vscode.postMessage({command:'startSession'})">Start Session</button>
    <button class="secondary" onclick="vscode.postMessage({command:'joinSession'})">Join Session</button>
  </div>
</div>
<div id="session">
  <div>
    <div class="label">Room</div>
    <div class="room-row">
      <span class="room-name" id="room-name"></span>
      <button onclick="vscode.postMessage({command:'copyRoomName'})">Copy</button>
    </div>
  </div>
  <div>
    <div class="label">Peers</div>
    <div class="peer-list" id="peer-list"></div>
  </div>
  <button class="secondary" onclick="vscode.postMessage({command:'endSession'})">End Session</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  window.addEventListener('message', e => {
    const { type, session } = e.data;
    if (type !== 'update') return;
    document.getElementById('no-session').style.display = session ? 'none' : 'flex';
    document.getElementById('session').style.display = session ? 'flex' : 'none';
    if (!session) return;

    document.getElementById('room-name').textContent = session.roomName;

    const list = document.getElementById('peer-list');
    list.innerHTML = '';

    // Self
    const selfEl = document.createElement('div');
    selfEl.className = 'peer self-peer';
    selfEl.innerHTML = \`
      <div class="dot" style="background:\${session.color}"></div>
      <div class="peer-name">\${esc(session.displayName)} (you)</div>
    \`;
    list.appendChild(selfEl);

    if (session.peers.length === 0) {
      const w = document.createElement('div');
      w.className = 'waiting';
      w.textContent = 'Waiting for peers to connect…';
      list.appendChild(w);
    } else {
      for (const p of session.peers) {
        const el = document.createElement('div');
        el.className = 'peer';
        el.innerHTML = \`
          <div class="dot" style="background:\${esc(p.color)}"></div>
          <div class="peer-name">\${esc(p.displayName)}</div>
          \${p.filePath ? \`<div class="peer-file" title="\${esc(p.filePath)}">\${esc(basename(p.filePath))}</div>\` : ''}
        \`;
        list.appendChild(el);
      }
    }
  });

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function basename(p) {
    return p.split('/').pop() || p;
  }
</script>
</body>
</html>`;
  }
}

// ── Extension entry points ─────────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(broadcast) PearCollab';
  statusBar.tooltip = 'PearCollab: P2P Collaborative Editing — click to start';
  statusBar.command = 'pearcollab.startSession';
  statusBar.show();
  context.subscriptions.push(statusBar);

  sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('pearcollab.sidebar', sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pearcollab.startSession', () => cmdStartSession(context)),
    vscode.commands.registerCommand('pearcollab.joinSession', () => cmdJoinSession(context)),
    vscode.commands.registerCommand('pearcollab.endSession', cmdEndSession),
    vscode.commands.registerCommand('pearcollab.copyRoomName', cmdCopyRoomName),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(onDocumentChange)
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(onSelectionChange)
  );

  // Pre-spawn the sidecar so it's ready when a session starts
  try {
    await spawnSidecar(context);
  } catch (_) {
    // Node not found — error shown inside spawnSidecar
  }
}

export function deactivate() {
  if (session) {
    try { callSidecar('session.end', {}); } catch (_) {}
    endSessionInternal();
  }
  if (sidecarProc) {
    sidecarProc.kill();
    sidecarProc = null;
  }
}