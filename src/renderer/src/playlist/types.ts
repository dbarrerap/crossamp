/**
 * Modelo de la playlist.
 *
 * Un item puede existir de dos formas:
 *  - Con `file` (agregado vía <input type=file>): bytes ya en memoria.
 *  - Solo con `path` (cargado desde un .m3u): ruta en disco. Sus bytes NO
 *    se leen al cargar el playlist (un m3u de 500 pistas no puede volcarse
 *    entero en RAM); se leerán cuando se reproduzcan (Fase 2.2).
 *
 * `path` es lo único que se persiste en el .m3u, y por eso el controller
 * consulta la ruta real del File al agregarlo (webUtils.getPathForFile en
 * Electron; en navegador queda null y el guardado se degrada).
 */
export interface PlaylistItem {
  id: string;
  /** Nombre para mostrar: nombre del archivo sin extensión (o el título del #EXTINF). */
  name: string;
  /** Bytes en memoria si el item se agregó desde un archivo elegido por el usuario. */
  file: File | null;
  /** Ruta absoluta en disco si se conoce. Es lo que viaja en el .m3u. */
  path: string | null;
  /**
   * Duración en segundos. Se conoce de dos formas:
   *  - medida por el engine al reproducir el item (la buena), o
   *  - leída del #EXTINF al cargar un .m3u (la que traía el archivo).
   * null = desconocida → se escribe -1 en el .m3u (convención Winamp).
   */
  duration: number | null;
}

export interface PlaylistState {
  items: PlaylistItem[];
  /** Id del item seleccionado (objetivo de "Quitar"). null = ninguno. */
  selectedId: string | null;
  /**
   * Id del item que se está reproduciendo AHORA (o que se reprodujo como
   * último de la lista). La UI lo marca y el transporte usa este id para
   * saber cuál es el siguiente al terminar la pista. null = nada en curso
   * (al terminar, no hay dónde avanzar).
   */
  playingId: string | null;
}

export const initialPlaylistState: PlaylistState = {
  items: [],
  selectedId: null,
  playingId: null
};
