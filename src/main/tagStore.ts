/**
 * Escritura de tags ID3 en MP3 (editor Alt+3).
 *
 * Vive en el main porque el renderer está en sandbox y no puede escribir
 * archivos. Usa node-id3 para actualizar TIT2/TPE1/TALB sin pisar el resto
 * de los frames (carátula, año, etc.).
 *
 * Seguridad ante corrupción:
 *  - Antes de escribir, copia el original a `<archivo>.bak` (si no existe).
 *  - Escribe a un temporal y hace rename atómico.
 *  - Si el guardado termina bien, elimina el `.bak`; si falla, lo deja para
 *    recuperar. Nunca se toca un `.bak` que ya existiera antes.
 */
import { access, copyFile, readFile, rename, unlink, writeFile } from 'fs/promises';
import NodeID3 from 'node-id3';

export interface TagEdit {
  title: string;
  artist: string;
  album: string;
}

const MAX_TAG_LENGTH = 512;

export function isTagEdit(value: unknown): value is TagEdit {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.title === 'string' &&
    typeof record.artist === 'string' &&
    typeof record.album === 'string'
  );
}

export async function writeMp3Tags(path: string, tags: TagEdit): Promise<void> {
  if (typeof path !== 'string' || !/\.mp3$/i.test(path)) {
    throw new Error('Solo se pueden editar etiquetas de archivos .mp3');
  }

  // node-id3 considera "vacío" un string '' y omite el frame: así se borra
  // un campo (TIT2/TPE1/TALB) sin tocar los demás.
  const clean = (value: string): string =>
    value.trim().slice(0, MAX_TAG_LENGTH);

  const backupPath = `${path}.bak`;
  let backupCreated = false;
  try {
    await access(backupPath);
  } catch {
    await copyFile(path, backupPath);
    backupCreated = true;
  }

  const tempPath = `${path}.crossamp.tmp`;
  try {
    const original = await readFile(path);
    const updated = NodeID3.update(
      {
        title: clean(tags.title),
        artist: clean(tags.artist),
        album: clean(tags.album)
      },
      original
    );
    if (!Buffer.isBuffer(updated)) {
      throw new Error('No se pudo generar el tag actualizado');
    }

    await writeFile(tempPath, updated);
    await rename(tempPath, path);

    if (backupCreated) {
      await unlink(backupPath).catch(() => {
        // Si no se puede borrar, queda un .bak inocuo.
      });
    }
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}
