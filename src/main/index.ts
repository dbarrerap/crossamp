import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
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

let mainWindow: BrowserWindow | null = null;

/**
 * Atajos globales del transporte (funcionan con la app en segundo plano).
 * Las teclas multimedia del sistema van por MediaSession en el renderer;
 * estos son atajos propios para no chocar con las combinaciones reservadas.
 */
const GLOBAL_SHORTCUTS: ReadonlyArray<{ accelerator: string; action: string }> = [
  { accelerator: 'CommandOrControl+Alt+P', action: 'play-pause' },
  { accelerator: 'CommandOrControl+Alt+Right', action: 'next' },
  { accelerator: 'CommandOrControl+Alt+Left', action: 'previous' }
];

function registerGlobalShortcuts(win: BrowserWindow): void {
  for (const { accelerator, action } of GLOBAL_SHORTCUTS) {
    const registered = globalShortcut.register(accelerator, () => {
      win.webContents.send('media:control', action);
    });
    if (registered) {
      console.info(`[crossamp] atajo global ${accelerator} → ${action}`);
    } else {
      console.warn(`[crossamp] no se pudo registrar el atajo ${accelerator}`);
    }
  }
}

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

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  registerGlobalShortcuts(win);

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
    const win = mainWindow;
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

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
