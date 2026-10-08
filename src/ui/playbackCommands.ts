import * as vscode from 'vscode';
import { SpotifyApiError } from '../spotify/client';
import { PlaybackMonitor, REFRESH_AFTER_COMMAND_MS } from '../spotify/playbackMonitor';
import type { Player } from '../spotify/player';
import type { Device, Track } from '../spotify/types';
import { DeviceGuard, SETTLE_AFTER_TRANSFER_MS } from './deviceGuard';
import { pickTrack, pickVolume } from './quickPicks';

const VOLUME_STEP = 10;

/** Handlers de los comandos de reproducción y búsqueda, indexados por id de comando. */
export function createPlaybackCommands(
  player: Player,
  monitor: PlaybackMonitor,
  guard: DeviceGuard,
  search: (query: string) => Promise<Track[]>,
): Record<string, () => Promise<void>> {
  /** Dispositivos a los que Spotify ya les rechazó un cambio de volumen en esta sesión. */
  const volumeRejected = new Set<string>();
  const deviceKey = (device: Device): string => device.id ?? device.name;

  /**
   * `supports_volume: false` no impide intentarlo: se prueba una vez por sesión y solo se deja
   * de insistir cuando Spotify lo rechaza de verdad.
   */
  const volumeBlocked = (device: Device): boolean => {
    const blocked = !device.supports_volume && volumeRejected.has(deviceKey(device));
    if (blocked) {
      void vscode.window.showWarningMessage(
        `Spotify: «${device.name}» no permite cambiar el volumen por API. Usa los controles del dispositivo.`,
      );
    }
    return blocked;
  };

  const applyVolume = async (device: Device, percent: number): Promise<void> => {
    try {
      await player.setVolume(percent, device.id ?? undefined);
    } catch (err) {
      if (err instanceof SpotifyApiError && err.status === 403) {
        volumeRejected.add(deviceKey(device));
        void vscode.window.showWarningMessage(
          `Spotify rechazó el cambio de volumen en «${device.name}» (${err.message}). Usa los controles del dispositivo.`,
        );
        return;
      }
      throw err;
    }
    // Si el dispositivo indica que no admite volumen, no se anticipa el cambio: se muestra lo que informe Spotify.
    const state = monitor.state;
    if (state && device.supports_volume) {
      monitor.patch({ device: { ...state.device, volume_percent: percent } });
    }
    monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
  };

  const stepVolume = async (delta: number): Promise<void> => {
    const device = await guard.activeDevice();
    if (!device || volumeBlocked(device)) {
      return;
    }
    const target = Math.min(100, Math.max(0, (device.volume_percent ?? 50) + delta));
    await applyVolume(device, target);
  };

  const skip = async (action: (deviceId?: string) => Promise<void>): Promise<void> => {
    if (await guard.run(action)) {
      monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
    }
  };

  return {
    'spotifyLocal.playPause': async () => {
      const state = await player.getPlayback();
      if (state?.is_playing) {
        if (await guard.run((deviceId) => player.pause(deviceId))) {
          monitor.patch({ is_playing: false });
        }
      } else if (await guard.run((deviceId) => player.play(deviceId))) {
        monitor.patch({ is_playing: true });
      }
      monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
    },
    'spotifyLocal.next': () => skip((deviceId) => player.next(deviceId)),
    'spotifyLocal.previous': () => skip((deviceId) => player.previous(deviceId)),
    'spotifyLocal.toggleShuffle': async () => {
      const shuffle = !(await player.getPlayback())?.shuffle_state;
      if (await guard.run((deviceId) => player.setShuffle(shuffle, deviceId))) {
        monitor.patch({ shuffle_state: shuffle });
        monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
      }
    },
    'spotifyLocal.volumeUp': () => stepVolume(VOLUME_STEP),
    'spotifyLocal.volumeDown': () => stepVolume(-VOLUME_STEP),
    'spotifyLocal.setVolume': async () => {
      const device = await guard.activeDevice();
      if (!device || volumeBlocked(device)) {
        return;
      }
      const percent = await pickVolume(device.volume_percent);
      if (percent !== undefined) {
        await applyVolume(device, percent);
      }
    },
    'spotifyLocal.transferPlayback': async () => {
      if (await guard.transferToChosenDevice()) {
        monitor.refreshSoon(SETTLE_AFTER_TRANSFER_MS);
      }
    },
    'spotifyLocal.search': async () => {
      const track = await pickTrack(search);
      if (track && (await guard.run((deviceId) => player.playTrack(track, deviceId)))) {
        monitor.patch({ is_playing: true, item: track, progress_ms: 0 });
        monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
      }
    },
  };
}
