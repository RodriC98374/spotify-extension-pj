import * as http from 'node:http';
import { AuthError, LoginCancelledError } from './errors';

const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PORT = 8888;
const REDIRECT_PATH = '/callback';
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Debe coincidir exactamente con el Redirect URI registrado en el Spotify Developer Dashboard. */
export const REDIRECT_URI = `http://${REDIRECT_HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;

export interface CallbackListener {
  /** Se resuelve con el `code` de autorización. Cuando termina, el servidor ya está cerrado. */
  readonly code: Promise<string>;
  /** Cierra el servidor. Si `code` seguía pendiente, lo rechaza como cancelación. */
  cancel(): void;
}

/**
 * Levanta el servidor HTTP temporal que recibe el callback de Spotify.
 * La promesa se resuelve cuando el puerto ya está escuchando, para poder abrir el navegador sin carreras.
 */
export function startCallbackListener(expectedState: string): Promise<CallbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // Si se cancela antes de que alguien espere `code`, el rechazo no debe quedar sin manejar.
    code.catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    /** Devuelve false si el servidor ya estaba cerrado, para que el resultado se fije una sola vez. */
    const close = (): boolean => {
      if (closed) {
        return false;
      }
      closed = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      return true;
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (req.method !== 'GET' || url.pathname !== REDIRECT_PATH) {
        res.writeHead(404).end();
        return;
      }
      // Un `state` ajeno (una pestaña vieja, otra app) se rechaza sin abortar el login en curso.
      if (url.searchParams.get('state') !== expectedState) {
        respond(res, 400, 'Solicitud no válida', 'El parámetro state no coincide con el inicio de sesión en curso.');
        return;
      }
      const authCode = url.searchParams.get('code');
      if (authCode) {
        respond(res, 200, 'Sesión iniciada', 'Ya puedes cerrar esta pestaña y volver a VS Code.', () => {
          if (close()) {
            resolveCode(authCode);
          }
        });
        return;
      }
      const reason = url.searchParams.get('error') ?? 'respuesta sin código';
      respond(res, 400, 'No se pudo iniciar sesión', `Spotify rechazó la autorización (${reason}).`, () => {
        if (close()) {
          rejectCode(new AuthError(`Spotify rechazó la autorización (${reason}).`));
        }
      });
    });

    server.once('error', (err: NodeJS.ErrnoException) => {
      const error =
        err.code === 'EADDRINUSE'
          ? new AuthError(
              `El puerto ${REDIRECT_PORT} está ocupado por otro programa. Libéralo y vuelve a iniciar sesión.`,
            )
          : new AuthError(`No se pudo iniciar el servidor local del callback: ${err.message}`);
      close();
      rejectCode(error);
      rejectListener(error);
    });

    server.listen(REDIRECT_PORT, REDIRECT_HOST, () => {
      timer = setTimeout(() => {
        if (close()) {
          rejectCode(new AuthError('Se agotó el tiempo de espera del inicio de sesión.'));
        }
      }, LOGIN_TIMEOUT_MS);
      resolveListener({
        code,
        cancel: () => {
          if (close()) {
            rejectCode(new LoginCancelledError());
          }
        },
      });
    });
  });
}

/** `onClosed` se invoca cuando la respuesta ya se envió o la conexión se cortó, lo que ocurra primero. */
function respond(
  res: http.ServerResponse,
  status: number,
  title: string,
  detail: string,
  onClosed?: () => void,
): void {
  if (onClosed) {
    res.once('close', onClosed);
  }
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(page(title, detail));
}

function page(title: string, detail: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Spotify Local</title>
<style>
  body { font-family: system-ui, sans-serif; background: #121212; color: #fff; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { text-align: center; padding: 2rem; }
  p { color: #b3b3b3; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
