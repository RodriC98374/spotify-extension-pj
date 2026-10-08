import * as vscode from 'vscode';
import type { PlaybackState } from '../spotify/types';

const MAX_TRACK_LENGTH = 60;
const MAX_LYRIC_LENGTH = 80;

/** Botones y textos de la barra de estado. Con sesión cerrada solo se ve el acceso al login. */
export class StatusBar implements vscode.Disposable {
  // En la alineación izquierda, a mayor prioridad más a la izquierda. Las prioridades van pegadas y lejos
  // de las que usa VS Code (problemas = 50, puertos = 40) para que ningún otro elemento quede en medio.
  private readonly login = createItem('login', 'Spotify: sesión', 45.5, 'spotifyLocal.login');
  private readonly previous = createItem('previous', 'Spotify: anterior', 45.5, 'spotifyLocal.previous');
  private readonly playPause = createItem('playPause', 'Spotify: reproducir o pausar', 45.4, 'spotifyLocal.playPause');
  private readonly next = createItem('next', 'Spotify: siguiente', 45.3, 'spotifyLocal.next');
  private readonly track = createItem('track', 'Spotify: canción actual', 45.2);
  private readonly volume = createItem('volume', 'Spotify: volumen', 45.1, 'spotifyLocal.setVolume');
  private readonly lyric = createItem('lyric', 'Spotify: letra', 45.0, 'spotifyLocal.showLyrics');

  constructor() {
    this.lyric.tooltip = 'Abrir la letra';
    this.login.text = '$(account) Spotify: iniciar sesión';
    this.previous.text = '$(chevron-left)';
    this.previous.tooltip = 'Canción anterior';
    this.next.text = '$(chevron-right)';
    this.next.tooltip = 'Siguiente canción';
  }

  render(loggedIn: boolean, state: PlaybackState | undefined): void {
    setVisible(this.login, !loggedIn);
    for (const item of [this.previous, this.playPause, this.next, this.track]) {
      setVisible(item, loggedIn);
    }
    // El botón de volumen solo aparece si el dispositivo activo declara que admite control remoto.
    setVisible(this.volume, loggedIn && state?.device.supports_volume === true);
    if (!loggedIn) {
      return;
    }

    this.playPause.text = state?.is_playing ? '$(debug-pause)' : '$(play)';
    this.playPause.tooltip = state?.is_playing ? 'Pausar' : 'Reproducir';
    this.track.text = `$(music) ${truncate(trackLabel(state))}`;
    this.track.tooltip = trackTooltip(state);
    if (state) {
      const { name, volume_percent: percent } = state.device;
      this.volume.text = `${percent === 0 ? '$(mute)' : '$(unmute)'} ${percent === null ? '–' : `${percent}%`}`;
      this.volume.tooltip = `Volumen de ${name}`;
    }
  }

  /** Muestra la línea actual de la letra, o la oculta si llega `undefined`. */
  renderLyric(line: string | undefined): void {
    if (line) {
      this.lyric.text = `$(quote) ${truncate(line, MAX_LYRIC_LENGTH)}`;
    }
    setVisible(this.lyric, line !== undefined);
  }

  dispose(): void {
    for (const item of [this.login, this.previous, this.playPause, this.next, this.track, this.volume, this.lyric]) {
      item.dispose();
    }
  }
}

function createItem(id: string, name: string, priority: number, command?: string): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(`spotifyLocal.${id}`, vscode.StatusBarAlignment.Left, priority);
  item.name = name;
  item.command = command;
  return item;
}

function setVisible(item: vscode.StatusBarItem, visible: boolean): void {
  if (visible) {
    item.show();
  } else {
    item.hide();
  }
}

function trackLabel(state: PlaybackState | undefined): string {
  if (!state) {
    return 'Sin reproducción';
  }
  if (state.item) {
    return `${artistNames(state)} – ${state.item.name}`;
  }
  switch (state.currently_playing_type) {
    case 'ad':
      return 'Anuncio';
    case 'episode':
      return 'Pódcast';
    default:
      return 'Reproduciendo';
  }
}

function trackTooltip(state: PlaybackState | undefined): string {
  if (!state) {
    return 'No hay ningún dispositivo de Spotify activo';
  }
  const where = `En ${state.device.name}`;
  return state.item ? `${state.item.name}\n${artistNames(state)} · ${state.item.album.name}\n${where}` : where;
}

function artistNames(state: PlaybackState): string {
  return state.item?.artists.map((artist) => artist.name).join(', ') ?? '';
}

function truncate(text: string, max = MAX_TRACK_LENGTH): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
