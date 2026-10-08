import * as vscode from 'vscode';
import { getClientId } from '../config';
import { CallbackListener, REDIRECT_URI, startCallbackListener } from './callbackServer';
import { AuthError, MissingClientIdError, NotLoggedInError, SessionExpiredError } from './errors';
import { createPkcePair, createState } from './pkce';
import { StoredTokens, TokenStore } from './tokenStore';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing'];

/** El access token se renueva cuando le queda menos de este margen. */
const EXPIRY_MARGIN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
/** Espera antes de releer el almacén tras un `invalid_grant`, por si otra ventana está guardando tokens nuevos. */
const ROTATION_GRACE_MS = 1_500;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  refresh_token?: string;
}

class TokenEndpointError extends AuthError {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    description: string | undefined,
  ) {
    super(`Spotify rechazó la solicitud de token (${[status, code].filter(Boolean).join(' ')})${description ? `: ${description}` : '.'}`);
  }
}

export class AuthManager implements vscode.Disposable {
  private refreshing: Promise<StoredTokens> | undefined;
  private loginInProgress = false;
  private loggedIn: boolean | undefined;
  private readonly sessionEmitter = new vscode.EventEmitter<boolean>();
  private readonly subscription: vscode.Disposable;

  /** Se dispara con `true` al iniciar sesión y con `false` al cerrarla o perderla, también desde otra ventana. */
  readonly onDidChangeSession = this.sessionEmitter.event;

  constructor(
    private readonly store: TokenStore,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subscription = store.onDidChange(() => void this.syncSession());
  }

  /** Carga el estado inicial de la sesión y lo anuncia por `onDidChangeSession`. */
  initialize(): Promise<void> {
    return this.syncSession();
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.store.get()) !== undefined;
  }

  async login(): Promise<void> {
    const clientId = getClientId();
    if (!clientId) {
      throw new MissingClientIdError();
    }
    if (this.loginInProgress) {
      throw new AuthError('Ya hay un inicio de sesión en curso. Complétalo en el navegador o cancélalo.');
    }
    this.loginInProgress = true;
    try {
      const { verifier, challenge } = createPkcePair();
      const state = createState();
      const listener = await startCallbackListener(state);
      try {
        const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          scope: SCOPES.join(' '),
          state,
        })}`;
        const code = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Spotify: esperando la autorización en el navegador…',
            cancellable: true,
          },
          async (_progress, cancellation) => {
            cancellation.onCancellationRequested(() => listener.cancel());
            if (!(await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl)))) {
              // VS Code devuelve false si se descarta su diálogo de confirmación o se elige "Copiar".
              // El servidor sigue escuchando para que la URL pueda abrirse a mano.
              void offerAuthorizeUrl(authorizeUrl, listener);
            }
            return listener.code;
          },
        );
        const response = await requestToken({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
        });
        if (!response.refresh_token) {
          throw new AuthError('Spotify no devolvió un refresh token.');
        }
        await this.store.set(toStoredTokens(response, response.refresh_token));
        this.log.info('Sesión iniciada.');
      } finally {
        listener.cancel();
      }
    } finally {
      this.loginInProgress = false;
    }
  }

  async logout(): Promise<void> {
    await this.store.clear();
    this.log.info('Sesión cerrada.');
  }

  /** Devuelve un access token vigente, renovándolo antes si está por vencer. */
  async getAccessToken(): Promise<string> {
    const tokens = await this.store.get();
    if (!tokens) {
      throw new NotLoggedInError();
    }
    if (isFresh(tokens)) {
      return tokens.accessToken;
    }
    return (await this.refresh()).accessToken;
  }

  /** Para usar tras un 401: renueva salvo que el token rechazado ya haya sido reemplazado por otro flujo. */
  async refreshAfterUnauthorized(rejectedToken: string): Promise<string> {
    const tokens = await this.store.get();
    if (!tokens) {
      throw new NotLoggedInError();
    }
    if (tokens.accessToken !== rejectedToken && isFresh(tokens)) {
      return tokens.accessToken;
    }
    return (await this.refresh()).accessToken;
  }

  dispose(): void {
    this.subscription.dispose();
    this.sessionEmitter.dispose();
  }

  /** Las renovaciones concurrentes comparten una sola petición. */
  private refresh(): Promise<StoredTokens> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<StoredTokens> {
    const clientId = getClientId();
    if (!clientId) {
      throw new MissingClientIdError();
    }
    const current = await this.store.get();
    if (!current) {
      throw new NotLoggedInError();
    }
    let response: TokenResponse;
    try {
      response = await requestToken({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: clientId,
      });
    } catch (err) {
      if (!(err instanceof TokenEndpointError) || err.code !== 'invalid_grant') {
        throw err;
      }
      // Otra ventana pudo haber rotado el refresh token: se relee antes de dar la sesión por perdida.
      await new Promise((resolve) => setTimeout(resolve, ROTATION_GRACE_MS));
      const latest = await this.store.reload();
      if (latest && latest.refreshToken !== current.refreshToken) {
        return latest;
      }
      await this.store.clear();
      this.log.warn('El refresh token ya no es válido; se cerró la sesión.');
      throw new SessionExpiredError();
    }
    // La respuesta puede no traer refresh token; en ese caso sigue valiendo el anterior.
    const tokens = toStoredTokens(response, response.refresh_token ?? current.refreshToken);
    await this.store.set(tokens);
    this.log.info(`Token renovado; vence a las ${new Date(tokens.expiresAt).toLocaleTimeString()}.`);
    return tokens;
  }

  private async syncSession(): Promise<void> {
    const loggedIn = await this.isLoggedIn();
    if (loggedIn !== this.loggedIn) {
      this.loggedIn = loggedIn;
      this.sessionEmitter.fire(loggedIn);
    }
  }
}

async function offerAuthorizeUrl(url: string, listener: CallbackListener): Promise<void> {
  const copy = 'Copiar URL';
  const cancel = 'Cancelar inicio de sesión';
  const choice = await vscode.window.showWarningMessage(
    'Spotify: no se abrió el navegador. Abre la URL de autorización a mano para continuar.',
    copy,
    cancel,
  );
  if (choice === copy) {
    await vscode.env.clipboard.writeText(url);
  } else if (choice === cancel) {
    listener.cancel();
  }
}

function isFresh(tokens: StoredTokens): boolean {
  return Date.now() < tokens.expiresAt - EXPIRY_MARGIN_MS;
}

function toStoredTokens(response: TokenResponse, refreshToken: string): StoredTokens {
  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
    scope: response.scope ?? '',
  };
}

async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const body: any = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new TokenEndpointError(res.status, body?.error, body?.error_description);
  }
  if (typeof body?.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new AuthError('Spotify devolvió una respuesta de token inesperada.');
  }
  return body;
}
