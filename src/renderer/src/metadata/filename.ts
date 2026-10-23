/**
 * Fallback de etiquetas desde el nombre del archivo.
 *
 * Inspirado en cliamp (`playlist.TrackFromFilename`): muchos ficheros no
 * traen tags (o traen huecos), y el nombre suele seguir el patrón
 * "Artista - Título". Reglas:
 *
 *  - El primer `" - "` separa artista y título (no el último).
 *  - Sin separador, el nombre entero (sin extensión) es el título.
 *  - Solo rellena huecos: quien aplique esto sobre tags reales debe
 *    respetar la regla "un tag válido nunca lo pisa el fallback".
 *
 * Best-effort: nunca devuelve cadenas vacías.
 */
export interface FilenameTags {
  artist: string | null;
  title: string;
}

export function trackFromFilename(filename: string): FilenameTags {
  // Sin ruta (defensa, File.name ya no la trae) y sin extensión final.
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const stem = base.replace(/\.[^.]+$/, '').trim() || base.trim();

  const sep = stem.indexOf(' - ');
  if (sep === -1) return { artist: null, title: stem };

  const artist = stem.slice(0, sep).trim();
  const title = stem.slice(sep + 3).trim();

  // Casos degenerados ("Artista - " con título vacío): mejor el nombre
  // entero que un título en blanco.
  if (title === '') return { artist: null, title: stem };

  return { artist: artist || null, title };
}
