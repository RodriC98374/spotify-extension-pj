/** Texto legible de un error, para mostrarlo o registrarlo. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  if (err.name === 'TimeoutError') {
    return 'La petición no respondió a tiempo.';
  }
  // El fetch nativo envuelve los fallos de red en TypeError('fetch failed') y deja la causa real aparte.
  if (err instanceof TypeError && err.cause) {
    const cause = err.cause as { code?: string; message?: string };
    return `No se pudo conectar (${cause.code ?? cause.message ?? 'error de red'}).`;
  }
  return err.message;
}
