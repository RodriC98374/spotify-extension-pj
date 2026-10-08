import * as vscode from 'vscode';
import { NotLoggedInError } from '../auth/errors';
import { describeError } from '../errors';
import { RateLimitError } from './client';
import type { Player } from './player';
import type { PlaybackState } from './types';

/** Intervalo con música sonando y la ventana enfocada. */
const ACTIVE_INTERVAL_MS = 3_000;
/** Intervalo sin foco, sin reproducción activa o tras un fallo. */
const IDLE_INTERVAL_MS = 30_000;

/** Consulta periódicamente GET /me/player y publica el estado de reproducción. */
export class PlaybackMonitor implements vscode.Disposable {
  private current: PlaybackState | undefined;
  private readAt = 0;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private timerDueAt = 0;
  private busy = false;
  private repeat = false;
  private readonly emitter = new vscode.EventEmitter<PlaybackState | undefined>();
  private readonly subscription: vscode.Disposable;

  /** Se dispara tras cada lectura. `undefined` significa que no hay dispositivo activo ni reproducción. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly player: Player,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subscription = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        this.refreshSoon(0);
      }
    });
  }

  get state(): PlaybackState | undefined {
    return this.current;
  }

  /**
   * Instante local al que corresponde el `progress_ms` de la última lectura real. No cambia con
   * `patch()`, así que sirve para distinguir una lectura de un cambio anticipado.
   */
  get lastReadAt(): number {
    return this.readAt;
  }

  start(): void {
    if (!this.running) {
      this.running = true;
      this.schedule(0);
    }
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.publish(undefined);
  }

  /** Adelanta la próxima lectura. Se usa tras un comando, cuando se sabe que el estado va a cambiar. */
  refreshSoon(delayMs: number): void {
    if (this.running) {
      this.schedule(delayMs);
    }
  }

  /** Aplica de inmediato un cambio que ya se sabe cierto, sin esperar a la próxima lectura. */
  patch(change: Partial<PlaybackState>): void {
    if (this.current) {
      this.publish({ ...this.current, ...change });
    }
  }

  dispose(): void {
    this.running = false;
    this.clearTimer();
    this.subscription.dispose();
    this.emitter.dispose();
  }

  private publish(state: PlaybackState | undefined): void {
    this.current = state;
    this.emitter.fire(state);
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    const dueAt = Date.now() + delayMs;
    // Una lectura ya programada para antes no se pospone.
    if (this.timer && this.timerDueAt <= dueAt) {
      return;
    }
    this.clearTimer();
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.busy) {
      // La lectura en curso puede ser anterior al cambio que motivó esta: se repite al terminar.
      this.repeat = true;
      return;
    }
    this.busy = true;
    let delay: number;
    try {
      const sentAt = Date.now();
      const state = await this.player.getPlayback();
      if (!this.running) {
        return;
      }
      // El progreso que informa Spotify corresponde, aproximadamente, a la mitad del viaje de la petición.
      this.readAt = (sentAt + Date.now()) / 2;
      this.publish(state);
      delay = vscode.window.state.focused && state?.is_playing ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    } catch (err) {
      if (err instanceof NotLoggedInError) {
        // El cambio de sesión que acompaña a este error detiene el monitor.
        return;
      }
      delay = err instanceof RateLimitError ? Math.max(err.retryAfterMs, IDLE_INTERVAL_MS) : IDLE_INTERVAL_MS;
      this.log.warn(`No se pudo leer el estado de reproducción: ${describeError(err)}`);
    } finally {
      this.busy = false;
    }
    if (!this.running) {
      return;
    }
    if (this.repeat) {
      this.repeat = false;
      delay = 0;
    }
    this.schedule(delay);
  }
}
