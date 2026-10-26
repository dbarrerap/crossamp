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
  loadTrack(track: Track, options?: { autoplay?: boolean }): Promise<void>;
  seek(seconds: number): void;
  /** Gapless: decodifica la siguiente sin tocar la reproducción actual. */
  prepareNext(track: Track): Promise<boolean>;
  /** Gapless: agenda lo preparado al final exacto de la actual. */
  enqueuePrepared(): number;
  /** Gapless: descarta lo preparado y la cola agendada. */
  clearPrepared(): void;
}

export interface PlaylistPlayback {
  /** Reproduce un item por id y queda como playingId. */
  playItem(id: string): Promise<boolean>;
  /**
   * Carga un item EN PAUSA en la posición dada (restauración de sesión) y
   * lo deja como playingId. Así el player y la playlist quedan asociados:
   * la pista actual es el item y al terminar continúa la lista.
   */
  loadItem(id: string, options?: { position?: number }): Promise<boolean>;
  /**
   * "Open" del eject (en Winamp, getNewFile(clearlist=1)): reemplaza la
   * lista con el archivo — o con el contenido del .m3u si lo es — y
   * reproduce el primer item. Devuelve false si no hay nada reproducible.
   */
  openFile(file: File): Promise<boolean>;
  /**
   * Siguiente item (no envuelve, igual que el fin de lista natural).
   * Sin playingId arranca desde el primero. Salta ilegibles.
   */
  next(): Promise<boolean>;
  /** Item anterior; false si ya es el primero o no hay nada sonando. */
  previous(): Promise<boolean>;
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
   * Estado de la cadena gapless: qué item está preparado para sonar al
   * final del actual. `preparingFor` evita preparaciones concurrentes.
   */
  let plannedNextId: string | null = null;
  let preparingFor: string | null = null;

  const expectedNextId = (currentId: string | null): string | null =>
    currentId === null ? null : (playlist.nextOf(currentId)?.id ?? null);

  /**
   * Prepara y (si está sonando) agenda la siguiente pista. Salta items
   * ilegibles igual que el avance normal. Sin siguiente, limpia la cola.
   */
  const preloadNext = async (currentId: string | null): Promise<void> => {
    const expected = expectedNextId(currentId);
    if (plannedNextId === expected) return;
    if (preparingFor === currentId) return;
    if (currentId === null || expected === null) {
      plannedNextId = null;
      player.clearPrepared();
      return;
    }

    preparingFor = currentId;
    plannedNextId = null;
    try {
      let item = playlist.nextOf(currentId);
      while (item) {
        const file = await resolvePlaylistFile(item, readFile);
        if (file) {
          const ok = await player.prepareNext({
            id: item.id,
            title: item.name,
            file,
            path: item.path
          });
          if (ok) {
            plannedNextId = item.id;
            // Si está pausado, enqueuePrepared devuelve 0: el controller la
            // re-agenda al reanudar o después de un seek.
            player.enqueuePrepared();
            return;
          }
        } else {
          console.warn(
            `[crossamp] no se pudo precargar "${item.name}" — se omite`
          );
        }
        item = playlist.nextOf(item.id);
      }
    } catch (err) {
      console.warn('[crossamp] error precargando la siguiente pista', err);
    } finally {
      if (preparingFor === currentId) preparingFor = null;
    }
  };

  // Cambios de lista (quitar, ordenar, randomizar, cargar .m3u): si el
  // próximo ya no es el que estaba preparado, descartamos y re-planificamos.
  playlist.store.subscribe(() => {
    if (plannedNextId === null) return;
    const current = playlist.store.get().playingId;
    if (expectedNextId(current) !== plannedNextId) {
      plannedNextId = null;
      player.clearPrepared();
      if (current !== null) void preloadNext(current);
    }
  });

  /**
   * Carga un item desde la playlist, opcionalmente en pausa y en una
   * posición. Es la ÚNICA forma de cargar un item: así el player y la
   * playlist quedan asociados por el mismo id y `playingId` marca la pista
   * actual (continuidad incluida).
   */
  const loadItemInternal = async (
    id: string,
    options: { autoplay: boolean; position?: number }
  ): Promise<boolean> => {
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
    plannedNextId = null;
    try {
      await player.loadTrack(
        {
          id: item.id,
          title: item.name,
          file,
          path: item.path
        },
        { autoplay: options.autoplay }
      );
      // La duración ya está medida por el engine: la guardamos en el item
      // para que el .m3u se guarde con segundos reales (estilo Winamp).
      const duration = player.store.get().duration;
      playlist.setDuration(item.id, duration > 0 ? duration : null);

      if (options.position !== undefined && options.position > 0) {
        player.seek(options.position);
      }

      // Gapless: decodificamos la siguiente mientras suena esta.
      void preloadNext(item.id);
      return true;
    } catch (err) {
      console.error(`[crossamp] error reproduciendo "${item.name}"`, err);
      // loadTrack dejó el player sin pista: playingId no apunta a nada
      // real, lo anulamos para no prometer continuidad.
      playlist.setPlaying(null);
      return false;
    }
  };

  /** Reproduce un item (y queda como playingId). */
  const playItemById = (id: string): Promise<boolean> =>
    loadItemInternal(id, { autoplay: true });

  /** Carga un item EN PAUSA en su posición (restauración de sesión). */
  const loadItem = (
    id: string,
    options: { position?: number } = {}
  ): Promise<boolean> =>
    loadItemInternal(id, { autoplay: false, position: options.position });

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
    },

    // Gapless: el motor empalmó la siguiente. Movemos la playlist y
    // preparamos la siguiente de la siguiente.
    onTrackStarted: (track) => {
      plannedNextId = null;
      playlist.setPlaying(track.id);
      playlist.setDuration(track.id, player.store.get().duration);
      void preloadNext(track.id);
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

  /**
   * Siguiente: desde playingId; sin playingId, desde el primero. Los
   * ilegibles se saltan, igual que en el avance automático. En el último
   * item devuelve false (sin repeat).
   */
  const next = async (): Promise<boolean> => {
    const current = playlist.store.get().playingId;
    let item = current === null ? playlist.firstItem() : playlist.nextOf(current);
    while (item) {
      if (await playItemById(item.id)) return true;
      item = playlist.nextOf(item.id);
    }
    return false;
  };

  /** Anterior: solo si hay algo sonando y no es el primer item. */
  const previous = async (): Promise<boolean> => {
    const current = playlist.store.get().playingId;
    if (current === null) return false;
    let item = playlist.prevOf(current);
    while (item) {
      if (await playItemById(item.id)) return true;
      item = playlist.prevOf(item.id);
    }
    return false;
  };

  return {
    playItem: playItemById,
    loadItem,
    openFile,
    next,
    previous
  };
}
