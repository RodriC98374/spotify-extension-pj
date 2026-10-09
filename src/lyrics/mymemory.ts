import * as vscode from 'vscode';

const ENDPOINT = 'https://api.mymemory.translated.net/get';
const REQUEST_TIMEOUT_MS = 15_000;
/** MyMemory no admite consultas de más de 500 bytes. */
export const MAX_QUERY_BYTES = 500;
/** Espera cuando MyMemory avisa de que el cupo se agotó sin decir hasta cuándo. */
const DEFAULT_QUOTA_WAIT_MS = 60 * 60_000;
const MAX_QUOTA_WAIT_MS = 24 * 60 * 60_000;

/**
 * Se agotó el cupo diario. `retryAt` es el instante en que MyMemory vuelve a aceptar consultas y
 * `anonymous` indica que la consulta iba sin correo, con el cupo pequeño.
 */
export class QuotaExceededError extends Error {
  constructor(
    readonly retryAt: number,
    readonly anonymous: boolean,
  ) {
    super('Se agotó el cupo diario de traducción de MyMemory.');
    this.name = 'QuotaExceededError';
  }
}

export type BatchTranslation =
  /** Una traducción por cada línea enviada, en el mismo orden. `language` es el idioma de origen detectado. */
  | { kind: 'translated'; lines: string[]; language?: string }
  /** El texto ya está en el idioma de destino. */
  | { kind: 'sameLanguage' }
  /** La respuesta no trae una línea por cada línea enviada y no se puede repartir. */
  | { kind: 'misaligned' };

interface MyMemoryResponse {
  responseData?: { translatedText?: string | null; detectedLanguage?: string };
  /** Número si la consulta fue bien y texto si no: 200, "403". */
  responseStatus?: number | string;
  responseDetails?: string;
  quotaFinished?: boolean | null;
  matches?: Array<{ translation?: string; 'created-by'?: string }> | string;
}

/** Traducción automática gratuita de MyMemory. Sin clave: el cupo va por día y por dirección IP o correo. */
export class MyMemory {
  constructor(
    private readonly userAgent: string,
    private readonly getEmail: () => string,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /**
   * Traduce varias líneas en una sola consulta, unidas por saltos de línea, que MyMemory conserva.
   * Sin `source`, el idioma de origen lo detecta MyMemory. Rechaza con `QuotaExceededError` si se
   * agotó el cupo, y con un error normal si no se pudo consultar.
   */
  async translate(lines: string[], target: string, source = 'autodetect'): Promise<BatchTranslation> {
    const params = new URLSearchParams({ q: lines.join('\n'), langpair: `${source}|${target}` });
    const email = this.getEmail();
    if (email) {
      params.set('de', email);
    }
    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => undefined)) as MyMemoryResponse | undefined;
    // Los errores llegan con HTTP 200 y el estado real dentro del cuerpo.
    const status = Number(body?.responseStatus ?? res.status);
    const details = String(body?.responseDetails ?? '');
    if (res.status === 429 || status === 429 || body?.quotaFinished === true) {
      throw new QuotaExceededError(quotaRetryAt(res.headers.get('Retry-After'), details), !email);
    }
    if (status === 403 && /DISTINCT LANGUAGES/i.test(details)) {
      return { kind: 'sameLanguage' };
    }
    if (!res.ok || status !== 200 || !body) {
      throw new Error(`MyMemory respondió ${status}${details ? `: ${details}` : ''}.`);
    }

    // `translatedText` puede venir de una memoria de traducción ajena, con otro reparto de líneas:
    // se prefiere la traducción automática, que las conserva.
    const machine = Array.isArray(body.matches)
      ? body.matches.find((match) => match['created-by'] === 'MT!')?.translation
      : undefined;
    for (const text of [machine, body.responseData?.translatedText]) {
      if (typeof text !== 'string' || !text.trim()) {
        continue;
      }
      const translated = decodeEntities(text)
        .split(/\r?\n/)
        .map((line) => line.trim());
      if (lines.length === 1) {
        return { kind: 'translated', lines: [translated.join(' ').trim()], language: body.responseData?.detectedLanguage };
      }
      if (translated.length === lines.length) {
        return { kind: 'translated', lines: translated, language: body.responseData?.detectedLanguage };
      }
    }
    this.log.debug(`MyMemory devolvió un número de líneas distinto del enviado (${lines.length}).`);
    return { kind: 'misaligned' };
  }
}

/** Reparte las líneas en consultas de tamaño parecido, ninguna por encima del máximo de MyMemory. */
export function splitIntoBatches(lines: string[]): string[][] {
  // Cada línea cuenta con el salto que la separa de la siguiente.
  const size = (line: string): number => Buffer.byteLength(line, 'utf8') + 1;
  const total = lines.reduce((sum, line) => sum + size(line), 0);
  const target = total / Math.ceil(total / MAX_QUERY_BYTES);
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (batch.length > 0 && (bytes + size(line) - 1 > MAX_QUERY_BYTES || bytes >= target)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(line);
    bytes += size(line);
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

/** MyMemory dice cuándo se renueva el cupo en la cabecera `Retry-After` y, en texto, en el propio aviso. */
function quotaRetryAt(retryAfter: string | null, details: string): number {
  const seconds = Number(retryAfter);
  const stated = /(\d+)\s*HOURS?\s*(\d+)\s*MINUTES?\s*(\d+)\s*SECONDS?/i.exec(details);
  const waitMs =
    retryAfter && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : stated
        ? (Number(stated[1]) * 3600 + Number(stated[2]) * 60 + Number(stated[3])) * 1000
        : DEFAULT_QUOTA_WAIT_MS;
  return Date.now() + Math.min(waitMs, MAX_QUOTA_WAIT_MS);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** MyMemory devuelve a veces entidades HTML, como `&#39;` en lugar del apóstrofo. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal?: string, hex?: string, name?: string) => {
    if (name) {
      return ENTITIES[name.toLowerCase()] ?? entity;
    }
    const code = decimal ? Number(decimal) : parseInt(hex as string, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}
