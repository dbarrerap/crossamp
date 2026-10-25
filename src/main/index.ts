import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Lee un archivo de audio desde disco y devuelve sus bytes al renderer.
 * Hace falta para reproducir items cargados desde un .m3u: esos items solo
 * guardan la ruta (no se volcó la lista a RAM), y recién al reproducirlos
 * pedimos sus bytes por aquí. Devuelve null si no se pudo leer (ruta
 * faltante, permisos): el renderer avisa y salta el item.
 */
ipcMain.handle('playlist:readFile', async (_event, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return null;
  try {
    const buf = await readFile(path);
    // Buffer viaja por structured clone como Uint8Array: llega tal cual.
    return new Uint8Array(buf);
  } catch {
    return null;
  }
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 275,
    // Altura fija que acomoda player (Fase 1) + playlist (Fase 2.1).
    height: 700,
    title: 'crossamp',
    resizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Una sola instancia: dos procesos comparten `userData` y el segundo
// arranca sin sesión (LevelDB de localStorage bloqueado). Si ya hay una
// instancia, enfocamos su ventana y salimos.
const gotSingleInstance = app.requestSingleInstanceLock();

if (!gotSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
