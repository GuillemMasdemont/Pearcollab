'use strict';

const Hyperswarm = require('hyperswarm');
const Protomux = require('protomux');
const crypto = require('crypto');
const readline = require('readline');
const dgram = require('dgram');
const net = require('net');

// ── State ──────────────────────────────────────────────────────────────────────
let swarm = null;
let ownDisplayName = 'Unknown';
// peerId -> { mux, docCh, docMsg, presCh, presMsg, displayName }
const peers = new Map();

// ── LAN discovery state ────────────────────────────────────────────────────────
const MY_SID = crypto.randomBytes(8).toString('hex'); // unique per process
const LAN_UDP_PORT = 42777;
let lanServer = null;
let lanSocket = null;
let lanBroadcastTimer = null;
let lanTopicHex = null;
let lanMyTcpPort = 0;
const lanConnected = new Set(); // remote IPs currently connected via LAN

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
    onopen() {},
    onclose() { removePeerByMux(mux); },
    onerror(err) { notify('error', { code: 'CHANNEL_ERROR', message: err.message }); }
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
      notify('doc.remoteUpdate', {
        peerId,
        displayName: peer ? peer.displayName : 'Unknown',
        filePath: decoded.filePath,
        update: decoded.update.toString('base64')
      });
      // Relay to all other peers (mesh broadcast)
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
        for (const [otherId, other] of peers) {
          if (otherId !== peerId && other.presMsg) {
            try { other.presMsg.send(buf); } catch (_) {}
          }
        }
      } catch (_) {}
    }
  });

  // Handshake channel for display name exchange
  const handshakeCh = mux.createChannel({
    protocol: 'pear-collab/v1/handshake',
    onopen() {
      handshakeMsg.send(Buffer.from(JSON.stringify({ displayName: ownDisplayName }), 'utf8'));
    },
    onclose() {}
  });

  const handshakeMsg = handshakeCh.addMessage({
    onmessage(buf) {
      try {
        const data = JSON.parse(buf.toString('utf8'));
        const peerId = getPeerIdByMux(mux);
        if (peerId && peers.has(peerId)) {
          peers.get(peerId).displayName = data.displayName || 'Unknown';
          notify('peer.connected', { peerId, displayName: data.displayName || 'Unknown' });
        }
      } catch (_) {}
    }
  });

  const peerId = crypto.randomBytes(4).toString('hex');
  peers.set(peerId, { mux, docCh, docMsg, presCh, presMsg, displayName: 'Unknown' });

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

// ── LAN discovery (UDP broadcast + raw TCP) ───────────────────────────────────
//
// Hyperswarm DHT fails on networks where both peers share the same public IP
// (e.g. same router) because routers rarely support NAT hairpinning.
// This layer broadcasts the room hash over LAN UDP so peers on the same
// network find each other directly without going through the DHT.
//
// Tie-breaker: the peer with the LOWER TCP port initiates the connection.
// This prevents both peers from connecting to each other simultaneously.

function startLanDiscovery(topicBuffer) {
  return new Promise(resolve => {
    lanTopicHex = topicBuffer.toString('hex');

    // TCP server: receives incoming connections from LAN peers
    lanServer = net.createServer(socket => {
      const ip = normaliseIp(socket.remoteAddress || '');
      if (lanConnected.has(ip)) {
        socket.destroy(); // duplicate — the tiebreaker should prevent this
        return;
      }
      lanConnected.add(ip);
      socket.on('close', () => lanConnected.delete(ip));
      setupConnection(socket);
    });

    lanServer.listen(0, () => {
      lanMyTcpPort = lanServer.address().port;

      lanSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      lanSocket.on('error', () => {}); // tolerate UDP errors gracefully

      lanSocket.bind(LAN_UDP_PORT, () => {
        try { lanSocket.setBroadcast(true); } catch (_) {}

        lanSocket.on('message', (buf, rinfo) => {
          try {
            const data = JSON.parse(buf.toString());
            if (data.topic !== lanTopicHex) return;
            if (data.sid === MY_SID) return; // our own broadcast

            const ip = normaliseIp(rinfo.address);
            if (lanConnected.has(ip)) return; // already connected to this IP

            // Only the lower-port peer initiates to avoid two simultaneous connections
            if (lanMyTcpPort >= data.tcpPort) return;

            lanConnected.add(ip);
            const sock = net.connect(data.tcpPort, ip);
            sock.on('connect', () => setupConnection(sock));
            sock.on('error', () => lanConnected.delete(ip));
            sock.on('close', () => lanConnected.delete(ip));
          } catch (_) {}
        });

        function doBroadcast() {
          if (!lanTopicHex || !lanSocket) return;
          const msg = Buffer.from(JSON.stringify({
            topic: lanTopicHex,
            tcpPort: lanMyTcpPort,
            sid: MY_SID
          }));
          try { lanSocket.send(msg, LAN_UDP_PORT, '255.255.255.255'); } catch (_) {}
          lanBroadcastTimer = setTimeout(doBroadcast, 2000);
        }
        doBroadcast();
        resolve();
      });
    });
  });
}

function stopLanDiscovery() {
  if (lanBroadcastTimer) { clearTimeout(lanBroadcastTimer); lanBroadcastTimer = null; }
  lanTopicHex = null;
  lanMyTcpPort = 0;
  lanConnected.clear();
  if (lanSocket) { try { lanSocket.close(); } catch (_) {} lanSocket = null; }
  if (lanServer) { try { lanServer.close(); } catch (_) {} lanServer = null; }
}

function normaliseIp(ip) {
  return ip.replace(/^::ffff:/, '');
}

// ── Session management ────────────────────────────────────────────────────────
async function startSession(roomName, displayName, id) {
  if (swarm) {
    await endSession();
  }

  ownDisplayName = displayName;

  try {
    swarm = new Hyperswarm();

    swarm.on('connection', (socket, peerInfo) => {
      const isRelay = peerInfo.topics && peerInfo.relayed;
      notify('network.status', { status: isRelay ? 'relay' : 'direct' });
      setupConnection(socket);
    });

    swarm.on('close', () => {
      notify('network.status', { status: 'disconnected' });
    });

    const topic = crypto.createHash('sha256').update(roomName).digest();
    swarm.join(topic, { server: true, client: true });

    // Run DHT flush and LAN discovery in parallel
    await Promise.all([
      swarm.flush().catch(err => {
        notify('error', { code: 'DHT_FAILURE', message: err.message });
      }),
      startLanDiscovery(topic),
    ]);

    respond(id, { ok: true });
    notify('network.status', { status: 'waiting' });
  } catch (err) {
    respond(id, { ok: false, error: err.message });
    notify('error', { code: 'DHT_FAILURE', message: err.message });
  }
}

async function endSession(id) {
  stopLanDiscovery();

  for (const [, peer] of peers) {
    try {
      peer.docCh && peer.docCh.close();
      peer.presCh && peer.presCh.close();
    } catch (_) {}
  }
  peers.clear();

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
      startSession(params.roomName, params.displayName, id);
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
