import * as vscode from 'vscode';
import { describeError } from '../errors';
import { isDeviceUnreachable, isNoActiveDevice, Player } from '../spotify/player';
import type { Device } from '../spotify/types';
import { ControllableDevice, pickDevice } from './quickPicks';

/** Margen para que el dispositivo recién elegido quede activo antes de reintentar el comando. */
export const SETTLE_AFTER_TRANSFER_MS = 700;

/** Resuelve la falta de dispositivo que reciba las órdenes: lo elige o lo reactiva, y reintenta. */
export class DeviceGuard {
  constructor(
    private readonly player: Player,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Lista los dispositivos, deja elegir uno y le transfiere la reproducción. */
  async transferToChosenDevice(): Promise<ControllableDevice | undefined> {
    const devices = await this.controllableDevices();
    if (devices.length === 0) {
      warnNoDevices();
      return undefined;
    }
    const device = await pickDevice(devices);
    if (!device) {
      return undefined;
    }
    await this.player.transfer(device.id, false);
    return device;
  }

  /**
   * Ejecuta un comando del reproductor. Si falla por falta de dispositivo activo, ofrece transferir
   * la reproducción; si Spotify responde 404 sin motivo, reactiva el dispositivo. En ambos casos
   * reintenta el comando apuntando a ese dispositivo. Devuelve false si no se ejecutó.
   */
  async run(action: (deviceId?: string) => Promise<void>): Promise<boolean> {
    let device: ControllableDevice | undefined;
    try {
      await action();
      return true;
    } catch (err) {
      if (isNoActiveDevice(err)) {
        device = await this.offerTransfer();
      } else if (isDeviceUnreachable(err)) {
        device = await this.reactivateDevice();
      } else {
        throw err;
      }
    }
    if (!device) {
      return false;
    }
    try {
      await action(device.id);
    } catch (err) {
      throw isDeviceUnreachable(err) ? unreachable(device, err) : err;
    }
    return true;
  }

  /** El dispositivo activo o, si no hay ninguno, el que el usuario elija para transferir. */
  async activeDevice(): Promise<Device | undefined> {
    return (await this.player.getPlayback())?.device ?? (await this.offerTransfer());
  }

  private async controllableDevices(): Promise<ControllableDevice[]> {
    return (await this.player.getDevices()).filter(
      (device): device is ControllableDevice => device.id !== null && !device.is_restricted,
    );
  }

  private async offerTransfer(): Promise<ControllableDevice | undefined> {
    const choice = await vscode.window.showWarningMessage(
      'Spotify: no hay ningún dispositivo activo.',
      'Elegir dispositivo',
    );
    if (!choice) {
      return undefined;
    }
    const device = await this.transferToChosenDevice();
    if (device) {
      await settle();
    }
    return device;
  }

  /**
   * Tras un 404 sin motivo: vuelve a transferir la reproducción al dispositivo que figura como
   * activo, o al único que haya, para que acepte órdenes otra vez. Solo pregunta si hay varios
   * y ninguno está activo.
   */
  private async reactivateDevice(): Promise<ControllableDevice | undefined> {
    const devices = await this.controllableDevices();
    const active = devices.find((device) => device.is_active);
    this.log.warn(
      `Spotify respondió 404 sin motivo a un comando. Dispositivos visibles: ${devices.length}; ` +
        `${active ? 'uno figura como activo' : 'ninguno figura como activo'}. Se intenta reactivar.`,
    );
    if (devices.length === 0) {
      warnNoDevices();
      return undefined;
    }
    const device = active ?? (devices.length === 1 ? devices[0] : await pickDevice(devices));
    if (!device) {
      return undefined;
    }
    try {
      await this.player.transfer(device.id, false);
    } catch (err) {
      throw isDeviceUnreachable(err) ? unreachable(device, err) : err;
    }
    await settle();
    return device;
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_TRANSFER_MS));
}

function warnNoDevices(): void {
  void vscode.window.showWarningMessage(
    'Spotify: no se encontró ningún dispositivo. Abre Spotify en tu celular o computador y vuelve a intentarlo.',
  );
}

/** El dispositivo sigue sin recibir órdenes después de reactivarlo: solo queda despertarlo a mano. */
function unreachable(device: Device, cause: unknown): Error {
  return new Error(
    `«${device.name}» no recibe las órdenes (Spotify respondió «${describeError(cause)}»). ` +
      'Abre Spotify en ese dispositivo, reproduce algo ahí y vuelve a intentarlo.',
  );
}
