import * as vscode from 'vscode';
import type { Track } from '../spotify/types';
import { LyricLine, parseLrc } from './lrc';

const BASE_URL = 'https://lrclib.net/api';
const REQUEST_TIMEOUT_MS = 10_000;
/** Diferencia máxima de duración para fiarse de los tiempos de una letra sincronizada. */
const DURATION_TOLERANCE_S = 3;
const MAX_CACHE_ENTRIES = 200;
/** Cuánto se recuerda un resultado al que le faltó alguna consulta antes de volver a preguntar. */
const INCOMPLETE_TTL_MS = 5 * 60_000;
/** Espera antes de repetir una consulta a la que LRCLIB respondió "server is busy, please retry in a moment". */
const RETRY_WHEN_BUSY_MS = 1_500;
/** Proporción mínima de palabras en común para dar dos letras por la misma. */
const MIN_SHARED_WORDS = 0.6;

export type Lyrics =
  | { kind: 'synced'; lines: LyricLine[] }
  | { kind: 'plain'; lines: string[] }
  | { kind: 'instrumental' }
  /** `uncertain`: LRCLIB estaba saturado y alguna consulta quedó sin respuesta. */
  | { kind: 'missing'; uncertain: boolean };

interface LrclibRecord {
  trackName?: string;
  artistName?: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

interface Query {
  path: '/get' | '/search';
  params: Record<string, string>;
}

/** Letras de LRCLIB con caché en memoria por canción. */
export class LyricsSource {
  private readonly cache = new Map<string, { lyrics: Lyrics; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<Lyrics>>();

  constructor(
    private readonly userAgent: string,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Rechaza solo si no se pudo llegar a LRCLIB (red, timeout); ese fallo no se cachea. */
  get(track: Track): Promise<Lyrics> {
    const key = track.id ?? track.uri;
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.lyrics);
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.fetch(track)
        .then(({ lyrics, complete }) => {
          this.cache.delete(key);
          if (this.cache.size >= MAX_CACHE_ENTRIES) {
            this.cache.delete(this.cache.keys().next().value as string);
          }
          this.cache.set(key, { lyrics, expiresAt: complete ? Infinity : Date.now() + INCOMPLETE_TTL_MS });
          return lyrics;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  /**
   * Recorre las consultas de la más exacta a la más laxa y se queda con la primera letra sincronizada
   * que encaje en duración. Si no hay ninguna, devuelve el mejor texto sin tiempos que haya visto.
   * Las consultas a las que LRCLIB responde "saturado" se repiten una vez, al final y solo si hacen
   * falta. `complete` es false si aun así quedó alguna sin responder y el resultado podría mejorar.
   */
  private async fetch(track: Track): Promise<{ lyrics: Lyrics; complete: boolean }> {
    const durationS = Math.round(track.duration_ms / 1000);
    const title = normalize(track.name);
    const key = titleKey(track.name);
    const artists = track.artists.map((artist) => normalize(artist.name)).filter(Boolean);
    const distance = (record: LrclibRecord): number => Math.abs(record.duration - durationS);
    // Texto de una versión con el mismo título que la canción: delata a las que tienen otra letra.
    let reference: string[] | undefined;
    let fallback: { lyrics: Lyrics; rank: number; distance: number } | undefined;

    /** Devuelve la letra si la respuesta ya zanja la búsqueda; si no, anota lo aprovechable. */
    const consider = (query: Query, records: LrclibRecord[]): Lyrics | undefined => {
      const candidates = records
        .map((record) => {
          const recordTitle = normalize(record.trackName ?? '');
          const exact = recordTitle === title;
          // /get ya compara título y artista; /search es aproximada y trae también otras canciones.
          const sameSong =
            query.path === '/get' ||
            ((exact || titleKey(record.trackName ?? '') === key) && sharesArtist(record.artistName ?? '', artists));
          return sameSong ? { record, exact } : undefined;
        })
        .filter((candidate) => candidate !== undefined)
        .sort((a, b) => Number(b.exact) - Number(a.exact) || distance(a.record) - distance(b.record));

      for (const { record, exact } of candidates) {
        const close = distance(record) <= DURATION_TOLERANCE_S;
        if (record.instrumental) {
          // LRCLIB también tiene registros marcados como instrumentales por error: solo valen si no hay letra.
          if (exact && query.path === '/get' && !fallback) {
            return { kind: 'instrumental' };
          }
          if (close && !fallback) {
            fallback = { lyrics: { kind: 'instrumental' }, rank: 0, distance: distance(record) };
          }
          continue;
        }
        const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : [];
        const text = record.plainLyrics ? record.plainLyrics.split(/\r?\n/) : synced.map((line) => line.text);
        if (!text.some((line) => line.trim())) {
          continue;
        }
        // Otra versión de la canción, en otro idioma por ejemplo, puede durar lo mismo y decir otra cosa.
        if (!exact && reference && !sameWords(reference, text)) {
          continue;
        }
        if (close && synced.length > 0) {
          return { kind: 'synced', lines: synced };
        }
        if (exact) {
          reference ??= text;
        }
        // Sin tiempos fiables solo queda el texto: mejor el de la versión con el mismo título.
        const rank = exact ? 2 : 1;
        if (!fallback || rank > fallback.rank || (rank === fallback.rank && distance(record) < fallback.distance)) {
          fallback = { lyrics: { kind: 'plain', lines: text }, rank, distance: distance(record) };
        }
      }
      return undefined;
    };

    let queries = buildQueries(track, durationS);
    for (let round = 1; round <= 2 && queries.length > 0; round++) {
      if (round === 2) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_WHEN_BUSY_MS));
      }
      const busy: Query[] = [];
      for (const query of queries) {
        const records = await this.ask(query);
        const lyrics = records && consider(query, records);
        if (lyrics) {
          return { lyrics, complete: true };
        }
        if (!records) {
          busy.push(query);
        }
      }
      queries = busy;
    }
    const complete = queries.length === 0;
    return { lyrics: fallback?.lyrics ?? { kind: 'missing', uncertain: !complete }, complete };
  }

  /** Registros de la respuesta, ninguno si no hay coincidencia; `undefined` si LRCLIB está saturado. */
  private async ask({ path, params }: Query): Promise<LrclibRecord[] | undefined> {
    const res = await fetch(`${BASE_URL}${path}?${new URLSearchParams(params)}`, {
      headers: { 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const body: unknown = await res.json();
      return (Array.isArray(body) ? body : [body]) as LrclibRecord[];
    }
    if (res.status !== 429 && res.status < 500) {
      return [];
    }
    // Un 503 de LRCLIB es pasajero: la misma consulta suele responder bien un momento después.
    this.log.debug(`LRCLIB ${path} respondió ${res.status}.`);
    return undefined;
  }
}

/** Consultas para una canción, de la más exacta a la más laxa y sin repetidas. */
function buildQueries(track: Track, durationS: number): Query[] {
  const names = track.artists.map((artist) => artist.name).filter(Boolean);
  const first = names[0] ?? '';
  const simple = simplifyTitle(track.name);
  const get = (title: string, artist: string, album?: string): Query => ({
    path: '/get',
    params: { track_name: title, artist_name: artist, ...(album ? { album_name: album } : {}), duration: String(durationS) },
  });

  const queries = [
    get(track.name, first, track.album.name),
    // El álbum es un filtro estricto, y el nombre que le da Spotify (ediciones de lujo, remasterizaciones) a menudo no coincide.
    get(track.name, first),
    get(simple, first),
  ];
  if (names.length > 1) {
    // Las colaboraciones están unas veces con todos los artistas y otras solo con uno de ellos.
    queries.push(get(simple, names.join(', ')), get(simple, names[1]));
  }
  queries.push(
    { path: '/search', params: { track_name: simple, artist_name: first } },
    { path: '/search', params: { q: `${simple} ${first}`.trim() } },
  );

  const seen = new Set<string>();
  return queries.filter((query) => {
    const signature = `${query.path}?${new URLSearchParams(query.params)}`;
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

/** Minúsculas, sin tildes ni signos: "Tiësto & KAROL G" queda en "tiesto karol g". */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Una versión instrumental o de karaoke no comparte letra con la original: su título no se recorta. */
function keepsWholeTitle(title: string): boolean {
  return /\b(?:instrumental|karaoke)\b/i.test(title);
}

/** Quita los añadidos habituales de Spotify: "Canción - Remastered 2011", "Canción (feat. X)", "Canción (En Vivo)". */
function simplifyTitle(title: string): string {
  if (keepsWholeTitle(title)) {
    return title;
  }
  const simplified = title
    .replace(/\s+-\s+.*$/, '')
    .replace(/(?:\s*[([][^)\]]*[)\]])+$/, '')
    .trim();
  return simplified || title;
}

/** Clave para comparar títulos de versiones distintas de una misma canción. */
function titleKey(title: string): string {
  if (keepsWholeTitle(title)) {
    return normalize(title);
  }
  return normalize(title.replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+-\s+.*$/, '')) || normalize(title);
}

/** `artistName` de LRCLIB puede traer varios artistas juntos, o uno solo de los de la canción. */
function sharesArtist(artistName: string, artists: string[]): boolean {
  const candidate = ` ${normalize(artistName)} `;
  return candidate.trim() !== '' && artists.some((artist) => candidate.includes(` ${artist} `) || ` ${artist} `.includes(candidate));
}

function sameWords(a: string[], b: string[]): boolean {
  const words = (lines: string[]): Set<string> => new Set(normalize(lines.join(' ')).split(' ').filter(Boolean));
  const [small, large] = [words(a), words(b)].sort((x, y) => x.size - y.size);
  if (small.size === 0) {
    return true;
  }
  let shared = 0;
  for (const word of small) {
    if (large.has(word)) {
      shared++;
    }
  }
  return shared / small.size >= MIN_SHARED_WORDS;
}
