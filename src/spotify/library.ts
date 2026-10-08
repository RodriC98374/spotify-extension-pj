import * as vscode from 'vscode';
import { AuthManager, LIBRARY_SCOPES } from '../auth/authManager';
import { MissingScopeError, NotLoggedInError } from '../auth/errors';
import { SpotifyApiError, SpotifyClient } from './client';
import type { Track, UserProfile } from './types';

/** Máximo que admiten los listados de playlists y canciones. */
const PAGE_SIZE = 50;
const MAX_PLAYLIST_PAGES = 10;

interface Paging<T> {
  items: T[];
  total: number;
  next: string | null;
}

/** Playlist tal como la devuelve GET /me/playlists. `tracks` es el nombre antiguo de `items`. */
interface PlaylistObject {
  id: string;
  name: string;
  uri: string;
  collaborative: boolean;
  owner: { id: string; display_name: string | null };
  items?: { total: number } | null;
  tracks?: { total: number } | null;
}

/** Elemento de GET /playlists/{id}/items. `track` es el nombre antiguo de `item`. */
interface PlaylistEntry {
  is_local: boolean;
  item?: Track | null;
  track?: Track | null;
}

export interface LibraryPlaylist {
  id: string;
  name: string;
  uri: string;
  ownerName: string;
  total: number | undefined;
  /** Spotify solo deja ver las canciones de las playlists propias o colaborativas; las demás se reproducen enteras. */
  listable: boolean;
}

export type LibrarySource = { kind: 'liked' } | { kind: 'playlist'; playlist: LibraryPlaylist };

export interface TrackList {
  tracks: Track[];
  /** Total que informa Spotify; puede superar a las canciones reproducibles. */
  total: number;
  complete: boolean;
}

export function sourceKey(source: LibrarySource): string {
  return source.kind === 'liked' ? 'liked' : `playlist:${source.playlist.id}`;
}

export function sourceName(source: LibrarySource): string {
  return source.kind === 'liked' ? 'Tus me gusta' : source.playlist.name;
}

/**
 * Playlists y canciones guardadas del usuario, con caché en memoria. Las listas se cargan por
 * páginas; el árbol y el QuickPick comparten esta misma caché.
 */
export class Library implements vscode.Disposable {
  private playlists: Promise<LibraryPlaylist[]> | undefined;
  private readonly lists = new Map<string, TrackList & { nextOffset: number }>();
  private readonly loading = new Map<string, Promise<TrackList>>();
  // Cambia con cada `clear()` para descartar las respuestas que lleguen después.
  private generation = 0;
  private readonly emitter = new vscode.EventEmitter<LibrarySource | undefined>();

  /** Se dispara al crecer la lista de una fuente, o con `undefined` cuando se vacía toda la caché. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly client: SpotifyClient,
    private readonly auth: AuthManager,
  ) {}

  getPlaylists(): Promise<LibraryPlaylist[]> {
    if (!this.playlists) {
      const request = this.fetchPlaylists();
      this.playlists = request;
      request.catch(() => {
        // Un fallo no se cachea: el siguiente intento vuelve a pedir.
        if (this.playlists === request) {
          this.playlists = undefined;
        }
      });
    }
    return this.playlists;
  }

  /** Lo ya cargado de una fuente, sin pedir nada. */
  peek(source: LibrarySource): TrackList | undefined {
    return this.lists.get(sourceKey(source));
  }

  /** Carga la página siguiente de una fuente; las llamadas simultáneas comparten la misma petición. */
  loadMore(source: LibrarySource): Promise<TrackList> {
    const key = sourceKey(source);
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.fetchNextPage(source, key).finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  /** Olvida todo lo cargado, por ejemplo al cambiar de cuenta o al pedir una actualización. */
  clear(): void {
    this.generation++;
    this.playlists = undefined;
    this.lists.clear();
    this.loading.clear();
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private async requireAccess(): Promise<void> {
    if (!(await this.auth.isLoggedIn())) {
      throw new NotLoggedInError();
    }
    if (!(await this.auth.hasScopes(LIBRARY_SCOPES))) {
      throw new MissingScopeError();
    }
  }

  private async fetchPlaylists(): Promise<LibraryPlaylist[]> {
    await this.requireAccess();
    const userId = (await this.client.get<UserProfile>('/me'))?.id;
    const playlists: LibraryPlaylist[] = [];
    for (let page = 0; page < MAX_PLAYLIST_PAGES; page++) {
      const result = await this.client.get<Paging<PlaylistObject | null>>('/me/playlists', {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      for (const playlist of result?.items ?? []) {
        if (playlist) {
          playlists.push({
            id: playlist.id,
            name: playlist.name,
            uri: playlist.uri,
            ownerName: playlist.owner.display_name ?? playlist.owner.id,
            total: (playlist.items ?? playlist.tracks)?.total,
            listable: playlist.collaborative || playlist.owner.id === userId,
          });
        }
      }
      if (!result?.next) {
        break;
      }
    }
    return playlists;
  }

  private async fetchNextPage(source: LibrarySource, key: string): Promise<TrackList> {
    const generation = this.generation;
    const state = this.lists.get(key) ?? { tracks: [], total: 0, complete: false, nextOffset: 0 };
    if (state.complete) {
      return state;
    }
    await this.requireAccess();
    const query = { limit: PAGE_SIZE, offset: state.nextOffset };
    let page: Paging<unknown> | undefined;
    let candidates: (Track | null | undefined)[];
    if (source.kind === 'liked') {
      const result = await this.client.get<Paging<{ track: Track | null }>>('/me/tracks', query);
      page = result;
      candidates = (result?.items ?? []).map((entry) => entry.track);
    } else {
      const result = await this.getPlaylistItems(source.playlist.id, query);
      page = result;
      candidates = (result?.items ?? []).filter((entry) => !entry.is_local).map((entry) => entry.item ?? entry.track);
    }
    // Fuera pódcast y archivos locales: no se pueden reproducir como una canción normal.
    const tracks = candidates.filter(
      (track): track is Track => !!track && (track.type ?? 'track') === 'track' && !!track.uri,
    );
    const next = {
      tracks: [...state.tracks, ...tracks],
      total: page?.total ?? state.total,
      complete: !page?.next || page.items.length === 0,
      nextOffset: state.nextOffset + PAGE_SIZE,
    };
    if (generation === this.generation) {
      this.lists.set(key, next);
      this.emitter.fire(source);
    }
    return next;
  }

  private async getPlaylistItems(
    playlistId: string,
    query: { limit: number; offset: number },
  ): Promise<Paging<PlaylistEntry> | undefined> {
    try {
      return await this.client.get<Paging<PlaylistEntry>>(`/playlists/${playlistId}/items`, query);
    } catch (err) {
      if (err instanceof SpotifyApiError && err.status === 403) {
        throw new Error('Spotify no permite ver las canciones de esta playlist; solo se puede reproducir entera.');
      }
      throw err;
    }
  }
}
