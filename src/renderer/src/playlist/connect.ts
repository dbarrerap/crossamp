import type { PlaybackHooks } from '../state/PlayerController';
import { Store, type PlayerState, type Track } from '../state/store';
import type { PlaylistController } from './PlaylistController';
import { isM3UFileName } from './m3u';
import { resolvePlaylistFile, type BytesReader } from './materialize';

/**
 * Cableado playlist ⇄ transporte (Fase 2.1 — ajustes 2 y 3).
 *
 * Este es el ÚNICO punto donde ambas colecciones se conocen. El flujo:
 *
 *  1. Play sin pista cargada (req 3) → PlayerController pregunta por el
 *     hook onPlayEmpty → aquí cargamos el PRIMER item de la lista.
 *  2. Fin de pista natural (req 2, continuidad) → hook onTrackEnded →
 *     buscamos el item siguiente a playingId y lo cargamos. Como
 *     loadTrack() auto-playea, la lista avanza sola.
 *  3. Doble clic en un item → playItem(id) desde la UI de la playlist.
 *
 * Reglas de continuidad (decisiones de producto):
 *  - Fin de lista → para (no hay repeat).
 *  - Item ilegible (ruta faltante/permisos) → console.warn y se salta al
 *    siguiente legible; nunca rompe la cadena.
 *  - Quitar/Limpiar la lista no corta el audio en curso; al terminar esa
 *    pista, playingId ya no resuelve → no hay siguiente → para.
 *
 * Todo lo que toca bytes pasa por resolvePlaylistFile: items agregados con
 * File van directo; items de .m3u se leen por IPC recién al reproducir.
 */
export interface ConnectDeps {
  /**
   * Transporte mínimo que este conector necesita. PlayerController lo cumple
   * tal cual; en los tests se sustituye por un stub — así se valida la
   * orquestación (hooks, orden, continuidad) sin engine ni audio real.
   */
  player: TransportPlayer;
  playlist: PlaylistController;
  /** Lectura de disco (Electron). Sin él, solo se reproducen items con File. */
  readFile?: BytesReader;
}

export interface TransportPlayer {
  readonly store: Store<PlayerState>;
  setHooks(hooks: PlaybackHooks): void;
  loadTrack(track: Track): Promise<void>;
}

export interface PlaylistPlayback {
  /** Reproduce un item por id y queda como playingId. */
  playItem(id: string): Promise<boolean>;
  /**
   * "Open" del eject (en Winamp, getNewFile(clearlist=1)): reemplaza la
   * lista con el archivo — o con el contenido del .m3u si lo es — y
   * reproduce el primer item. Devuelve false si no hay nada reproducible.
   */
  openFile(file: File): Promise<boolean>;
}

export function connectPlaylistPlayback(deps: ConnectDeps): PlaylistPlayback {
  const { player, playlist, readFile } = deps;

  // Espejo para la UI del player: Play habilitado cuando hay lista aunque
  // no haya pista cargada. Sin esto, el botón queda disabled y el hook
  // onPlayEmpty nunca se invocaría.
  const syncCanStart = (): void => {
    player.store.set({
      canStartFromPlaylist: playlist.store.get().items.length > 0
    });
  };
  playlist.store.subscribe(syncCanStart);
  syncCanStart();

  /**
   * Carga y reproduce un item. Devuelve false si no era reproducible
   * (sin bytes ni ruta legible, o fallo de decodificación).
   */
  const playItemById = async (id: string): Promise<boolean> => {
    const item = playlist.store.get().items.find((entry) => entry.id === id);
    if (!item) return false;

    const file = await resolvePlaylistFile(item, readFile);
    if (!file) {
      console.warn(
        `[crossamp] no se pudo leer "${item.name}"${item.path ? ` (${item.path})` : ''} — se omite`
      );
      return false;
    }

    playlist.setPlaying(item.id);
    try {
      await player.loadTrack({ id: item.id, title: item.name, file });
      // La duración ya está medida por el engine: la guardamos en el item
      // para que el .m3u se guarde con segundos reales (estilo Winamp).
      const duration = player.store.get().duration;
      playlist.setDuration(item.id, duration > 0 ? duration : null);
      return true;
    } catch (err) {
      console.error(`[crossamp] error reproduciendo "${item.name}"`, err);
      // loadTrack dejó el player sin pista: playingId no apunta a nada
      // real, lo anulamos para no prometer continuidad.
      playlist.setPlaying(null);
      return false;
    }
  };

  player.setHooks({
    // Play con lista cargada y sin pista: desde el primer item (req 3).
    // Si el primero es ilegible, seguimos con los demás; si ninguno, false
    // → play() cae al engine como antes.
    onPlayEmpty: async () => {
      let item = playlist.firstItem();
      while (item) {
        if (await playItemById(item.id)) return true;
        item = playlist.nextOf(item.id);
      }
      return false;
    },

    // Fin de pista: siguiente de la lista (req 2). Los ilegibles se
    // saltan; playingId inexistente o último item → para.
    onTrackEnded: async () => {
      let id = playlist.store.get().playingId;
      while (id !== null) {
        const next = playlist.nextOf(id);
        if (!next) return; // fin de lista → para
        if (await playItemById(next.id)) return;
        id = next.id; // ilegible → probamos con el que sigue
      }
    }
  });

  /**
   * Abrir un archivo desde el eject: reemplaza la lista y arranca.
   *  - .m3u/.m3u8 → se carga como lista (rutas contra su directorio).
   *  - cualquier otro → la lista pasa a ser ese único archivo.
   * Es PlayList_delete + LoadPlaylist/append + BeginPlayback de Winamp
   * (Src/Winamp/OpenFileDialog.cpp).
   */
  const openFile = async (file: File): Promise<boolean> => {
    if (isM3UFileName(file.name)) {
      const text = await file.text();
      playlist.fromM3U(text, playlist.baseDirFor(file) ?? undefined);
    } else {
      playlist.replaceFiles([file]);
    }

    const first = playlist.firstItem();
    if (!first) return false;
    return playItemById(first.id);
  };

  return {
    playItem: playItemById,
    openFile
  };
}
