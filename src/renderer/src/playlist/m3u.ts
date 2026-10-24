/**
 * Codec M3U/M3U8 — puro, sin I/O. El formato lo inventó Winamp:
 *
 *   #EXTM3U
 *   #EXTINF:123,Artista - Título
 *   /ruta/al/archivo.mp3
 *
 * Reglas que implementamos:
 *  - Las líneas que empiezan con '#' son comentarios (#EXTM3U lo es).
 *  - #EXTINF describe a la entrada siguiente: duración en segundos y, tras
 *    la PRIMERA coma, el título (que puede contener comas).
 *  - Escribimos UTF-8: los nombres con acentos y caracteres de ancho
 *    completo (：｜) lo exigen; el m3u clásico era ANSI y se mojibakeaba.
 *    Los reproductores modernos (Winamp 5, VLC, foobar) leen UTF-8 sin
 *    problema, con o sin BOM.
 *  - Duración -1 = desconocida: no vamos a decodificar todas las pistas
 *    solo para escribir un playlist.
 */

export interface M3UEntry {
  path: string;
  title: string | null;
  /** Segundos del #EXTINF. null = desconocida (se escribe -1). */
  duration?: number | null;
}

export function serializeM3U(entries: M3UEntry[]): string {
  const lines = ['#EXTM3U'];
  for (const entry of entries) {
    // Duración real si la conocemos (medida por el engine al reproducir),
    // -1 si no. Winamp escribía exactamente esto.
    const duration =
      entry.duration != null && Number.isFinite(entry.duration) && entry.duration >= 0
        ? Math.round(entry.duration)
        : -1;
    lines.push(`#EXTINF:${duration},${entry.title ?? ''}`);
    lines.push(entry.path);
  }
  return lines.join('\n') + '\n';
}

export function parseM3U(text: string): M3UEntry[] {
  const entries: M3UEntry[] = [];
  // El título/duración de un #EXTINF aplica a la próxima línea de ruta.
  let pendingTitle: string | null = null;
  let pendingDuration: number | null = null;

  // Ignoramos BOM (UTF-8 con BOM es común al editar a mano en Windows) y
  // aceptamos \n y \r\n por igual.
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (/^#EXTINF:/i.test(line)) {
        // #EXTINF:<segundos>,<título> — la duración va antes de la PRIMERA
        // coma; el título puede contener comas. Sin coma, solo hay duración.
        const rest = line.slice('#EXTINF:'.length);
        const comma = rest.indexOf(',');
        const rawDuration = (comma >= 0 ? rest.slice(0, comma) : rest).trim();
        const seconds = Number(rawDuration);
        pendingDuration =
          rawDuration.length > 0 && Number.isFinite(seconds) && seconds >= 0
            ? seconds
            : null;
        pendingTitle =
          comma >= 0 && rest.slice(comma + 1).trim().length > 0
            ? rest.slice(comma + 1).trim()
            : null;
      }
      continue;
    }

    entries.push({
      path: normalizeEntryPath(line),
      title: pendingTitle,
      duration: pendingDuration
    });
    pendingTitle = null;
    pendingDuration = null;
  }

  return entries;
}

/**
 * Nombre para mostrar de una ruta: solo el archivo, sin directorio ni
 * extensión. Maneja separadores Windows y POSIX.
 */
export function displayNameFromPath(path: string): string {
  const base = basenameOfPath(path);
  const withoutExt = base.replace(/\.[^.]+$/, '');
  return withoutExt.length > 0 ? withoutExt : base;
}

/** Solo el archivo de una ruta, CON extensión (para nombrar un File leído por IPC). */
export function basenameOfPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Directorio de una ruta ('' si no tiene). Para resolver rutas relativas del m3u. */
export function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : '';
}

export function isAbsolutePath(path: string): boolean {
  return /^([\\/]|[a-zA-Z]:[\\/])/.test(path);
}

/**
 * Resuelve una entrada del m3u contra el directorio del propio .m3u:
 * Winamp resuelve las rutas relativas así, y muchos playlists compartidos
 * las usan. Sin baseDir (modo navegador) se queda tal cual.
 */
export function resolveEntryPath(entry: string, baseDir?: string): string {
  if (!baseDir || isAbsolutePath(entry)) return entry;
  const sep = baseDir.includes('\\') && !baseDir.includes('/') ? '\\' : '/';
  const needsSep = !baseDir.endsWith('/') && !baseDir.endsWith('\\');
  return `${baseDir}${needsSep ? sep : ''}${entry}`;
}

/**
 * file:// → ruta de disco. En Windows el URI es file:///C:/x y al quitar
 * el prefijo queda /C:/x: le recortamos la barra inicial.
 */
function normalizeEntryPath(line: string): string {
  if (!/^file:\/\//i.test(line)) return line;

  const withoutScheme = line.replace(/^file:\/\//i, '');
  let decoded = withoutScheme;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    // URI malformada: nos quedamos con el texto crudo.
  }
  return /^\/[a-zA-Z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
}
