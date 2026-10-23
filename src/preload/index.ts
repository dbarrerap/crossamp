import { contextBridge } from 'electron';

// Puente IPC expuesto al renderer como `window.crossamp`.
// La UI (browser-portable) NUNCA importa 'electron' directamente; habla
// solo con esta API. Si no existe (corriendo en navegador puro), la UI
// degrada gracefully.
const api = {
  platform: process.platform
};

contextBridge.exposeInMainWorld('crossamp', api);
