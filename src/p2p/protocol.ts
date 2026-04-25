import b4a from 'b4a';

export type MessageType = 'chat' | 'presence' | 'data';

export interface PearMessage {
  type: MessageType;
  from: string;
  payload: string;
  timestamp: number;
}

export function encodeMessage(msg: PearMessage): Buffer {
  return b4a.from(JSON.stringify(msg));
}

export function decodeMessage(raw: Buffer | Uint8Array): PearMessage | null {
  try {
    return JSON.parse(b4a.toString(raw)) as PearMessage;
  } catch {
    return null;
  }
}
