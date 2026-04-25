import { EventEmitter } from 'events';
import Hyperswarm from 'hyperswarm';
import crypto from 'hypercore-crypto';
import b4a from 'b4a';
import { encodeMessage, decodeMessage, PearMessage, MessageType } from './protocol';

export class SwarmManager extends EventEmitter {
  private swarm: InstanceType<typeof Hyperswarm> | null = null;
  private peerId: string;
  private connections = new Set<NodeJS.ReadWriteStream>();

  constructor() {
    super();
    // Stable local identity for this VS Code session
    this.peerId = b4a.toString(crypto.randomBytes(4), 'hex');
  }

  get peerCount(): number {
    return this.connections.size;
  }

  get isConnected(): boolean {
    return this.swarm !== null;
  }

  async join(roomName: string): Promise<void> {
    if (this.swarm) {
      await this.leave();
    }

    this.swarm = new Hyperswarm();
    const topic = crypto.hash(b4a.from(roomName));

    this.swarm.on('connection', (socket: NodeJS.ReadWriteStream) => {
      this.connections.add(socket);
      this.emit('peer-joined', this.connections.size);

      // Announce presence to the new peer
      this._send(socket, { type: 'presence', from: this.peerId, payload: 'joined', timestamp: Date.now() });

      socket.on('data', (raw: Buffer) => {
        const msg = decodeMessage(raw);
        if (msg) {
          this.emit('message', msg);
        }
      });

      socket.on('close', () => {
        this.connections.delete(socket);
        this.emit('peer-left', this.connections.size);
      });

      socket.on('error', () => {
        this.connections.delete(socket);
      });
    });

    this.swarm.join(topic, { client: true, server: true });
    await this.swarm.flush();
  }

  broadcast(type: MessageType, payload: string): void {
    const msg: PearMessage = { type, from: this.peerId, payload, timestamp: Date.now() };
    for (const socket of this.connections) {
      this._send(socket, msg);
    }
  }

  async leave(): Promise<void> {
    if (!this.swarm) {
      return;
    }
    await this.swarm.destroy();
    this.swarm = null;
    this.connections.clear();
    this.emit('disconnected');
  }

  private _send(socket: NodeJS.ReadWriteStream, msg: PearMessage): void {
    try {
      (socket as NodeJS.WritableStream).write(encodeMessage(msg));
    } catch {
      // socket may have closed
    }
  }
}
