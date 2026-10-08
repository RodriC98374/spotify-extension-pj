/** Respuesta de GET /me. En Development Mode ya no incluye `country`, `email`, `followers` ni `product`. */
export interface UserProfile {
  id: string;
  display_name: string | null;
}

export interface Device {
  id: string | null;
  name: string;
  /** Por ejemplo "Computer", "Smartphone" o "Speaker". */
  type: string;
  is_active: boolean;
  /** Si es true, el dispositivo no acepta comandos de la Web API. */
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume: boolean;
}

export interface Track {
  /** `null` en archivos locales. */
  id: string | null;
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  /** `uri` falta en archivos locales. */
  album: { name: string; uri?: string | null };
}

/** Respuesta de GET /me/player, limitada a los campos que usa la extensión. */
export interface PlaybackState {
  device: Device;
  is_playing: boolean;
  progress_ms: number | null;
  /** `null` durante anuncios y con contenido que no es una canción. */
  item: Track | null;
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown';
}
