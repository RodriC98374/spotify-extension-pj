export class AuthError extends Error {}

export class MissingClientIdError extends AuthError {
  constructor() {
    super('Falta el Client ID de Spotify. Configura el ajuste "spotifyLocal.clientId".');
  }
}

export class NotLoggedInError extends AuthError {
  constructor(message = 'No has iniciado sesión en Spotify.') {
    super(message);
  }
}

export class SessionExpiredError extends NotLoggedInError {
  constructor() {
    super('La sesión de Spotify venció o fue revocada. Inicia sesión de nuevo.');
  }
}

/** La sesión es anterior a un permiso que ahora hace falta; se resuelve iniciando sesión otra vez. */
export class MissingScopeError extends NotLoggedInError {
  constructor() {
    super('Para acceder a tu biblioteca de Spotify hay que volver a iniciar sesión y aceptar el permiso nuevo.');
  }
}

export class LoginCancelledError extends AuthError {
  constructor() {
    super('Inicio de sesión cancelado.');
  }
}
