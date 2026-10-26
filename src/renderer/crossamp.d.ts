import type { TagEdit, TagWriteResult } from './src/metadata/types';

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
  /**
   * Acciones del transporte enviadas por los atajos globales del main
   * ('play-pause' | 'next' | 'previous'). Devuelve la función para darse
   * de baja.
   */
  onMediaControl(callback: (action: string) => void): () => void;
  /**
   * Guarda los tags (Título/Artista/Álbum) de un MP3 en disco. El main
   * valida la ruta y escribe con backup temporal + rename atómico.
   */
  writeTags(path: string, tags: TagEdit): Promise<TagWriteResult>;
}

declare global {
  interface Window {
    crossamp?: CrossampApi;
  }
}

export {};
