import * as vscode from 'vscode';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Instante (epoch en ms) en que vence el access token. */
  expiresAt: number;
  scope: string;
}

const SECRET_KEY = 'spotifyLocal.tokens';

/** Tokens en SecretStorage, con caché en memoria que se invalida si otra ventana de VS Code los cambia. */
export class TokenStore implements vscode.Disposable {
  private cached: Promise<StoredTokens | undefined> | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;

  /** Se dispara cuando los tokens cambian, también desde otra ventana. Puede repetirse para un mismo cambio. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.subscription = secrets.onDidChange((event) => {
      if (event.key === SECRET_KEY) {
        this.cached = undefined;
        this.changeEmitter.fire();
      }
    });
  }

  get(): Promise<StoredTokens | undefined> {
    this.cached ??= this.read();
    return this.cached;
  }

  /** Relee SecretStorage ignorando la caché. */
  reload(): Promise<StoredTokens | undefined> {
    this.cached = undefined;
    return this.get();
  }

  async set(tokens: StoredTokens): Promise<void> {
    this.cached = Promise.resolve(tokens);
    await this.secrets.store(SECRET_KEY, JSON.stringify(tokens));
    this.changeEmitter.fire();
  }

  async clear(): Promise<void> {
    this.cached = Promise.resolve(undefined);
    await this.secrets.delete(SECRET_KEY);
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }

  private async read(): Promise<StoredTokens | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      const parsed: Partial<StoredTokens> = JSON.parse(raw);
      if (
        typeof parsed.accessToken === 'string' &&
        typeof parsed.refreshToken === 'string' &&
        typeof parsed.expiresAt === 'number'
      ) {
        return {
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          expiresAt: parsed.expiresAt,
          scope: typeof parsed.scope === 'string' ? parsed.scope : '',
        };
      }
    } catch {
      // Un valor corrupto equivale a no tener sesión.
    }
    return undefined;
  }
}
