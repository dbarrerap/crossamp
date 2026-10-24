import { basenameOfPath } from './m3u';
import type { PlaylistItem } from './types';

/**
 * Lee bytes de un archivo en disco. En Electron va por IPC (main process);
 * en navegador no existe (devuelve null) y el item no es reproducible.
 */
export type BytesReader = (path: string) => Promise<Uint8Array | null>;

/**
 * Convierte un item de la playlist en un File reproducible.
 *
 *  - Item agregado desde un <input type=file>: ya tiene `file`, se usa tal
 *    cual (cero I/O).
 *  - Item cargado desde un .m3u: trae `file: null` y solo `path` — así la
 *    lista no se volcó a RAM al cargarla. Recién al reproducirlo leemos
 *    sus bytes por IPC y armamos un File en memoria.
 *
 * Devuelve null si el item no es reproducible (sin bytes y sin ruta, o la
 * ruta no se pudo leer): el llamador debe avisar y saltarlo, nunca lanzar.
 */
export async function resolvePlaylistFile(
  item: PlaylistItem,
  readFile?: BytesReader
): Promise<File | null> {
  if (item.file) return item.file;

  if (!item.path || !readFile) return null;

  const bytes = await readFile(item.path);
  if (!bytes) return null;

  // Los lectores (IPC de Electron) devuelven bytes respaldados por un
  // ArrayBuffer normal; TS no puede saberlo (el tipo es ArrayBufferLike y
  // BlobPart excluye SharedArrayBuffer), así que acotamos el tipo.
  return new File([bytes as Uint8Array<ArrayBuffer>], basenameOfPath(item.path));
}
