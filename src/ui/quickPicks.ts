import * as vscode from 'vscode';
import { NotLoggedInError } from '../auth/errors';
import { describeError } from '../errors';
import type { Device, Track } from '../spotify/types';

/** Dispositivo al que se le pueden enviar comandos: tiene id y no está restringido. */
export type ControllableDevice = Device & { id: string };

const VOLUME_LEVELS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
const SEARCH_DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 2;

type TrackItem = vscode.QuickPickItem & { track?: Track };

/**
 * QuickPick de búsqueda: llama a `search` mientras se escribe y se resuelve con la canción elegida,
 * o con `undefined` si se cierra sin elegir.
 */
export function pickTrack(search: (query: string) => Promise<Track[]>): Promise<Track | undefined> {
  return new Promise((resolve, reject) => {
    const quickPick = vscode.window.createQuickPick<TrackItem>();
    quickPick.placeholder = 'Busca una canción por título o artista';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    let timer: NodeJS.Timeout | undefined;
    // Cada búsqueda toma un número; solo la más reciente puede tocar la lista.
    let latest = 0;

    const runSearch = async (query: string): Promise<void> => {
      const ticket = ++latest;
      quickPick.busy = true;
      try {
        const tracks = await search(query);
        if (ticket === latest) {
          quickPick.items = tracks.length > 0 ? tracks.map(toTrackItem) : [messageItem('Sin resultados')];
        }
      } catch (err) {
        if (ticket !== latest) {
          return;
        }
        if (err instanceof NotLoggedInError) {
          reject(err);
          quickPick.hide();
          return;
        }
        quickPick.items = [messageItem(`$(warning) ${describeError(err)}`)];
      } finally {
        if (ticket === latest) {
          quickPick.busy = false;
        }
      }
    };

    quickPick.onDidChangeValue((value) => {
      clearTimeout(timer);
      const query = value.trim();
      if (query.length < MIN_QUERY_LENGTH) {
        latest++;
        quickPick.items = [];
        quickPick.busy = false;
        return;
      }
      timer = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    });
    quickPick.onDidAccept(() => {
      const track = quickPick.selectedItems[0]?.track;
      if (track) {
        resolve(track);
        quickPick.hide();
      }
    });
    quickPick.onDidHide(() => {
      clearTimeout(timer);
      latest++;
      resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });
}

function toTrackItem(track: Track): TrackItem {
  return {
    label: track.name,
    description: track.artists.map((artist) => artist.name).join(', '),
    detail: `${track.album.name} · ${formatDuration(track.duration_ms)}`,
    // Spotify ya filtró los resultados; sin esto el QuickPick ocultaría los que no contienen el texto escrito.
    alwaysShow: true,
    track,
  };
}

function messageItem(label: string): TrackItem {
  return { label, alwaysShow: true };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

export async function pickDevice(devices: ControllableDevice[]): Promise<ControllableDevice | undefined> {
  const items = devices.map((device) => ({
    label: `${deviceIcon(device.type)} ${device.name}`,
    description: device.is_active ? 'activo' : undefined,
    device,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Elige el dispositivo de Spotify' });
  return picked?.device;
}

/** QuickPick de niveles de volumen con el más cercano al actual preseleccionado. */
export function pickVolume(current: number | null): Promise<number | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { percent: number }>();
    quickPick.placeholder = current === null ? 'Volumen' : `Volumen actual: ${current}%`;
    quickPick.items = VOLUME_LEVELS.map((percent) => ({ label: `${percent}%`, percent }));
    if (current !== null) {
      const closest = quickPick.items.reduce((best, item) =>
        Math.abs(item.percent - current) < Math.abs(best.percent - current) ? item : best,
      );
      quickPick.activeItems = [closest];
    }
    quickPick.onDidAccept(() => {
      resolve(quickPick.selectedItems[0]?.percent);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });
}

function deviceIcon(type: string): string {
  switch (type.toLowerCase()) {
    case 'computer':
      return '$(device-desktop)';
    case 'smartphone':
    case 'tablet':
      return '$(device-mobile)';
    default:
      return '$(broadcast)';
  }
}
