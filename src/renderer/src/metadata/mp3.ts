import { trackFromFilename } from './filename';
import type { EmbeddedPicture, ParsedTags } from './types';

/**
 * Parser de metadatos MP3 (ID3v2.3 / ID3v2.4 + fallback ID3v1).
 *
 * El alcance de Fase 1 es solo MP3. FLAC y OGG llegan en fases posteriores.
 *
 * Notas de formato:
 *  - El header del tag tiene tamaño SIEMPRE syncsafe (v2.3 y v2.4).
 *  - Los tamaños de FRAME son syncsafe solo en v2.4; en v2.3 son enteros
 *    big-endian normales. Es una diferencia clasica que rompe parsers.
 *  - Text frames (T***): primer byte = encoding (0=ISO-8859-1, 1=UTF-16+BOM,
 *    2=UTF-16BE, 3=UTF-8).
 *  - APIC: encoding + MIME (null-terminated) + picture type + descripcion
 *    (null-terminated, terminador de 2 bytes si encoding UTF-16) + imagen.
 *
 * Fallback de nombre (idea de cliamp): si se pasa `filename`, los huecos
 * que los tags dejan vacíos se rellenan desde "Artista - Título" del
 * nombre. Un tag válido NUNCA lo pisa el fallback.
 *
 * duration NO existe aqui: el parser no estima duracion (VBR es engañoso).
 * El AudioEngine la aporta exacta tras decodificar en `PlayerState.duration`.
 */

const MAX_TAG_SIZE = 20 * 1024 * 1024; // red de seguridad ante tags corruptos

function syncsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function bigEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

/** Decodifica texto segun el byte de encoding de ID3, limpiando nulos finales. */
function decodeText(encoding: number, bytes: Uint8Array): string {
  let value: string;

  switch (encoding) {
    case 0x00:
      value = new TextDecoder('iso-8859-1').decode(bytes);
      break;
    case 0x01: {
      // UTF-16 con BOM: detectamos endianness y descartamos el BOM.
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        value = new TextDecoder('utf-16le').decode(bytes.subarray(2));
      } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        value = new TextDecoder('utf-16be').decode(bytes.subarray(2));
      } else {
        value = new TextDecoder('utf-16le').decode(bytes);
      }
      break;
    }
    case 0x02:
      value = new TextDecoder('utf-16be').decode(bytes);
      break;
    case 0x03:
      value = new TextDecoder('utf-8').decode(bytes);
      break;
    default:
      value = new TextDecoder('iso-8859-1').decode(bytes);
  }

  // Quitar nulos de relleno y espacios sobrantes. Los frames de texto pueden
  // contener multiples valores separados por nulo; nos quedamos con el 1º.
  return value.replace(/\0.*$/s, '').trim();
}

/** Parsea el cuerpo de un frame APIC. */
function parseAPIC(body: Uint8Array): EmbeddedPicture | null {
  if (body.length < 5) return null;

  const encoding = body[0];

  // MIME null-terminated (siempre terminador de 1 byte).
  let i = 1;
  while (i < body.length && body[i] !== 0x00) i++;
  const mime = new TextDecoder('ascii').decode(body.subarray(1, i)) || 'image/jpeg';
  i++; // saltar el nulo

  if (i >= body.length) return null;
  i++; // picture type

  // Descripcion null-terminated; el terminador es de 2 bytes si UTF-16.
  if (encoding === 0x01 || encoding === 0x02) {
    while (i + 1 < body.length && !(body[i] === 0x00 && body[i + 1] === 0x00)) {
      i += 2;
    }
    i += 2;
  } else {
    while (i < body.length && body[i] !== 0x00) i++;
    i += 1;
  }

  if (i >= body.length) return null;

  const data = body.subarray(i);
  if (data.length === 0) return null;

  // Copia (slice, no subarray): un subarray mantiene vivo TODO el
  // ArrayBuffer del MP3 (potencialmente MBs) mientras viva la carátula.
  return { mime, data: data.slice() };
}

/**
 * Parsea metadatos MP3 de un ArrayBuffer.
 * Nunca lanza: ante cualquier problema devuelve campos nulos.
 *
 * `filename` es opcional: si se pasa, los campos que los tags dejaron
 * vacíos se rellenan con el patrón "Artista - Título" del nombre (fallback
 * estilo cliamp). Un tag con valor no se pisa nunca.
 */
export function parseID3(buffer: ArrayBuffer, filename?: string): ParsedTags {
  const result: ParsedTags = {
    title: null,
    artist: null,
    album: null,
    picture: null
  };

  try {
    const view = new Uint8Array(buffer);
    if (!parseID3v2(view, result)) {
      parseID3v1(view, result);
    }
  } catch {
    // Metadatos son best-effort: un tag corrupto no debe romper la carga.
  }

  // Rellenar SOLO huecos desde el nombre del archivo.
  if (filename) {
    const fromName = trackFromFilename(filename);
    if (!result.title) result.title = fromName.title;
    if (!result.artist) result.artist = fromName.artist;
  }

  return result;
}

/** Intenta ID3v2. Devuelve true si encontró y procesó un tag v2. */
function parseID3v2(view: Uint8Array, out: ParsedTags): boolean {
  if (view.length < 10) return false;
  if (view[0] !== 0x49 || view[1] !== 0x44 || view[2] !== 0x33) return false; // "ID3"

  const major = view[3];
  const flags = view[5];
  const tagSize = syncsafe(view, 6);

  if (tagSize <= 0 || tagSize > MAX_TAG_SIZE) return false;

  const tagEnd = Math.min(10 + tagSize, view.length);
  let offset = 10;

  // Extended header: saltarlo si la bandera esta puesta.
  if (flags & 0x40) {
    if (major >= 4) {
      offset += syncsafe(view, offset);
    } else {
      const extSize = bigEndian(view, offset);
      offset += extSize + 4;
    }
  }

  const sizeBytes = 4;

  while (offset + sizeBytes + 2 <= tagEnd) {
    // Fin de frames: encontramos padding (nulos).
    if (view[offset] === 0x00) break;

    const id = new TextDecoder('ascii').decode(view.subarray(offset, offset + 4));
    const size =
      major >= 4 ? syncsafe(view, offset + 4) : bigEndian(view, offset + 4);

    if (size <= 0 || offset + 10 + size > tagEnd) break;

    const body = view.subarray(offset + 10, offset + 10 + size);

    if (id === 'TIT2') {
      out.title = decodeText(body[0], body.subarray(1)) || out.title;
    } else if (id === 'TPE1') {
      out.artist = decodeText(body[0], body.subarray(1)) || out.artist;
    } else if (id === 'TALB') {
      out.album = decodeText(body[0], body.subarray(1)) || out.album;
    } else if (id === 'APIC' && out.picture === null) {
      // Primera carátula que encontremos gana.
      out.picture = parseAPIC(body);
    }

    offset += 10 + size;
  }

  return true;
}

/** Fallback ID3v1: ultimos 128 bytes, magic "TAG". */
function parseID3v1(view: Uint8Array, out: ParsedTags): void {
  if (view.length < 128) return;

  const tail = view.subarray(view.length - 128);
  if (tail[0] !== 0x54 || tail[1] !== 0x41 || tail[2] !== 0x47) return; // "TAG"

  const field = (start: number, end: number): string =>
    new TextDecoder('iso-8859-1').decode(tail.subarray(start, end))
      .replace(/\0.*$/s, '')
      .trim();

  out.title = out.title || field(3, 33) || null;
  out.artist = out.artist || field(33, 63) || null;
  out.album = out.album || field(63, 93) || null;
}
