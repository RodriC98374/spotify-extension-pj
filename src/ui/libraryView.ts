import * as vscode from 'vscode';
import { AuthManager, LIBRARY_SCOPES } from '../auth/authManager';
import { describeError } from '../errors';
import { Library, LibrarySource, sourceKey, sourceName } from '../spotify/library';
import type { Track } from '../spotify/types';

/** Comandos internos que disparan los elementos del árbol; no aparecen en la paleta. */
export const PLAY_LIBRARY_TRACK = 'spotifyLocal.internal.playLibraryTrack';
export const PLAY_LIBRARY_PLAYLIST = 'spotifyLocal.internal.playLibraryPlaylist';
export const LOAD_MORE_LIBRARY = 'spotifyLocal.internal.loadMoreLibrary';

type Node =
  | { kind: 'source'; source: LibrarySource }
  | { kind: 'track'; source: LibrarySource; track: Track; index: number }
  | { kind: 'more'; source: LibrarySource }
  | { kind: 'message'; text: string };

type Access = 'loggedOut' | 'needsPermission' | 'ready';

/**
 * Árbol "Biblioteca": Tus me gusta y las playlists, con sus canciones. Sin sesión o sin permiso el
 * árbol queda vacío y VS Code muestra el mensaje de bienvenida que declara package.json.
 */
export class LibraryTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  static readonly viewId = 'spotifyLocal.library';

  private access: Access = 'loggedOut';
  // Los nodos de primer nivel se conservan para poder refrescar solo la rama que cambia.
  private readonly sourceNodes = new Map<string, Node>();
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly library: Library,
    private readonly auth: AuthManager,
  ) {
    this.subscription = library.onDidChange((source) => {
      this.emitter.fire(source ? this.sourceNodes.get(sourceKey(source)) : undefined);
    });
  }

  /** Recalcula si hay sesión y permiso de biblioteca; hay que llamarlo cuando cambia la sesión. */
  async refreshAccess(): Promise<void> {
    this.access = !(await this.auth.isLoggedIn())
      ? 'loggedOut'
      : (await this.auth.hasScopes(LIBRARY_SCOPES))
        ? 'ready'
        : 'needsPermission';
    await vscode.commands.executeCommand('setContext', 'spotifyLocal.library', this.access);
    this.emitter.fire(undefined);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    try {
      if (!node) {
        return await this.getSources();
      }
      if (node.kind !== 'source') {
        return [];
      }
      const { source } = node;
      const list = this.library.peek(source) ?? (await this.library.loadMore(source));
      const tracks: Node[] = list.tracks.map((track, index) => ({ kind: 'track', source, track, index }));
      if (tracks.length === 0 && list.complete) {
        return [{ kind: 'message', text: 'No hay canciones.' }];
      }
      return list.complete ? tracks : [...tracks, { kind: 'more', source }];
    } catch (err) {
      return [{ kind: 'message', text: describeError(err) }];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'source':
        return this.sourceItem(node.source);
      case 'track': {
        const item = new vscode.TreeItem(node.track.name);
        item.id = `${sourceKey(node.source)}/${node.index}/${node.track.uri}`;
        item.description = node.track.artists.map((artist) => artist.name).join(', ');
        item.tooltip = `${node.track.name}\n${item.description} · ${node.track.album.name}`;
        item.command = { command: PLAY_LIBRARY_TRACK, title: 'Reproducir', arguments: [node.source, node.track] };
        return item;
      }
      case 'more': {
        const item = new vscode.TreeItem('Cargar más…');
        item.id = `${sourceKey(node.source)}/more`;
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.command = { command: LOAD_MORE_LIBRARY, title: 'Cargar más', arguments: [node.source] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info');
        item.tooltip = node.text;
        return item;
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  private async getSources(): Promise<Node[]> {
    this.sourceNodes.clear();
    if (this.access !== 'ready') {
      return [];
    }
    const sources: LibrarySource[] = [
      { kind: 'liked' },
      ...(await this.library.getPlaylists()).map((playlist): LibrarySource => ({ kind: 'playlist', playlist })),
    ];
    return sources.map((source) => {
      const node: Node = { kind: 'source', source };
      this.sourceNodes.set(sourceKey(source), node);
      return node;
    });
  }

  private sourceItem(source: LibrarySource): vscode.TreeItem {
    const listable = source.kind === 'liked' || source.playlist.listable;
    const item = new vscode.TreeItem(
      sourceName(source),
      listable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = sourceKey(source);
    if (source.kind === 'liked') {
      item.iconPath = new vscode.ThemeIcon('heart');
      const total = this.library.peek(source)?.total;
      item.description = total === undefined ? undefined : countLabel(total);
      return item;
    }
    const { playlist } = source;
    if (listable) {
      item.iconPath = new vscode.ThemeIcon('list-unordered');
      item.description = playlist.total === undefined ? undefined : countLabel(playlist.total);
    } else {
      // Spotify no deja ver las canciones de una playlist ajena: el clic la reproduce entera.
      item.iconPath = new vscode.ThemeIcon('play');
      item.description = `de ${playlist.ownerName}`;
      item.tooltip = `${playlist.name}\nSpotify no permite ver las canciones de una playlist ajena. Haz clic para reproducirla entera.`;
      item.command = { command: PLAY_LIBRARY_PLAYLIST, title: 'Reproducir playlist', arguments: [playlist] };
    }
    return item;
  }
}

function countLabel(total: number): string {
  return total === 1 ? '1 canción' : `${total} canciones`;
}
