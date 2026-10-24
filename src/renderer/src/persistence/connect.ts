/**
 * Orquestación de la sesión: guardar el estado al cambiar y restaurarlo al
 * arrancar. Único punto donde la persistencia conoce a los controllers —
 * igual que playlist/connect.ts lo es para playlist ⇄ transporte.
 *
 * Guardado:
 *  - Cambios discretos de cualquiera de los dos stores → debounced.
 *  - Posición: cada 5 s mientras suena y al cerrar la ventana.
 *
 * Restauración:
 *  - Lista: items con ruta (los de memoria no sobreviven).
 *  - Última pista EN PAUSA en su posición (autoplay: false): el primer Play
 *    continúa donde quedó. Sin ruta o sin IPC (navegador) no se restaura.
 */
import { basenameOfPath } from '../playlist/m3u';
import type { PlaylistController } from '../playlist/PlaylistController';
import type { BytesReader } from '../playlist/materialize';
import type { PlayerController } from '../state/PlayerController';
import { buildSession, type PersistedSession, type PersistedTrack } from './session';
import {
  debounce,
  loadSession,
  saveSession,
  type StorageLike
} from './storage';

/** Cada cuánto se persiste la posición mientras suena (ms). */
const POSITION_SAVE_INTERVAL_MS = 5000;

/** Espera antes de escribir tras un cambio de estado (ms). */
const SAVE_DEBOUNCE_MS = 250;

export interface SessionDeps {
  player: PlayerController;
  playlist: PlaylistController;
  storage: StorageLike;
  /** Lectura de bytes por IPC (Electron). Sin esto no se restaura la pista. */
  readFile?: BytesReader;
  /** Ruta real de un File (Electron); null/undefined en navegador. */
  resolvePath?: (file: File) => string | null;
}

export interface SessionPersistence {
  /** Escribe ahora (lo usan el cierre de ventana y los tests). */
  flush(): void;
  dispose(): void;
}

/** Empieza a persistir la sesión. Devuelve un handle para forzar/terminar. */
export function connectSessionPersistence(deps: SessionDeps): SessionPersistence {
  const snapshot = (): PersistedSession => {
    const track = deps.player.store.get().currentTrack;
    let last: PersistedTrack | null = null;

    if (track) {
      // Si la pista vino de la lista, su item ya trae la ruta; si se abrió
      // suelta desde el player, hay que resolverla desde el File.
      const item =
        deps.playlist.store.get().items.find((entry) => entry.id === track.id) ??
        null;
      const path = item?.path ?? deps.resolvePath?.(track.file) ?? null;
      if (path) {
        last = {
          name: item?.name ?? track.title,
          path,
          position: deps.player.getPosition()
        };
      }
    }

    return buildSession(deps.playlist.store.get().items, last);
  };

  const save = (): void => {
    saveSession(deps.storage, snapshot());
  };
  const saveSoon = debounce(save, SAVE_DEBOUNCE_MS);

  const unsubscribePlaylist = deps.playlist.store.subscribe(saveSoon);
  const unsubscribePlayer = deps.player.store.subscribe(saveSoon);

  const interval = setInterval(() => {
    if (deps.player.store.get().isPlaying) save();
  }, POSITION_SAVE_INTERVAL_MS);

  const onBeforeUnload = (): void => save();
  window.addEventListener('beforeunload', onBeforeUnload);

  return {
    flush: save,
    dispose(): void {
      unsubscribePlaylist();
      unsubscribePlayer();
      clearInterval(interval);
      window.removeEventListener('beforeunload', onBeforeUnload);
    }
  };
}

/**
 * Restaura la sesión guardada. Devuelve true si había algo que restaurar.
 * Nunca lanza: una sesión corrupta o un archivo movido se ignoran.
 */
export async function restoreSession(deps: SessionDeps): Promise<boolean> {
  const session = loadSession(deps.storage);
  if (!session) return false;

  if (session.playlist.length > 0) deps.playlist.restore(session.playlist);

  const last = session.last;
  if (!last || !deps.readFile) return true;

  try {
    const bytes = await deps.readFile(last.path);
    if (!bytes) return true; // archivo movido/borrado: la lista queda igual

    const file = new File(
      [bytes as Uint8Array<ArrayBuffer>],
      basenameOfPath(last.path)
    );
    await deps.player.loadTrack(
      { id: crypto.randomUUID(), title: last.name, file },
      { autoplay: false }
    );
    if (last.position > 0) deps.player.seek(last.position);

    // La pista restaurada queda SELECCIONADA en la lista (no "sonando":
    // está en pausa, marcarla con ▶ mentiría).
    const match = deps.playlist.store
      .get()
      .items.find((item) => item.path === last.path);
    if (match) deps.playlist.select(match.id);

    return true;
  } catch (err) {
    console.warn('[crossamp] no se pudo restaurar la última pista', err);
    return true;
  }
}
