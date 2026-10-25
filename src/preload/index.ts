import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

// Puente IPC expuesto al renderer como `window.crossamp`.
// La UI (browser-portable) NUNCA importa 'electron' directamente; habla
// solo con esta API. Si no existe (corriendo en navegador puro), la UI
// degrada gracefully.
const api = {
  platform: process.platform,

  // Ruta absoluta en disco de un File elegido por el usuario. El renderer
  // no puede verla por sí mismo (File.path se eliminó de Chromium); hace
  // falta para serializar rutas reales en el .m3u de la playlist.
  // Devuelve '' si el File no tiene ruta asociada.
  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // Bytes de un archivo en disco (para reproducir items de un .m3u que
  // solo guardan su ruta). null si no se pudo leer.
  readFile(path: string): Promise<Uint8Array | null> {
    if (typeof path !== 'string' || path.length === 0) {
      return Promise.resolve(null);
    }
    return ipcRenderer.invoke('playlist:readFile', path) as Promise<Uint8Array | null>;
  },

  // Acciones de transporte disparadas por los atajos globales del main
  // ('play-pause' | 'next' | 'previous'). Devuelve un unsubscribe.
  onMediaControl(callback: (action: string) => void): () => void {
    const listener = (_event: IpcRendererEvent, action: string): void => {
      callback(action);
    };
    ipcRenderer.on('media:control', listener);
    return () => {
      ipcRenderer.removeListener('media:control', listener);
    };
  }
};

contextBridge.exposeInMainWorld('crossamp', api);
