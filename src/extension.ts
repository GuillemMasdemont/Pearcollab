import * as vscode from 'vscode';
import { SwarmManager } from './p2p/SwarmManager';
import { PearStatusBar } from './ui/StatusBar';
import { PearMessage } from './p2p/protocol';

let swarm: SwarmManager | null = null;
let statusBar: PearStatusBar | null = null;
let currentRoom: string | null = null;

export function activate(context: vscode.ExtensionContext): void {
  statusBar = new PearStatusBar();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('pearCollab.connect', cmdConnect),
    vscode.commands.registerCommand('pearCollab.disconnect', cmdDisconnect),
    vscode.commands.registerCommand('pearCollab.broadcast', cmdBroadcast),
  );
}

export async function deactivate(): Promise<void> {
  await swarm?.leave();
}

async function cmdConnect(): Promise<void> {
  const room = await vscode.window.showInputBox({
    prompt: 'Enter room name',
    placeHolder: 'e.g. my-project-room',
    value: currentRoom ?? '',
  });
  if (!room) {
    return;
  }

  if (!swarm) {
    swarm = new SwarmManager();
    swarm.on('message', onMessage);
    swarm.on('peer-joined', (count: number) => {
      statusBar?.updatePeers(currentRoom!, count);
      vscode.window.setStatusBarMessage(`Pear: peer joined (${count} total)`, 3000);
    });
    swarm.on('peer-left', (count: number) => {
      statusBar?.updatePeers(currentRoom!, count);
      vscode.window.setStatusBarMessage(`Pear: peer left (${count} remaining)`, 3000);
    });
  }

  currentRoom = room;
  statusBar?.setConnecting(room);

  try {
    await swarm.join(room);
    statusBar?.setConnected(room, swarm.peerCount);
    vscode.window.showInformationMessage(`Pear: joined room "${room}"`);
  } catch (err) {
    vscode.window.showErrorMessage(`Pear: failed to connect — ${err}`);
    statusBar?.setDisconnected();
  }
}

async function cmdDisconnect(): Promise<void> {
  await swarm?.leave();
  swarm = null;
  currentRoom = null;
  statusBar?.setDisconnected();
  vscode.window.showInformationMessage('Pear: disconnected');
}

async function cmdBroadcast(): Promise<void> {
  if (!swarm?.isConnected) {
    vscode.window.showWarningMessage('Pear: not connected to a room');
    return;
  }

  const text = await vscode.window.showInputBox({ prompt: 'Message to broadcast' });
  if (!text) {
    return;
  }

  swarm.broadcast('chat', text);
}

function onMessage(msg: PearMessage): void {
  if (msg.type === 'chat') {
    vscode.window.showInformationMessage(`[Pear] ${msg.from}: ${msg.payload}`);
  }
}
