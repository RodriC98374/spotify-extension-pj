import * as vscode from 'vscode';
import type { AuthManager } from '../auth/authManager';

const API_BASE = 'https://api.spotify.com/v1';
const REQUEST_TIMEOUT_MS = 10_000;
/** Espera que se aplica si un 429 llega sin cabecera Retry-After. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Motivo que envían los endpoints del reproductor, por ejemplo `NO_ACTIVE_DEVICE`. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

export class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Spotify limitó las peticiones. Reintenta en ${Math.ceil(retryAfterMs / 1000)} s.`);
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/** Único punto de acceso a la Web API: autenticación, reintento ante 401 y respeto de los rate limits. */
export class SpotifyClient {
  private rateLimitedUntil = 0;

  constructor(
    private readonly auth: AuthManager,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  get<T>(path: string, query?: RequestOptions['query']): Promise<T | undefined> {
    return this.request<T>('GET', path, { query });
  }

  put<T>(path: string, options?: RequestOptions): Promise<T | undefined> {
    return this.request<T>('PUT', path, options);
  }

  post<T>(path: string, options?: RequestOptions): Promise<T | undefined> {
    return this.request<T>('POST', path, options);
  }

  /** Devuelve el JSON de la respuesta, o `undefined` si llegó sin cuerpo (204 y varios endpoints del reproductor). */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T | undefined> {
    const blockedFor = this.rateLimitedUntil - Date.now();
    if (blockedFor > 0) {
      throw new RateLimitError(blockedFor);
    }

    let token = await this.auth.getAccessToken();
    let res = await this.send(method, path, options, token);
    if (res.status === 401) {
      token = await this.auth.refreshAfterUnauthorized(token);
      res = await this.send(method, path, options, token);
    }
    this.log.debug(`${method} ${path} → ${res.status}`);

    if (res.status === 429) {
      const seconds = Number(res.headers.get('Retry-After'));
      const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
      this.rateLimitedUntil = Date.now() + retryAfterMs;
      throw new RateLimitError(retryAfterMs);
    }

    const text = await res.text();
    const body = parseJson(text);
    if (!res.ok) {
      throw new SpotifyApiError(
        res.status,
        body?.error?.message ?? `Spotify respondió ${res.status}.`,
        body?.error?.reason,
      );
    }
    return body;
  }

  private send(method: string, path: string, options: RequestOptions, token: string): Promise<Response> {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    return fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
}

/** Algunos endpoints del reproductor responden 200 con un cuerpo vacío o que no es JSON. */
function parseJson(text: string): any {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
