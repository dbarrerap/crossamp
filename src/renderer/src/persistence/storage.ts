/**
 * Acceso a localStorage, aislado tras una interfaz mínima.
 *
 * Aislarlo permite:
 *  - probar con un storage falso (sin navegador), y
 *  - migrar a un archivo JSON en userData (IPC) sin tocar la lógica.
 *
 * Todo va con try/catch: un storage bloqueado o lleno no debe romper la app;
 * la sesión simplemente no persiste.
 */
import { SESSION_KEY, decodeSession, encodeSession, type PersistedSession } from './session';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadSession(storage: StorageLike): PersistedSession | null {
  try {
    return decodeSession(storage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

export function saveSession(storage: StorageLike, session: PersistedSession): void {
  try {
    storage.setItem(SESSION_KEY, encodeSession(session));
  } catch {
    // Sin storage disponible: la sesión no persiste y listo.
  }
}

export function clearSession(storage: StorageLike): void {
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    // idem
  }
}

/** Retrasa la escritura para no tocar el storage en cada emisión del store. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}
