import { SpotifyApiError, SpotifyClient } from './client';
import type { Device, PlaybackState, Track } from './types';

export function isNoActiveDevice(err: unknown): boolean {
  return (
    err instanceof SpotifyApiError &&
    err.status === 404 &&
    (err.reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(err.message))
  );
}

/** Endpoints del reproductor. Con `deviceId` el comando va a ese dispositivo; sin él, al que esté activo. */
export class Player {
  constructor(private readonly client: SpotifyClient) {}

  /** `undefined` si no hay dispositivo activo ni reproducción: Spotify responde 204. */
  getPlayback(): Promise<PlaybackState | undefined> {
    return this.client.get<PlaybackState>('/me/player');
  }

  async getDevices(): Promise<Device[]> {
    return (await this.client.get<{ devices: Device[] }>('/me/player/devices'))?.devices ?? [];
  }

  /** Reanuda lo que estuviera sonando. */
  async play(deviceId?: string): Promise<void> {
    await this.client.put('/me/player/play', { query: { device_id: deviceId } });
  }

  /**
   * Reproduce una canción dentro de su álbum, para que al terminar sigan las pistas siguientes.
   * Una canción suelta (`uris`) se queda sin nada detrás y la reproducción se detiene al acabar.
   */
  async playTrack(track: Track, deviceId?: string): Promise<void> {
    const query = { device_id: deviceId };
    if (track.album.uri) {
      try {
        await this.client.put('/me/player/play', {
          query,
          body: { context_uri: track.album.uri, offset: { uri: track.uri } },
        });
        return;
      } catch (err) {
        // Si Spotify no acepta ese álbum como contexto, se reproduce la canción suelta.
        const contextRejected =
          err instanceof SpotifyApiError && (err.status === 400 || err.status === 404) && !isNoActiveDevice(err);
        if (!contextRejected) {
          throw err;
        }
      }
    }
    await this.client.put('/me/player/play', { query, body: { uris: [track.uri] } });
  }

  async pause(deviceId?: string): Promise<void> {
    await this.client.put('/me/player/pause', { query: { device_id: deviceId } });
  }

  async next(deviceId?: string): Promise<void> {
    await this.client.post('/me/player/next', { query: { device_id: deviceId } });
  }

  async previous(deviceId?: string): Promise<void> {
    await this.client.post('/me/player/previous', { query: { device_id: deviceId } });
  }

  async setVolume(percent: number, deviceId?: string): Promise<void> {
    await this.client.put('/me/player/volume', { query: { volume_percent: percent, device_id: deviceId } });
  }

  /** Con `play: false` el dispositivo de destino conserva el estado de reproducción actual. */
  async transfer(deviceId: string, play: boolean): Promise<void> {
    await this.client.put('/me/player', { body: { device_ids: [deviceId], play } });
  }
}
