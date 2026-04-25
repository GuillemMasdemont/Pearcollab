import * as vscode from 'vscode';

export class PearStatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'pearCollab.connect';
    this.setDisconnected();
    this.item.show();
  }

  setDisconnected(): void {
    this.item.text = '$(circle-slash) Pear';
    this.item.tooltip = 'Pear: disconnected — click to connect';
    this.item.color = undefined;
  }

  setConnecting(room: string): void {
    this.item.text = `$(loading~spin) Pear: ${room}`;
    this.item.tooltip = 'Pear: connecting…';
  }

  setConnected(room: string, peers: number): void {
    this.item.text = `$(broadcast) Pear: ${room} (${peers} peer${peers === 1 ? '' : 's'})`;
    this.item.tooltip = 'Pear: connected — click to change room';
    this.item.command = 'pearCollab.disconnect';
  }

  updatePeers(room: string, peers: number): void {
    this.setConnected(room, peers);
  }

  dispose(): void {
    this.item.dispose();
  }
}
