import * as vscode from 'vscode';
import { AuthManager } from './auth/authManager';
import { TokenStore } from './auth/tokenStore';
import {
  CONFIG_SECTION,
  getLyricsOffsetMs,
  getShowLyricsInStatusBar,
  setLyricsOffsetMs,
  setShowLyricsInStatusBar,
} from './config';
import { describeError } from './errors';
import { LyricsSource } from './lyrics/lrclib';
import { LyricsSync } from './lyrics/lyricsSync';
import { SpotifyClient } from './spotify/client';
import { Library } from './spotify/library';
import { PlaybackMonitor } from './spotify/playbackMonitor';
import { Player } from './spotify/player';
import { searchTracks } from './spotify/search';
import type { UserProfile } from './spotify/types';
import { DeviceGuard } from './ui/deviceGuard';
import { createLibraryCommands } from './ui/libraryCommands';
import { LibraryTreeProvider } from './ui/libraryView';
import { LyricsViewProvider } from './ui/lyricsView';
import { showError } from './ui/notifications';
import { createPlaybackCommands } from './ui/playbackCommands';
import { StatusBar } from './ui/statusBar';

const LYRICS_OFFSET_STEP_MS = 250;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Spotify Local', { log: true });
  const store = new TokenStore(context.secrets);
  const auth = new AuthManager(store, log);
  const client = new SpotifyClient(auth, log);
  const player = new Player(client);
  const monitor = new PlaybackMonitor(player, log);
  const statusBar = new StatusBar();
  // LRCLIB pide que cada cliente se identifique. Las cabeceras HTTP solo admiten ASCII.
  const userAgent = `spotify-local-vscode/${context.extension.packageJSON.version} (personal VS Code extension)`;
  const lyricsSource = new LyricsSource(userAgent, log);
  const lyrics = new LyricsSync(monitor, (track) => lyricsSource.get(track), getLyricsOffsetMs);
  const lyricsView = new LyricsViewProvider(lyrics);
  const guard = new DeviceGuard(player, log);
  const library = new Library(client, auth);
  const libraryView = new LibraryTreeProvider(library, auth);
  context.subscriptions.push(
    log,
    store,
    auth,
    monitor,
    statusBar,
    lyrics,
    lyricsView,
    library,
    libraryView,
    vscode.window.registerWebviewViewProvider(LyricsViewProvider.viewId, lyricsView),
    vscode.window.registerTreeDataProvider(LibraryTreeProvider.viewId, libraryView),
  );

  const register = (id: string, handler: (...args: any[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (err) {
          log.error(`${id}: ${describeError(err)}`);
          await showError(err);
        }
      }),
    );
  };

  register('spotifyLocal.login', async () => {
    await auth.login();
    const me = await client.get<UserProfile>('/me');
    const name = me?.display_name ?? me?.id ?? 'usuario desconocido';
    void vscode.window.showInformationMessage(`Spotify: sesión iniciada como ${name}.`);
  });
  register('spotifyLocal.logout', async () => {
    await auth.logout();
    void vscode.window.showInformationMessage('Spotify: sesión cerrada.');
  });
  const commands = {
    ...createPlaybackCommands(player, monitor, guard, (query) => searchTracks(client, query)),
    ...createLibraryCommands(library, player, guard, monitor),
  };
  for (const [id, handler] of Object.entries(commands)) {
    register(id, handler);
  }

  const changeLyricsOffset = async (deltaMs: number): Promise<void> => {
    const offset = getLyricsOffsetMs() + deltaMs;
    await setLyricsOffsetMs(offset);
    vscode.window.setStatusBarMessage(`Spotify: offset de la letra ${offset > 0 ? '+' : ''}${offset} ms`, 2500);
  };
  register('spotifyLocal.showLyrics', () => vscode.commands.executeCommand(`${LyricsViewProvider.viewId}.focus`));
  register('spotifyLocal.toggleStatusBarLyrics', () => setShowLyricsInStatusBar(!getShowLyricsInStatusBar()));
  register('spotifyLocal.lyricsOffsetIncrease', () => changeLyricsOffset(LYRICS_OFFSET_STEP_MS));
  register('spotifyLocal.lyricsOffsetDecrease', () => changeLyricsOffset(-LYRICS_OFFSET_STEP_MS));

  let loggedIn = false;
  const render = (): void => statusBar.render(loggedIn, monitor.state);
  const renderLyric = (): void =>
    statusBar.renderLyric(loggedIn && getShowLyricsInStatusBar() ? lyrics.currentLine : undefined);
  context.subscriptions.push(
    monitor.onDidChange(render),
    lyrics.onDidChangeContent(renderLyric),
    lyrics.onDidChangeLine(renderLyric),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        // Un offset nuevo puede cambiar la línea actual sin esperar al siguiente recálculo.
        lyrics.refresh();
        renderLyric();
      }
    }),
    auth.onDidChangeSession((value) => {
      loggedIn = value;
      log.info(value ? 'Hay una sesión guardada.' : 'Sin sesión.');
      if (value) {
        monitor.start();
      } else {
        monitor.stop();
      }
      render();
      renderLyric();
      // Otra cuenta u otros permisos: lo cargado de la biblioteca deja de valer.
      library.clear();
      void libraryView.refreshAccess();
    }),
  );
  await auth.initialize();
}

export function deactivate(): void {}
