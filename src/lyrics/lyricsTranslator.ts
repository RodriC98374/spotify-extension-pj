import * as vscode from 'vscode';
import { describeError } from '../errors';
import type { LyricsContent } from './lyricsSync';
import { MAX_QUERY_BYTES, MyMemory, QuotaExceededError, splitIntoBatches } from './mymemory';
import type { TranslationStore } from './translationStore';

const TARGET_LANGUAGE = 'es';
/** Tras un fallo de red o del servicio no se vuelve a consultar hasta pasado este tiempo. */
const RETRY_AFTER_ERROR_MS = 60_000;
/** Con menos palabras no se puede saber en qué idioma está una letra. */
const MIN_WORDS_TO_GUESS = 20;
const IN_PROGRESS = 'Traduciendo la letra…';

export interface Translation {
  /** Traducción de cada línea de la letra, en su mismo orden; `undefined` donde no hay o no hace falta. */
  lines: (string | undefined)[];
  /** Aviso para la vista: traducción en curso, cupo agotado o error. */
  note?: string;
}

type TextLyrics = Extract<LyricsContent, { status: 'synced' | 'plain' }>;

const NONE: Translation = { lines: [] };

/**
 * Traduce al español la letra que se está mostrando. Solo pide a MyMemory las líneas que no tiene
 * guardadas, sin repetidas y en pocas consultas, porque el cupo gratuito es por caracteres y por día.
 */
export class LyricsTranslator implements vscode.Disposable {
  private content: LyricsContent | undefined;
  private translation: Translation = NONE;
  private run = 0;
  /** Mientras dure no se consulta a MyMemory; `note` explica por qué. */
  private pause: { until: number; note: () => string } | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Llegó más traducción, o un aviso, para la última letra pedida con `get()`. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly service: MyMemory,
    private readonly store: TranslationStore,
    private readonly isEnabled: () => boolean,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Traducción de esa letra con lo que haya hasta ahora. Si aún no se había pedido, empieza a buscarla. */
  get(content: LyricsContent): Translation {
    if (!this.isEnabled() || (content.status !== 'synced' && content.status !== 'plain')) {
      this.cancel();
      return NONE;
    }
    if (content !== this.content) {
      this.content = content;
      this.translation = NONE;
      void this.load(content, ++this.run);
    }
    return this.translation;
  }

  /** La letra dejó de mostrarse: no se piden más líneas. Lo ya traducido queda guardado. */
  cancel(): void {
    this.run++;
    this.content = undefined;
    this.translation = NONE;
  }

  /** Como `cancel()`, y además olvida la pausa: cambió un ajuste y vale la pena volver a consultar. */
  reset(): void {
    this.cancel();
    this.pause = undefined;
  }

  dispose(): void {
    this.run++;
    this.emitter.dispose();
  }

