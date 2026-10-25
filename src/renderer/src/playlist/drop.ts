/**
 * Manejo de archivos soltados sobre la ventana.
 *
 * Semántica inspirada en Winamp (Main_OnDropFiles):
 *  - Soltar sobre el reproductor: reemplaza la lista y reproduce (Open).
 *  - Soltar sobre la playlist: agrega al final sin tocar lo que suena.
 *  - Soltar un .m3u/.m3u8: se abre como lista (reemplaza y reproduce),
 *    venga de la zona que venga.
 *
 * La lógica vive aquí (no en la UI) para poder probarla sin DOM; la UI solo
 * conecta los eventos y decide la zona.
 */
import type { PlaylistController } from './PlaylistController';
import type { PlaylistPlayback } from './connect';
import { isM3UFileName } from './m3u';

export type DropMode = 'replace' | 'append';

export interface DropDeps {
  playlist: PlaylistController;
  playback: Pick<PlaylistPlayback, 'openFile' | 'playItem'>;
}

export async function handleDroppedFiles(
  deps: DropDeps,
  files: readonly File[],
  mode: DropMode
): Promise<void> {
  if (files.length === 0) return;

  // Un archivo de lista se "abre": no tendría sentido agregarlo como item.
  const playlistFile = files.find((file) => isM3UFileName(file.name));
  if (playlistFile) {
    await deps.playback.openFile(playlistFile);
    return;
  }

  if (mode === 'append') {
    deps.playlist.addFiles(files);
    return;
  }

  // Reemplaza la lista con lo soltado y reproduce el primero (Winamp:
  // PlayList_delete + append + BeginPlayback).
  const [first] = deps.playlist.replaceFiles(files);
  if (first) await deps.playback.playItem(first.id);
}
