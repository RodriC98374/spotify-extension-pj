export interface LyricLine {
  timeMs: number;
  /** Vacío en las pausas instrumentales que el LRC marca con una línea sin texto. */
  text: string;
}

/**
 * Convierte una letra en formato LRC en líneas ordenadas por tiempo.
 * Admite varias marcas por línea (`[00:12.00][00:45.00]texto`) e ignora los metadatos (`[ar:...]`).
 */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const timeTag = /\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
  for (const raw of lrc.split(/\r?\n/)) {
    const times: number[] = [];
    let cursor = 0;
    for (;;) {
      timeTag.lastIndex = cursor;
      const match = timeTag.exec(raw);
      if (!match) {
        break;
      }
      // La fracción puede venir en décimas, centésimas o milésimas.
      const fraction = Number((match[3] ?? '').padEnd(3, '0'));
      times.push(Number(match[1]) * 60_000 + Number(match[2]) * 1000 + fraction);
      cursor = timeTag.lastIndex;
    }
    if (times.length === 0) {
      continue;
    }
    // El LRC "mejorado" intercala marcas por palabra (<00:12.50>) que aquí no se usan.
    const text = raw
      .slice(cursor)
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .trim();
    for (const timeMs of times) {
      lines.push({ timeMs, text });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}
