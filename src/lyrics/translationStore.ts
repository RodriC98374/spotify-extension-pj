import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const MAX_IN_MEMORY = 50;

/** Traducción de cada línea de una canción; `null` si la línea no necesita traducción. */
export type StoredLines = Map<string, string | null>;

/** Traducciones guardadas en disco, un archivo por canción e idioma: cada línea se pide una sola vez. */
export class TranslationStore {
  // Las últimas canciones se sirven de memoria: una lectura no depende de que la escritura anterior haya llegado al disco.
  private readonly recent = new Map<string, StoredLines>();

  constructor(private readonly directory: string) {}

  /** Lo guardado de esa canción; vacío si no hay nada o el archivo no se puede leer. */
  async read(trackKey: string, language: string): Promise<StoredLines> {
    const file = this.file(trackKey, language);
    let lines = this.recent.get(file);
    if (!lines) {
      const loaded = await this.load(file);
      // Si otra lectura se adelantó mientras se consultaba el disco, vale la suya.
      lines = this.recent.get(file) ?? loaded;
      this.remember(file, lines);
    }
    return lines;
  }

  async write(trackKey: string, language: string, lines: StoredLines): Promise<void> {
    const file = this.file(trackKey, language);
    this.remember(file, lines);
    await mkdir(this.directory, { recursive: true });
    await writeFile(file, JSON.stringify({ lines: [...lines] }));
  }

  private async load(file: string): Promise<StoredLines> {
    try {
      const data: unknown = JSON.parse(await readFile(file, 'utf8'));
      const lines = (data as { lines?: unknown }).lines;
      return new Map(Array.isArray(lines) ? (lines as [string, string | null][]) : []);
    } catch {
      return new Map();
    }
  }

  private remember(file: string, lines: StoredLines): void {
    this.recent.delete(file);
    if (this.recent.size >= MAX_IN_MEMORY) {
      this.recent.delete(this.recent.keys().next().value as string);
    }
    this.recent.set(file, lines);
  }

  private file(trackKey: string, language: string): string {
    // La clave puede ser una URI de Spotify, con caracteres que no valen en un nombre de archivo.
    const name = createHash('sha1').update(trackKey).digest('hex');
    return path.join(this.directory, `${name}.${language}.json`);
  }
}
