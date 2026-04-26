'use strict';

const Hyperswarm = require('hyperswarm');
const Protomux = require('protomux');
const crypto = require('crypto');
const readline = require('readline');

// ── State ──────────────────────────────────────────────────────────────────────
let swarm = null;
let ownDisplayName = 'Unknown';
let ownToken = null;
// peerId -> { mux, docCh, docMsg, presCh, presMsg, displayName }
const peers = new Map();

// ── IPC helpers ───────────────────────────────────────────────────────────────
function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { message } }) + '\n');
}

// ── Wire encoding: [4-byte pathLen][path][update] ─────────────────────────────
function encodeDocMsg(filePath, updateBuf) {
  const pathBuf = Buffer.from(filePath, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(pathBuf.length, 0);
  return Buffer.concat([header, pathBuf, updateBuf]);
}

function decodeDocMsg(buf) {
  if (buf.length < 4) return null;
  const pathLen = buf.readUInt32BE(0);
  if (buf.length < 4 + pathLen) return null;
  const filePath = buf.slice(4, 4 + pathLen).toString('utf8');
  const update = buf.slice(4 + pathLen);
  return { filePath, update };
}

// ── Connection setup ──────────────────────────────────────────────────────────
function setupConnection(socket) {
  const mux = new Protomux(socket);

  const docCh = mux.createChannel({
    protocol: 'pear-collab/v1/doc',
    onopen() {
      // Both sides have opened — exchange can begin; extension will trigger initial sync
    },
    onclose() {
      removePeerByMux(mux);
    },
    onerror(err) {
      notify('error', { code: 'CHANNEL_ERROR', message: err.message });
    }
  });

  const presCh = mux.createChannel({
    protocol: 'pear-collab/v1/presence',
    onclose() {}
  });

  const docMsg = docCh.addMessage({
    onmessage(buf) {
      const decoded = decodeDocMsg(buf);
      if (!decoded) return;
      const peerId = getPeerIdByMux(mux);
      if (!peerId) return;
      const peer = peers.get(peerId);
      // Forward to extension
      notify('doc.remoteUpdate', {
        peerId,
        displayName: peer ? peer.displayName : 'Unknown',
        filePath: decoded.filePath,
        update: decoded.update.toString('base64')
      });
      // Relay to all OTHER peers (mesh broadcast)
      for (const [otherId, other] of peers) {
        if (otherId !== peerId && other.docMsg) {
          try { other.docMsg.send(buf); } catch (_) {}
        }
      }
    }
  });

  const presMsg = presCh.addMessage({
    onmessage(buf) {
      try {
        const data = JSON.parse(buf.toString('utf8'));
        const peerId = getPeerIdByMux(mux);
        if (!peerId) return;
        notify('presence.remoteUpdate', { peerId, ...data });
        // Relay to other peers
        for (const [otherId, other] of peers) {
          if (otherId !== peerId && other.presMsg) {
            try { other.presMsg.send(buf); } catch (_) {}
          }
        }
      } catch (_) {}
    }
  });

  // Handshake channel for display name + token exchange
  const handshakeCh = mux.createChannel({
    protocol: 'pear-collab/v1/handshake',
    onopen() {
      handshakeMsg.send(Buffer.from(JSON.stringify({ displayName: ownDisplayName, token: ownToken }), 'utf8'));
    },
    onclose() {}
  });

  const handshakeMsg = handshakeCh.addMessage({
    onmessage(buf) {
      try {
        const data = JSON.parse(buf.toString('utf8'));
        const normalize = t => (t || '').replace(/[-\s]/g, '').toUpperCase();
        if (ownToken && normalize(data.token) !== normalize(ownToken)) {
          notify('error', { code: 'AUTH_FAILED', message: 'Peer rejected: invalid token' });
          try { socket.destroy(); } catch (_) {}
          const peerId = getPeerIdByMux(mux);
          if (peerId) peers.delete(peerId);
          return;
        }
        const peerId = getPeerIdByMux(mux);
        if (peerId && peers.has(peerId)) {
          peers.get(peerId).displayName = data.displayName || 'Unknown';
          notify('peer.connected', { peerId, displayName: data.displayName || 'Unknown' });
        }
      } catch (_) {}
    }
  });

  // Generate a peerId before opening channels
  const peerId = crypto.randomBytes(4).toString('hex');
  peers.set(peerId, { mux, docCh, docMsg, presCh, presMsg, displayName: 'Unknown' });

  // Open all channels
  docCh.open();
  presCh.open();
  handshakeCh.open();
}

function getPeerIdByMux(mux) {
  for (const [id, peer] of peers) {
    if (peer.mux === mux) return id;
  }
  return null;
}

function removePeerByMux(mux) {
  for (const [id, peer] of peers) {
    if (peer.mux === mux) {
      peers.delete(id);
      notify('peer.disconnected', { peerId: id });
      updateNetworkStatus();
      return;
    }
  }
}

function updateNetworkStatus() {
  if (peers.size === 0) {
    notify('network.status', { status: 'waiting' });
  }
}

// ── Session management ────────────────────────────────────────────────────────
async function startSession(roomName, displayName, token, id) {
  if (swarm) {
    await endSession();
  }

  ownDisplayName = displayName;
  ownToken = token || null;

  try {
    swarm = new Hyperswarm();

    swarm.on('connection', (socket, peerInfo) => {
      // Detect if using relay
      const isRelay = peerInfo.topics && peerInfo.relayed;
      if (isRelay) {
        notify('network.status', { status: 'relay' });
      } else {
        notify('network.status', { status: 'direct' });
      }
      setupConnection(socket);
    });

    swarm.on('close', () => {
      notify('network.status', { status: 'disconnected' });
    });

    const topic = crypto.createHash('sha256').update(roomName).digest();
    swarm.join(topic, { server: true, client: true });

    // Wait for DHT flush (confirms DHT announcement)
    await swarm.flush();
    respond(id, { ok: true });
    notify('network.status', { status: 'waiting' });
  } catch (err) {
    respond(id, { ok: false, error: err.message });
    notify('error', { code: 'DHT_FAILURE', message: err.message });
  }
}

async function endSession(id) {
  for (const [, peer] of peers) {
    try {
      peer.docCh && peer.docCh.close();
      peer.presCh && peer.presCh.close();
    } catch (_) {}
  }
  peers.clear();
  ownToken = null;

  if (swarm) {
    try { await swarm.destroy(); } catch (_) {}
    swarm = null;
  }

  if (id !== undefined) respond(id, { ok: true });
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function broadcastDocUpdate(filePath, updateBase64, targetPeerId) {
  const updateBuf = Buffer.from(updateBase64, 'base64');
  const msg = encodeDocMsg(filePath, updateBuf);
  for (const [peerId, peer] of peers) {
    if (targetPeerId && peerId !== targetPeerId) continue;
    if (peer.docMsg) {
      try { peer.docMsg.send(msg); } catch (_) {}
    }
  }
}

function broadcastPresence(params) {
  const buf = Buffer.from(JSON.stringify({
    displayName: ownDisplayName,
    filePath: params.filePath,
    line: params.line,
    char: params.char,
    selAnchorLine: params.selAnchorLine,
    selAnchorChar: params.selAnchorChar,
    selActiveLine: params.selActiveLine,
    selActiveChar: params.selActiveChar,
    color: params.color
  }), 'utf8');

  for (const [, peer] of peers) {
    if (peer.presMsg) {
      try { peer.presMsg.send(buf); } catch (_) {}
    }
  }
}

// ── IPC message dispatch ──────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line.trim()); } catch (_) { return; }

  const { id, method, params } = msg;

  switch (method) {
    case 'session.start':
      startSession(params.roomName, params.displayName, params.token, id);
      break;
    case 'session.end':
      endSession(id);
      break;
    case 'doc.update':
      broadcastDocUpdate(params.filePath, params.update, params.targetPeerId);
      if (id !== undefined) respond(id, { ok: true });
      break;
    case 'presence.update':
      broadcastPresence(params);
      if (id !== undefined) respond(id, { ok: true });
      break;
    default:
      if (id !== undefined) respondError(id, `Unknown method: ${method}`);
  }
});

rl.on('close', () => {
  endSession().finally(() => process.exit(0));
});

process.on('uncaughtException', err => {
  notify('error', { code: 'UNCAUGHT', message: err.message });
});
