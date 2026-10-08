import * as vscode from 'vscode';
import { describeError } from '../errors';
import type { PlaybackMonitor } from '../spotify/playbackMonitor';
import type { PlaybackState, Track } from '../spotify/types';
import type { LyricLine } from './lrc';
import type { Lyrics } from './lrclib';

/** Cada cuánto se recalcula la línea actual entre dos lecturas de Spotify. */
const TICK_MS = 200;
const MIN_TICK_MS = 20;
/** Una corrección pequeña del reloj no hace retroceder a la línea anterior. */
const BACKWARD_HYSTERESIS_MS = 400;
const RETRY_AFTER_ERROR_MS = 30_000;
/** Tras el final previsto de la canción se adelanta una lectura para detectar la siguiente. */
const END_OF_TRACK_MARGIN_MS = 400;
const END_OF_TRACK_GUARD_MS = 2_000;

export type LyricsContent =
  | { status: 'idle' }
  | { status: 'loading'; track: Track }
  | { status: 'synced'; track: Track; lines: LyricLine[] }
  | { status: 'plain'; track: Track; lines: string[] }
  | { status: 'instrumental'; track: Track }
  /** `uncertain`: LRCLIB falló en vez de decir claramente que no tiene la letra. */
  | { status: 'missing'; track: Track; uncertain: boolean }
  | { status: 'error'; track: Track; message: string };

/**
 * Sigue la reproducción a partir de las lecturas del monitor: carga la letra de cada canción y
 * calcula la línea actual interpolando la posición con un reloj local entre lectura y lectura.
 */
export class LyricsSync implements vscode.Disposable {
  private current: LyricsContent = { status: 'idle' };
  private index = -1;
  private trackKey: string | undefined;
  private durationMs = 0;
  private playing = false;
  // Posición conocida (`anchorProgress`) en un instante local (`anchorAt`); de ahí se interpola.
  private anchorProgress = 0;
  private anchorAt = 0;
  private seenReadAt = 0;
  private endRefreshRequested = false;
  private tickTimer: NodeJS.Timeout | undefined;
  private endTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly contentEmitter = new vscode.EventEmitter<LyricsContent>();
  private readonly lineEmitter = new vscode.EventEmitter<number>();
  private readonly subscription: vscode.Disposable;

  /** Cambia la canción o el estado de su letra. */
  readonly onDidChangeContent = this.contentEmitter.event;
  /** Cambia la línea actual; -1 si no hay ninguna. */
  readonly onDidChangeLine = this.lineEmitter.event;

  constructor(
    private readonly monitor: PlaybackMonitor,
    private readonly loadLyrics: (track: Track) => Promise<Lyrics>,
    private readonly getOffsetMs: () => number,
  ) {
    this.subscription = monitor.onDidChange((state) => this.onPlayback(state));
  }

  get content(): LyricsContent {
    return this.current;
  }

  get lineIndex(): number {
    return this.index;
  }

  /** Texto de la línea actual, o `undefined` si no hay letra sincronizada o suena una pausa instrumental. */
  get currentLine(): string | undefined {
    return (this.current.status === 'synced' && this.current.lines[this.index]?.text) || undefined;
  }

  /** Recalcula la línea ahora mismo; se usa cuando cambia el offset. */
  refresh(): void {
    // Un cambio de offset es deliberado: se aplica tal cual, aunque haga retroceder la línea.
    this.updateLine(false);
    this.scheduleTick();
  }

  dispose(): void {
    this.subscription.dispose();
    clearTimeout(this.tickTimer);
    clearTimeout(this.endTimer);
    clearTimeout(this.retryTimer);
    this.contentEmitter.dispose();
    this.lineEmitter.dispose();
  }

  private onPlayback(state: PlaybackState | undefined): void {
    const now = Date.now();
    // El monitor también publica cambios anticipados tras un comando; solo una lectura real trae posición fiable.
    const isRead = this.monitor.lastReadAt !== this.seenReadAt;
    this.seenReadAt = this.monitor.lastReadAt;
    const track = state?.item ?? undefined;
    const key = track ? (track.id ?? track.uri) : undefined;
    const playing = state?.is_playing ?? false;

    if (key !== this.trackKey) {
      this.trackKey = key;
      this.durationMs = track?.duration_ms ?? 0;
      this.endRefreshRequested = false;
      this.setAnchor(state?.progress_ms ?? 0, isRead ? this.seenReadAt : now);
      this.playing = playing;
      clearTimeout(this.retryTimer);
      if (track) {
        void this.load(track);
      } else {
        this.setContent({ status: 'idle' });
      }
    } else if (isRead) {
      // Cada lectura corrige el desfase acumulado y refleja pausas y saltos hechos desde otro dispositivo.
      if (state && state.progress_ms !== null) {
        this.setAnchor(state.progress_ms, this.seenReadAt);
      }
      this.playing = playing;
    } else if (playing !== this.playing) {
      // Play o pausa desde la propia extensión: el reloj se detiene o arranca donde iba.
      this.setAnchor(this.position(now), now);
      this.playing = playing;
    }

    this.updateLine();
    this.scheduleTick();
    this.scheduleEndRefresh();
  }

