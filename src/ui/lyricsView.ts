import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { LyricsContent, LyricsSync } from '../lyrics/lyricsSync';

/** Mensajes que la extensión envía al webview. */
type ViewMessage =
  | { type: 'content'; synced: boolean; lines: string[]; active: number; message?: string; note?: string }
  | { type: 'active'; index: number };

/** Vista lateral con la letra. El webview solo pinta lo que recibe; el estado vive en `LyricsSync`. */
export class LyricsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'spotifyLocal.lyrics';

  private view: vscode.WebviewView | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly sync: LyricsSync) {
    this.subscriptions = [
      sync.onDidChangeContent(() => this.postContent()),
      sync.onDidChangeLine((index) => this.post({ type: 'active', index })),
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    // Al ocultarse la vista su contenido se destruye; cuando vuelve, el script avisa con "ready" y se le reenvía todo.
    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'ready') {
        this.postContent();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    view.webview.html = renderHtml();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private postContent(): void {
    if (!this.view) {
      return;
    }
    const content = this.sync.content;
    this.view.description =
      content.status === 'idle'
        ? undefined
        : `${content.track.artists.map((artist) => artist.name).join(', ')} – ${content.track.name}`;
    this.post({ type: 'content', ...describe(content), active: this.sync.lineIndex });
  }

  private post(message: ViewMessage): void {
    void this.view?.webview.postMessage(message);
  }
}

function describe(content: LyricsContent): { synced: boolean; lines: string[]; message?: string; note?: string } {
  switch (content.status) {
    case 'synced':
      return { synced: true, lines: content.lines.map((line) => line.text) };
    case 'plain':
      return { synced: false, lines: content.lines, note: 'Letra sin sincronizar' };
    case 'idle':
      return { synced: false, lines: [], message: 'No hay ninguna canción sonando en Spotify.' };
    case 'loading':
      return { synced: false, lines: [], message: 'Buscando la letra…' };
    case 'instrumental':
      return { synced: false, lines: [], message: 'Esta canción es instrumental.' };
    case 'missing':
      return {
        synced: false,
        lines: [],
        message: content.uncertain
          ? 'LRCLIB está saturado y no pudo terminar de buscar la letra de esta canción. Se buscará de nuevo cuando vuelva a sonar, pasados unos minutos.'
          : 'LRCLIB no tiene la letra de esta canción.',
      };
    case 'error':
      return {
        synced: false,
        lines: [],
        message: `No se pudo consultar LRCLIB: ${content.message} Se reintentará en unos segundos.`,
      };
  }
}

function renderHtml(): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  body { margin: 0; padding: 12px 16px 45vh; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  #message, #note { color: var(--vscode-descriptionForeground); }
  #message { padding: 12px 0; }
  #note { padding-bottom: 8px; font-style: italic; }
  #lines p { margin: 0; padding: 6px 0; line-height: 1.45; }
  #lines.synced p { opacity: 0.45; transform-origin: left center; transition: opacity 0.25s, transform 0.25s, color 0.25s; }
  #lines.synced p.current { opacity: 1; font-weight: 600; color: var(--vscode-textLink-activeForeground); transform: scale(1.05); }
</style>
</head>
<body>
<div id="message" hidden></div>
<div id="note" hidden></div>
<div id="lines"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const lines = document.getElementById('lines');
  const message = document.getElementById('message');
  const note = document.getElementById('note');
  // Si el usuario se desplaza a mano, el seguimiento automático espera unos segundos antes de volver.
  const MANUAL_SCROLL_PAUSE_MS = 4000;
  let lastManualScroll = 0;
  let current = -1;

  for (const type of ['wheel', 'touchmove', 'keydown']) {
    window.addEventListener(type, () => { lastManualScroll = Date.now(); }, { passive: true });
  }

  function setText(element, text) {
    element.textContent = text || '';
    element.hidden = !text;
  }

  function setContent(data) {
    setText(message, data.message);
    setText(note, data.note);
    lines.className = data.synced ? 'synced' : 'plain';
    lines.replaceChildren(...data.lines.map((text) => {
      const line = document.createElement('p');
      line.textContent = text || (data.synced ? '♪' : '\\u00a0');
      return line;
    }));
    current = -1;
    lastManualScroll = 0;
    window.scrollTo(0, 0);
    setActive(data.active, true);
  }

  function setActive(index, instant) {
    if (index === current) {
      return;
    }
    lines.children[current]?.classList.remove('current');
    current = index;
    const line = lines.children[index];
    if (!line) {
      return;
    }
    line.classList.add('current');
    if (Date.now() - lastManualScroll > MANUAL_SCROLL_PAUSE_MS) {
      line.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data.type === 'content') {
      setContent(event.data);
    } else if (event.data.type === 'active') {
      setActive(event.data.index, false);
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
