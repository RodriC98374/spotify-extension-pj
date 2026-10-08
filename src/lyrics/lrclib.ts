import * as vscode from 'vscode';
import type { Track } from '../spotify/types';
import { LyricLine, parseLrc } from './lrc';

const BASE_URL = 'https://lrclib.net/api';
const REQUEST_TIMEOUT_MS = 10_000;
/** Diferencia máxima de duración para fiarse de los tiempos de una letra sincronizada. */
const DURATION_TOLERANCE_S = 3;
const MAX_CACHE_ENTRIES = 200;
/** Cuánto se recuerda un "no encontrada" dudoso antes de volver a preguntar. */
const UNCERTAIN_MISS_TTL_MS = 5 * 60_000;

export type Lyrics =
  | { kind: 'synced'; lines: LyricLine[] }
  | { kind: 'plain'; lines: string[] }
  | { kind: 'instrumental' }
  /** `uncertain`: LRCLIB respondió con un error en vez de un "no existe" claro. */
  | { kind: 'missing'; uncertain: boolean };

interface LrclibRecord {
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
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
        .then((lyrics) => {
          this.cache.delete(key);
          if (this.cache.size >= MAX_CACHE_ENTRIES) {
            this.cache.delete(this.cache.keys().next().value as string);
          }
          const uncertain = lyrics.kind === 'missing' && lyrics.uncertain;
          this.cache.set(key, { lyrics, expiresAt: uncertain ? Date.now() + UNCERTAIN_MISS_TTL_MS : Infinity });
          return lyrics;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  private async fetch(track: Track): Promise<Lyrics> {
    const artist = track.artists[0]?.name ?? '';
    const durationS = Math.round(track.duration_ms / 1000);
    let uncertain = false;

    /** `undefined` si LRCLIB no devuelve datos para esa consulta. */
    const ask = async <T>(path: string, params: Record<string, string>): Promise<T | undefined> => {
      const res = await fetch(`${BASE_URL}${path}?${new URLSearchParams(params)}`, {
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        return (await res.json()) as T;
      }
      // Para una canción que no conoce, LRCLIB responde unas veces 404 y otras 503: un 5xx no
      // distingue "no existe" de "servicio caído", así que cuenta como ausencia dudosa.
      if (res.status !== 404) {
        uncertain = true;
        this.log.debug(`LRCLIB ${path} respondió ${res.status} para «${params.track_name}».`);
      }
      return undefined;
    };

    const exact = await ask<LrclibRecord>('/get', {
      track_name: track.name,
      artist_name: artist,
      album_name: track.album.name,
      duration: String(durationS),
    });
    const exactLyrics = exact && toLyrics(exact, true);
    if (exactLyrics) {
      return exactLyrics;
    }

    // /get exige coincidencia exacta; /search tolera diferencias de título, álbum y duración.
    for (const title of new Set([track.name, simplifyTitle(track.name)])) {
      const results = (await ask<LrclibRecord[]>('/search', { track_name: title, artist_name: artist })) ?? [];
      const lyrics = pickBest(results, durationS);
      if (lyrics) {
        return lyrics;
      }
    }
    return { kind: 'missing', uncertain };
  }
}

function pickBest(results: LrclibRecord[], durationS: number): Lyrics | undefined {
  const distance = (record: LrclibRecord): number => Math.abs(record.duration - durationS);
  const ranked = [...results].sort((a, b) => distance(a) - distance(b));
  const close = ranked.filter((record) => distance(record) <= DURATION_TOLERANCE_S);
  for (const record of [...close.filter((r) => r.syncedLyrics), ...close]) {
    const lyrics = toLyrics(record, true);
    if (lyrics) {
      return lyrics;
    }
  }
  // Ninguna versión coincide en duración: sus tiempos no sirven, pero el texto suele ser el mismo.
  for (const record of ranked.filter((r) => !r.instrumental)) {
    const lyrics = toLyrics(record, false);
    if (lyrics) {
      return lyrics;
    }
  }
  return undefined;
}

/** `undefined` si el registro no trae ninguna letra utilizable. */
function toLyrics(record: LrclibRecord, trustTiming: boolean): Lyrics | undefined {
  if (record.instrumental) {
    return { kind: 'instrumental' };
  }
  const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : [];
  if (trustTiming && synced.length > 0) {
    return { kind: 'synced', lines: synced };
  }
  const lines = record.plainLyrics ? record.plainLyrics.split(/\r?\n/) : synced.map((line) => line.text);
  return lines.some((line) => line.trim()) ? { kind: 'plain', lines } : undefined;
}

/** Quita los añadidos habituales de Spotify: "Canción - Remastered 2011", "Canción (feat. X)". */
function simplifyTitle(title: string): string {
  const simplified = title
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s*[([](?:feat|ft|with|con)\b[^)\]]*[)\]]/gi, '')
    .trim();
  return simplified || title;
}
