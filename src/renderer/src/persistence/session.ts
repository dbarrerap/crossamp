/**
 * Sesión persistida en localStorage — esquema versionado y puro (sin I/O).
 *
 * Qué se guarda:
 *  - playlist: SOLO los items con ruta en disco. Un item agregado desde
 *    <input type=file> que no expuso ruta (navegador) no se puede recuperar
 *    al reiniciar: sus bytes vivían solo en memoria.
 *  - last: la última pista (de la lista o abierta suelta) y la posición del
 *    cursor. Al restaurar se carga EN PAUSA: Chromium no permite reproducir
 *    sin un gesto del usuario.
 *
 * El decodificador es tolerante: descarta items/pistas inválidos y devuelve
 * null si el JSON o la versión no son reconocibles. Así una sesión corrupta
 * nunca rompe el arranque.
 */
import type { PlaylistItem } from '../playlist/types';

export const SESSION_KEY = 'crossamp.session';
export const SESSION_VERSION = 1;

export interface PersistedItem {
  name: string;
  path: string;
  duration: number | null;
}

export interface PersistedTrack {
  name: string;
  path: string;
  position: number;
}

export interface PersistedSession {
  version: number;
  playlist: PersistedItem[];
  last: PersistedTrack | null;
}

/** Arma la sesión desde el estado vivo, descartando lo no recuperable. */
export function buildSession(
  items: readonly PlaylistItem[],
  last: PersistedTrack | null
): PersistedSession {
  const playlist: PersistedItem[] = [];
  for (const item of items) {
    if (typeof item.path !== 'string' || item.path.length === 0) continue;
    playlist.push({
      name: item.name,
      path: item.path,
      duration: item.duration
    });
  }
  return { version: SESSION_VERSION, playlist, last };
}

export function encodeSession(session: PersistedSession): string {
  return JSON.stringify(session);
}

export function decodeSession(raw: string | null): PersistedSession | null {
  if (raw === null || raw.length === 0) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeSession(data);
}

function normalizeSession(data: unknown): PersistedSession | null {
  if (!isRecord(data)) return null;
  if (data.version !== SESSION_VERSION) return null;

  const rawPlaylist = Array.isArray(data.playlist) ? data.playlist : [];
  const playlist: PersistedItem[] = [];
  for (const entry of rawPlaylist) {
    const item = normalizeItem(entry);
    if (item) playlist.push(item);
  }

  return {
    version: SESSION_VERSION,
    playlist,
    last: normalizeTrack(data.last)
  };
}

function normalizeItem(value: unknown): PersistedItem | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name : null;
  const path =
    typeof value.path === 'string' && value.path.length > 0 ? value.path : null;
  if (name === null || path === null) return null;

  const duration =
    typeof value.duration === 'number' &&
    Number.isFinite(value.duration) &&
    value.duration > 0
      ? value.duration
      : null;

  return { name, path, duration };
}

function normalizeTrack(value: unknown): PersistedTrack | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name : null;
  const path =
    typeof value.path === 'string' && value.path.length > 0 ? value.path : null;
  if (name === null || path === null) return null;

  const position =
    typeof value.position === 'number' &&
    Number.isFinite(value.position) &&
    value.position >= 0
      ? value.position
      : 0;

  return { name, path, position };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