  private setAnchor(progressMs: number, at: number): void {
    this.anchorProgress = progressMs;
    this.anchorAt = at;
  }

  /** Posición estimada de la canción, sin el offset de la letra. */
  private position(now: number): number {
    const elapsed = this.playing ? now - this.anchorAt : 0;
    const position = Math.max(0, this.anchorProgress + elapsed);
    return this.durationMs > 0 ? Math.min(position, this.durationMs) : position;
  }

  private async load(track: Track): Promise<void> {
    const key = this.trackKey;
    this.setContent({ status: 'loading', track });
    let content: LyricsContent;
    try {
      const lyrics = await this.loadLyrics(track);
      switch (lyrics.kind) {
        case 'synced':
          content = { status: 'synced', track, lines: lyrics.lines };
          break;
        case 'plain':
          content = { status: 'plain', track, lines: lyrics.lines };
          break;
        case 'instrumental':
          content = { status: 'instrumental', track };
          break;
        case 'missing':
          content = { status: 'missing', track, uncertain: lyrics.uncertain };
          break;
      }
    } catch (err) {
      content = { status: 'error', track, message: describeError(err) };
    }
    if (key !== this.trackKey) {
      // Mientras se buscaba la letra empezó otra canción.
      return;
    }
    this.setContent(content);
    if (content.status === 'error') {
      this.retryTimer = setTimeout(() => void this.load(track), RETRY_AFTER_ERROR_MS);
    }
  }

  private setContent(content: LyricsContent): void {
    this.current = content;
    this.index = -1;
    this.contentEmitter.fire(content);
    this.updateLine();
    this.scheduleTick();
  }

  private updateLine(sticky = true): void {
    const index =
      this.current.status === 'synced'
        ? this.findLine(this.current.lines, this.position(Date.now()) + this.getOffsetMs(), sticky)
        : -1;
    if (index !== this.index) {
      this.index = index;
      this.lineEmitter.fire(index);
    }
  }

  /**
   * Índice de la última línea cuyo tiempo ya pasó; -1 antes de la primera. Con `sticky`, un retroceso
   * mínimo de la posición no devuelve a la línea anterior.
   */
  private findLine(lines: LyricLine[], positionMs: number, sticky: boolean): number {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lines[middle].timeMs <= positionMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const index = low - 1;
    if (sticky && index === this.index - 1 && positionMs > lines[this.index].timeMs - BACKWARD_HYSTERESIS_MS) {
      return this.index;
    }
    return index;
  }

  /** El siguiente recálculo cae justo en el cambio de línea si este llega antes que el intervalo normal. */
  private scheduleTick(): void {
    clearTimeout(this.tickTimer);
    if (!this.playing || this.current.status !== 'synced') {
      return;
    }
    const next = this.current.lines[this.index + 1];
    const untilNext = next ? next.timeMs - (this.position(Date.now()) + this.getOffsetMs()) : TICK_MS;
    this.tickTimer = setTimeout(
      () => {
        this.updateLine();
        this.scheduleTick();
      },
      Math.min(TICK_MS, Math.max(MIN_TICK_MS, untilNext)),
    );
  }

  /** Programa una lectura para cuando la canción deba terminar, una sola vez por reproducción. */
  private scheduleEndRefresh(): void {
    clearTimeout(this.endTimer);
    if (!this.playing || !this.trackKey || this.durationMs <= 0) {
      return;
    }
    const remaining = this.durationMs - this.position(Date.now());
    if (remaining > END_OF_TRACK_GUARD_MS) {
      this.endRefreshRequested = false;
    }
    if (this.endRefreshRequested) {
      return;
    }
    this.endTimer = setTimeout(() => {
      this.endRefreshRequested = true;
      this.monitor.refreshSoon(0);
    }, remaining + END_OF_TRACK_MARGIN_MS);
  }
}
