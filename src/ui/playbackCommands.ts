import * as vscode from 'vscode';
import { SpotifyApiError } from '../spotify/client';
import type { PlaybackMonitor } from '../spotify/playbackMonitor';
import { isNoActiveDevice, Player } from '../spotify/player';
import type { Device, Track } from '../spotify/types';
import { ControllableDevice, pickDevice, pickTrack, pickVolume } from './quickPicks';

const VOLUME_STEP = 10;
/** Spotify tarda un momento en reflejar un comando en GET /me/player. */
const REFRESH_AFTER_COMMAND_MS = 500;
/** Margen para que el dispositivo recién elegido quede activo antes de reintentar el comando. */
const SETTLE_AFTER_TRANSFER_MS = 700;

/** Handlers de los comandos de reproducción y búsqueda, indexados por id de comando. */
export function createPlaybackCommands(
  player: Player,
  monitor: PlaybackMonitor,
  search: (query: string) => Promise<Track[]>,
): Record<string, () => Promise<void>> {
  /** Lista los dispositivos, deja elegir uno y le transfiere la reproducción. */
  const transferToChosenDevice = async (): Promise<ControllableDevice | undefined> => {
    const devices = (await player.getDevices()).filter(
      (device): device is ControllableDevice => device.id !== null && !device.is_restricted,
    );
    if (devices.length === 0) {
      void vscode.window.showWarningMessage(
        'Spotify: no se encontró ningún dispositivo. Abre Spotify en tu celular o computador y vuelve a intentarlo.',
      );
      return undefined;
    }
    const device = await pickDevice(devices);
    if (!device) {
      return undefined;
    }
    await player.transfer(device.id, false);
    return device;
  };

  const offerTransfer = async (): Promise<ControllableDevice | undefined> => {
    const choice = await vscode.window.showWarningMessage(
      'Spotify: no hay ningún dispositivo activo.',
      'Elegir dispositivo',
    );
    if (!choice) {
      return undefined;
    }
    const device = await transferToChosenDevice();
    if (device) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_TRANSFER_MS));
    }
    return device;
  };

  /**
   * Ejecuta un comando del reproductor. Si falla por falta de dispositivo activo, ofrece transferir
   * la reproducción y lo reintenta apuntando al dispositivo elegido. Devuelve false si no se ejecutó.
   */
  const withDevice = async (action: (deviceId?: string) => Promise<void>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (err) {
      if (!isNoActiveDevice(err)) {
        throw err;
      }
    }
    const device = await offerTransfer();
    if (!device) {
      return false;
    }
    await action(device.id);
    return true;
  };

  /** El dispositivo activo o, si no hay ninguno, el que el usuario elija para transferir. */
  const activeDevice = async (): Promise<Device | undefined> => {
    return (await player.getPlayback())?.device ?? (await offerTransfer());
  };

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
    const device = await activeDevice();
    if (!device || volumeBlocked(device)) {
      return;
    }
    const target = Math.min(100, Math.max(0, (device.volume_percent ?? 50) + delta));
    await applyVolume(device, target);
  };

  const skip = async (action: (deviceId?: string) => Promise<void>): Promise<void> => {
    if (await withDevice(action)) {
      monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
    }
  };

  return {
    'spotifyLocal.playPause': async () => {
      const state = await player.getPlayback();
      if (state?.is_playing) {
        await player.pause();
        monitor.patch({ is_playing: false });
      } else if (await withDevice((deviceId) => player.play(deviceId))) {
        monitor.patch({ is_playing: true });
      }
      monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
    },
    'spotifyLocal.next': () => skip((deviceId) => player.next(deviceId)),
    'spotifyLocal.previous': () => skip((deviceId) => player.previous(deviceId)),
    'spotifyLocal.volumeUp': () => stepVolume(VOLUME_STEP),
    'spotifyLocal.volumeDown': () => stepVolume(-VOLUME_STEP),
    'spotifyLocal.setVolume': async () => {
      const device = await activeDevice();
      if (!device || volumeBlocked(device)) {
        return;
      }
      const percent = await pickVolume(device.volume_percent);
      if (percent !== undefined) {
        await applyVolume(device, percent);
      }
    },
    'spotifyLocal.transferPlayback': async () => {
      if (await transferToChosenDevice()) {
        monitor.refreshSoon(SETTLE_AFTER_TRANSFER_MS);
      }
    },
    'spotifyLocal.search': async () => {
      const track = await pickTrack(search);
      if (track && (await withDevice((deviceId) => player.playTrack(track, deviceId)))) {
        monitor.patch({ is_playing: true, item: track, progress_ms: 0 });
        monitor.refreshSoon(REFRESH_AFTER_COMMAND_MS);
      }
    },
  };
}
