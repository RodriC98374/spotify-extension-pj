import { SpotifyApiError, SpotifyClient } from './client';
import type { Device, PlaybackState, Track } from './types';

export function isNoActiveDevice(err: unknown): boolean {
  return (
    err instanceof SpotifyApiError &&
    err.status === 404 &&
    (err.reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(err.message))
  );
}

/**
 * 404 sin `reason`, con el mensaje "Not found.". Spotify no dice qué no encontró; en un comando del
 * reproductor suele ser el dispositivo, que figura como activo pero ya no recibe órdenes.
 */
export function isDeviceUnreachable(err: unknown): boolean {
  return err instanceof SpotifyApiError && err.status === 404 && !isNoActiveDevice(err);
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

  /** Reproduce un álbum o una playlist; con `trackUri` empieza en esa canción y sigue desde ahí. */
  async playContext(contextUri: string, trackUri?: string, deviceId?: string): Promise<void> {
    await this.client.put('/me/player/play', {
      query: { device_id: deviceId },
      body: { context_uri: contextUri, offset: trackUri ? { uri: trackUri } : undefined },
    });
  }

  /** Reproduce esas canciones en orden. Sin contexto detrás, la reproducción se detiene al acabar la lista. */
  async playUris(uris: string[], deviceId?: string): Promise<void> {
    // Sin `offset`, un reproductor con el modo aleatorio activado puede empezar por cualquiera de la lista.
    const offset = uris.length > 1 ? { position: 0 } : undefined;
    await this.client.put('/me/player/play', { query: { device_id: deviceId }, body: { uris, offset } });
  }

  /** Reproduce una canción dentro de su álbum, para que al terminar sigan las pistas siguientes. */
  async playTrack(track: Track, deviceId?: string): Promise<void> {
    if (track.album.uri) {
      try {
        await this.playContext(track.album.uri, track.uri, deviceId);
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
    await this.playUris([track.uri], deviceId);
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

  async setShuffle(shuffle: boolean, deviceId?: string): Promise<void> {
    await this.client.put('/me/player/shuffle', { query: { state: String(shuffle), device_id: deviceId } });
  }

  async setVolume(percent: number, deviceId?: string): Promise<void> {
    await this.client.put('/me/player/volume', { query: { volume_percent: percent, device_id: deviceId } });
  }

  /** Con `play: false` el dispositivo de destino conserva el estado de reproducción actual. */
  async transfer(deviceId: string, play: boolean): Promise<void> {
    await this.client.put('/me/player', { body: { device_ids: [deviceId], play } });
  }
}
