import * as vscode from 'vscode';
import { Library, LibraryPlaylist, LibrarySource, sourceName, TrackList } from '../spotify/library';
import type { Track } from '../spotify/types';
import { TrackItem, trackItem } from './quickPicks';

export type LibraryChoice =
  | { kind: 'track'; source: LibrarySource; track: Track }
  | { kind: 'playlist'; playlist: LibraryPlaylist };

/** Tope de canciones que el QuickPick carga de una misma lista: 40 peticiones. */
const MAX_PICKER_TRACKS = 2000;
const BACK = Symbol('back');

/** QuickPick en dos pasos: primero la lista (Tus me gusta o una playlist) y después la canción. */
export async function pickFromLibrary(library: Library): Promise<LibraryChoice | undefined> {
  for (;;) {
    const source = await pickSource(library);
    if (!source) {
      return undefined;
    }
    if (source.kind === 'playlist' && !source.playlist.listable) {
      return { kind: 'playlist', playlist: source.playlist };
    }
    const track = await pickTrackFrom(library, source);
    if (track === BACK) {
      continue;
    }
    return track ? { kind: 'track', source, track } : undefined;
  }
}

async function pickSource(library: Library): Promise<LibrarySource | undefined> {
  // Las playlists se piden antes de abrir el selector: si falta sesión o permiso, el aviso sale sin abrirlo.
  const playlists = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Spotify: cargando tu biblioteca…' },
    () => library.getPlaylists(),
  );
  const items = [
    { label: '$(heart) Tus me gusta', description: undefined, source: { kind: 'liked' } as LibrarySource },
    ...playlists.map((playlist) => ({
      label: playlist.name,
      description: playlist.listable
        ? playlist.total === undefined
          ? undefined
          : `${playlist.total} canciones`
        : `de ${playlist.ownerName} · se reproduce entera`,
      source: { kind: 'playlist', playlist } as LibrarySource,
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Elige Tus me gusta o una playlist',
    matchOnDescription: true,
  });
  return picked?.source;
}

function pickTrackFrom(library: Library, source: LibrarySource): Promise<Track | typeof BACK | undefined> {
  return new Promise((resolve, reject) => {
    const quickPick = vscode.window.createQuickPick<TrackItem>();
    quickPick.title = sourceName(source);
    quickPick.placeholder = 'Escribe para filtrar por título, artista o álbum';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.buttons = [vscode.QuickInputButtons.Back];
    let open = true;

    const show = (list: TrackList): void => {
      // Al llegar una página nueva se conserva el elemento que el usuario tenía resaltado.
      const activeUri = quickPick.activeItems[0]?.track?.uri;
      quickPick.items = list.tracks.map((track) => trackItem(track, false));
      const active = activeUri ? quickPick.items.find((item) => item.track?.uri === activeUri) : undefined;
      if (active) {
        quickPick.activeItems = [active];
      }
      const loaded = list.complete ? `${list.tracks.length}` : `${list.tracks.length} de ${list.total}`;
      quickPick.title = `${sourceName(source)} · ${loaded} canciones`;
    };

    // Las páginas se cargan una tras otra mientras el selector siga abierto.
    const load = async (): Promise<void> => {
      quickPick.busy = true;
      try {
        let list = library.peek(source) ?? (await library.loadMore(source));
        while (open) {
          show(list);
          if (list.complete || list.tracks.length >= MAX_PICKER_TRACKS) {
            break;
          }
          list = await library.loadMore(source);
        }
      } catch (err) {
        if (open) {
          reject(err);
          quickPick.hide();
        }
      } finally {
        quickPick.busy = false;
      }
    };

    quickPick.onDidTriggerButton(() => {
      resolve(BACK);
      quickPick.hide();
    });
    quickPick.onDidAccept(() => {
      const track = quickPick.selectedItems[0]?.track;
      if (track) {
        resolve(track);
        quickPick.hide();
      }
    });
    quickPick.onDidHide(() => {
      open = false;
      resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
    void load();
  });
}
