export interface CrossampApi {
  platform: NodeJS.Platform | string;
  /**
   * Ruta absoluta en disco de un File elegido por el usuario (Electron:
   * webUtils.getPathForFile). '' si no hay ruta asociada. El renderer no
   * puede obtenerla por su cuenta: File.path ya no existe en Chromium.
   */
  getPathForFile(file: File): string;
  /**
   * Bytes de un archivo en disco, para reproducir items cargados desde un
   * .m3u (que solo guardan su ruta). null si no se pudo leer. En navegador
   * puro no existe.
   */
  readFile(path: string): Promise<Uint8Array | null>;
}

declare global {
  interface Window {
    crossamp?: CrossampApi;
  }
}

export {};
