import * as vscode from 'vscode';

export const CONFIG_SECTION = 'spotifyLocal';

const settings = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(CONFIG_SECTION);

export function getClientId(): string {
  return settings().get<string>('clientId', '').trim();
}

export function getLyricsOffsetMs(): number {
  const value = settings().get<number>('lyricsOffsetMs', 0);
  return Number.isFinite(value) ? value : 0;
}

export function setLyricsOffsetMs(value: number): Thenable<void> {
  return settings().update('lyricsOffsetMs', value, vscode.ConfigurationTarget.Global);
}

export function getShowLyricsInStatusBar(): boolean {
  return settings().get<boolean>('showLyricsInStatusBar', true);
}

export function setShowLyricsInStatusBar(value: boolean): Thenable<void> {
  return settings().update('showLyricsInStatusBar', value, vscode.ConfigurationTarget.Global);
}
