import * as vscode from 'vscode';
import { LoginCancelledError, MissingClientIdError, NotLoggedInError } from '../auth/errors';
import { describeError } from '../errors';

/** Muestra un error al usuario; los que tienen arreglo conocido ofrecen la acción correspondiente. */
export async function showError(err: unknown): Promise<void> {
  if (err instanceof LoginCancelledError) {
    return;
  }
  if (err instanceof MissingClientIdError) {
    const choice = await vscode.window.showErrorMessage(err.message, 'Abrir ajustes');
    if (choice) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'spotifyLocal.clientId');
    }
    return;
  }
  if (err instanceof NotLoggedInError) {
    const choice = await vscode.window.showWarningMessage(err.message, 'Iniciar sesión');
    if (choice) {
      await vscode.commands.executeCommand('spotifyLocal.login');
    }
    return;
  }
  void vscode.window.showErrorMessage(`Spotify: ${describeError(err)}`);
}
