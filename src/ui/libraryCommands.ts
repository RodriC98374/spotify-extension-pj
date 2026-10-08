import * as vscode from 'vscode';
import type { Library, LibraryPlaylist, LibrarySource } from '../spotify/library';
import { PlaybackMonitor, REFRESH_AFTER_COMMAND_MS } from '../spotify/playbackMonitor';
import type { Player } from '../spotify/player';
import type { Track } from '../spotify/types';
import type { DeviceGuard } from './deviceGuard';
import { pickFromLibrary } from './libraryPicker';
import { LibraryTreeProvider, LOAD_MORE_LIBRARY, PLAY_LIBRARY_PLAYLIST, PLAY_LIBRARY_TRACK } from './libraryView';

/** Canciones de "Tus me gusta" que se envían de una vez: la elegida y las que le siguen. */
const MAX_LIKED_URIS = 100;

/** Handlers de los comandos de la biblioteca, incluidos los internos que usa el árbol. */
export function createLibraryCommands(
  library: Library,
  player: Player,
  guard: DeviceGuard,
  monitor: PlaybackMonitor,
): Record<string, (...args: any[]) => Promise<unknown>> {
  const playTrack = async (source: LibrarySource, track: Track): Promise<void> => {
    let action: (deviceId?: string) => Promise<void>;
    if (source.kind === 'playlist') {
      // Dentro de la playlist, para que al terminar sigan sus canciones.
      action = (deviceId) => player.playContext(source.playlist.uri, track.uri, deviceId);
    } else {
      // "Tus me gusta" no existe como contexto en la API: se envían la canción elegida y las siguientes.
      const tracks = library.peek(source)?.tracks ?? [];
      const index = tracks.findIndex((candidate) => candidate.uri === track.uri);
      const queue = index < 0 ? [track] : tracks.slice(index, index + MAX_LIKED_URIS);
      const uris = queue.map((candidate) => candidate.uri);
      action = (deviceId) => player.playUris(uris, deviceId);
    }
    if (await guard.run(action)) {
      monitor.patch({ is_playing: true, item: track, progress_ms: 0 });
      monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
    }
  };

  const playPlaylist = async (playlist: LibraryPlaylist): Promise<void> => {
    if (await guard.run((deviceId) => player.playContext(playlist.uri, undefined, deviceId))) {
      monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
    }
  };

  return {
    'spotifyLocal.showLibrary': async () => vscode.commands.executeCommand(`${LibraryTreeProvider.viewId}.focus`),
    'spotifyLocal.refreshLibrary': async () => library.clear(),
    'spotifyLocal.pickFromLibrary': async () => {
      const choice = await pickFromLibrary(library);
      if (choice?.kind === 'track') {
        await playTrack(choice.source, choice.track);
      } else if (choice?.kind === 'playlist') {
        await playPlaylist(choice.playlist);
      }
    },
    [PLAY_LIBRARY_TRACK]: playTrack,
    [PLAY_LIBRARY_PLAYLIST]: playPlaylist,
    [LOAD_MORE_LIBRARY]: (source: LibrarySource) => library.loadMore(source),
  };
}