  private async load(content: TextLyrics, run: number): Promise<void> {
    const source =
      content.status === 'synced' ? content.lines.map((line) => line.text.trim()) : content.lines.map((line) => line.trim());
    const key = content.track.id ?? content.track.uri;
    const stored = await this.store.read(key, TARGET_LANGUAGE);
    const publish = (note?: string): void => {
      if (run === this.run) {
        this.translation = { lines: source.map((line) => stored.get(line) ?? undefined), note };
        this.emitter.fire();
      }
    };

    const wanted = [...new Set(source)].filter(isTranslatable);
    const missing = wanted.filter((line) => !stored.has(line));
    if (missing.length === 0 || (stored.size === 0 && looksSpanish(wanted))) {
      publish();
      return;
    }
    if (this.pause && Date.now() < this.pause.until) {
      publish(this.pause.note());
      return;
    }
    if (run !== this.run) {
      return;
    }

    publish(IN_PROGRESS);
    let changed = false;
    const keep = (lines: string[], translated: (string | null)[]): void => {
      lines.forEach((line, index) => {
        const text = translated[index];
        // Una "traducción" igual al original (un "oh, oh", una línea que ya estaba en español) no se muestra.
        stored.set(line, text && letters(text) !== letters(line) ? text : null);
      });
      changed = true;
    };
    try {
      let language: string | undefined;
      const inSpanish: string[][] = [];
      for (const batch of splitIntoBatches(missing)) {
        if (run !== this.run) {
          return;
        }
        const result = await this.service.translate(batch, TARGET_LANGUAGE);
        if (result.kind === 'sameLanguage') {
          inSpanish.push(batch);
          continue;
        }
        if (result.kind === 'translated') {
          language ??= result.language;
        }
        keep(batch, result.kind === 'translated' ? result.lines : await this.lineByLine(batch, language));
        publish(IN_PROGRESS);
      }
      // Trozos que MyMemory dio por escritos en español. Si el resto de la letra está en otro idioma,
      // se repiten diciéndole cuál, por las líneas sueltas que no estén en español.
      for (const batch of inSpanish) {
        if (run !== this.run) {
          return;
        }
        const result = language ? await this.service.translate(batch, TARGET_LANGUAGE, language) : undefined;
        if (result?.kind === 'misaligned') {
          keep(batch, await this.lineByLine(batch, language));
        } else {
          keep(batch, result?.kind === 'translated' ? result.lines : batch.map(() => null));
        }
      }
      publish();
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        const { retryAt, anonymous } = err;
        this.pause = { until: retryAt, note: () => quotaNote(retryAt, anonymous) };
        this.log.info(`MyMemory: cupo diario de traducción agotado${anonymous ? ' (sin correo)' : ''}.`);
      } else {
        const message = describeError(err);
        this.pause = { until: Date.now() + RETRY_AFTER_ERROR_MS, note: () => `No se pudo traducir la letra: ${message}` };
        this.log.warn(`MyMemory: ${message}`);
      }
      publish(this.pause.note());
    } finally {
      if (changed) {
        await this.store
          .write(key, TARGET_LANGUAGE, stored)
          .catch((err: unknown) => this.log.warn(`No se pudo guardar la traducción: ${describeError(err)}`));
      }
    }
  }

  /** Último recurso cuando la respuesta a un trozo no cuadra línea a línea: una consulta por línea. */
  private async lineByLine(lines: string[], source: string | undefined): Promise<(string | null)[]> {
    const translated: (string | null)[] = [];
    for (const line of lines) {
      const result = await this.service.translate([line], TARGET_LANGUAGE, source);
      translated.push(result.kind === 'translated' ? result.lines[0] : null);
    }
    return translated;
  }
}

/** Con letras que traducir y sin pasarse del tamaño máximo de una consulta. */
function isTranslatable(line: string): boolean {
  return /\p{L}/u.test(line) && Buffer.byteLength(line, 'utf8') <= MAX_QUERY_BYTES;
}

/** Solo letras y cifras, sin tildes ni mayúsculas: para comparar una línea con su traducción. */
function letters(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function quotaNote(retryAt: number, anonymous: boolean): string {
  const minutes = Math.max(1, Math.round((retryAt - Date.now()) / 60_000));
  const wait = minutes >= 90 ? `unas ${Math.round(minutes / 60)} h` : `unos ${minutes} min`;
  const hint = anonymous ? ' Con un correo en el ajuste «spotifyLocal.translationEmail» el cupo es diez veces mayor.' : '';
  return `Se agotó el cupo diario de traducción de MyMemory. Vuelve a estar disponible en ${wait}.${hint}`;
}

// Palabras frecuentes que no comparten con el español ni el portugués, ni el italiano, ni el francés.
const SPANISH_WORDS = new Set(
  (
    'y el los las yo pero muy eres estoy soy voy hay quiero quieres tengo tienes puedo cuando siempre ahora ' +
    'tambien conmigo hoy noche corazon donde aunque hasta mientras ella ellos eso esto asi ni mis tus nosotros ' +
    'ustedes entonces despues ayer'
  ).split(' '),
);
const ENGLISH_WORDS = new Set(
  (
    'the you and i to it of my your is that this with for we be all on so but what when don can know just will ' +
    'was are have they she not out up now never'
  ).split(' '),
);

/**
 * La letra ya está en español y no hay nada que pedir. Solo responde que sí cuando está claro: una
 * letra con parte en inglés, o en un idioma parecido, se le deja a MyMemory, que detecta el idioma.
 */
export function looksSpanish(lines: string[]): boolean {
  const words = lines
    .join(' ')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  if (words.length < MIN_WORDS_TO_GUESS) {
    return false;
  }
  const share = (known: Set<string>): number => words.filter((word) => known.has(word)).length / words.length;
  return share(SPANISH_WORDS) >= 0.06 && share(ENGLISH_WORDS) < 0.03;
}
