import { Store } from '../state/store';
import {
  displayNameFromPath,
  dirnameOf,
  parseM3U,
  resolveEntryPath,
  serializeM3U
} from './m3u';
import { initialPlaylistState, type PlaylistItem, type PlaylistState } from './types';

/**
 * Resuelve la ruta absoluta en disco de un File elegido por el usuario.
 * En Electron: webUtils.getPathForFile (vía el preload). En navegador:
 * no existe y devuelve null (el guardado del .m3u se degrada).
 */
export type PathResolver = (file: File) => string | null;

/**
 * Controller de la playlist — puente entre los items y el Store, igual que
 * PlayerController pero para la colección. Fase 2.1: agregar/quitar/
 * limpiar, guardar/cargar .m3u. La reproducción en sí NO vive aquí: la
 * orquesta connectPlaylistPlayback (playlist ⇄ transporte).
 *
 * Reglas:
 *  - Store<PlaylistState> con el mismo pub/sub inmutable que el player.
 *  - `playingId` es el item en reproducción: lo marca la UI y permite
 *    saber cuál es el siguiente al terminar la pista.
 *  - Los items cargados desde .m3u traen file: null: una lista no se volca
 *    a RAM entera; sus bytes se leen por IPC al reproducir (materialize.ts).
 *  - El I/O de archivos (.m3u) NO vive aquí: este controller solo
 *    serializa/parsea texto. La UI decide cómo escribirlo/leerlo (File
 *    System Access API con fallback), así el controller sigue siendo
 *    testeable sin navegador ni Electron.
 */
export class PlaylistController {
  readonly store: Store<PlaylistState>;
  private resolvePath: PathResolver;

  constructor(resolvePath: PathResolver = () => null) {
    this.store = new Store<PlaylistState>(initialPlaylistState);
    this.resolvePath = resolvePath;
  }

  /** Agrega archivos elegidos por el usuario. Conserva los items actuales. */
  addFiles(files: Iterable<File>): void {
    const added = this.toItems(files);
    if (added.length === 0) return;
    this.store.set({ items: [...this.store.get().items, ...added] });
  }

  /**
   * Reemplaza la lista con los archivos dados (el "Open" del eject en
   * Winamp: abrir un archivo crea una lista de ese archivo). Devuelve los
   * items creados; vacío si no se pasó ningún archivo.
   */
  replaceFiles(files: Iterable<File>): PlaylistItem[] {
    const items = this.toItems(files);
    if (items.length === 0) return [];
    this.store.set({ items, selectedId: null, playingId: null });
    return items;
  }

  private toItems(files: Iterable<File>): PlaylistItem[] {
    const items: PlaylistItem[] = [];
    for (const file of files) {
      items.push({
        id: crypto.randomUUID(),
        name: displayNameFromPath(file.name),
        file,
        path: this.resolvePath(file),
        duration: null
      });
    }
    return items;
  }

  /** Selecciona un item (objetivo de quitar). null = deseleccionar. */
  select(id: string | null): void {
    const { items } = this.store.get();
    if (id !== null && !items.some((item) => item.id === id)) return;
    this.store.set({ selectedId: id });
  }

  /** Quita el item seleccionado. Sin selección, no hace nada. */
  removeSelected(): void {
    const { items, selectedId, playingId } = this.store.get();
    if (selectedId === null) return;
    const remaining = items.filter((item) => item.id !== selectedId);
    // Tras quitar, la selección salta al siguiente (o al anterior si
    // quitamos el último): así se pueden borrar varios seguidos sin
    // re-seleccionar cada vez.
    const removedIdx = items.findIndex((item) => item.id === selectedId);
    const nextSelected =
      remaining.length === 0
        ? null
        : (remaining[Math.min(removedIdx, remaining.length - 1)]?.id ?? null);
    // Si quitamos el item que está sonando, la pista sigue (no cortamos
    // audio), pero playingId se anula: al terminar no habrá siguiente.
    const nextPlaying =
      playingId !== null && remaining.some((item) => item.id === playingId)
        ? playingId
        : null;
    this.store.set({ items: remaining, selectedId: nextSelected, playingId: nextPlaying });
  }

  /**
   * Vacía la lista completa. NO detiene la reproducción en curso (estilo
   * Winamp): la pista actual sigue sonando hasta terminar. Con la lista
   * vacía no hay dónde avanzar (playingId queda null), así que al terminar
   * el transporte para.
   */
  clear(): void {
    if (this.store.get().items.length === 0) return;
    this.store.set({ items: [], selectedId: null, playingId: null });
  }

  /**
   * Ordena la lista por nombre visible o por ruta. La selección y el
   * playingId son ids, así que sobreviven al cambio de orden.
   */
  sortBy(by: 'name' | 'path'): void {
    const { items } = this.store.get();
    if (items.length < 2) return;

    const collator = new Intl.Collator('es', {
      sensitivity: 'base',
      numeric: true
    });
    const key = (item: PlaylistItem): string =>
      by === 'path' ? (item.path ?? item.name) : item.name;

    const sorted = [...items].sort((a, b) => collator.compare(key(a), key(b)));
    this.store.set({ items: sorted });
  }

  /** Invierte el orden actual de la lista. */
  reverse(): void {
    const { items } = this.store.get();
    if (items.length < 2) return;
    this.store.set({ items: [...items].reverse() });
  }

  /**
   * Baraja la lista (Fisher-Yates) — distinto del shuffle de reproducción.
   * `rng` es inyectable para poder testear un orden determinista.
   */
  randomize(rng: () => number = Math.random): void {
    const { items } = this.store.get();
    if (items.length < 2) return;

    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    this.store.set({ items: shuffled });
  }

  /** Primer item de la lista (entrada de "Play" con lista cargada). */
  firstItem(): PlaylistItem | null {
    return this.store.get().items[0] ?? null;
  }

  /** Item que sigue a `id` en la lista, o null si era el último. */
  nextOf(id: string): PlaylistItem | null {
    const { items } = this.store.get();
    const idx = items.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    return items[idx + 1] ?? null;
  }

  /** Item anterior a `id`, o null si era el primero. */
  prevOf(id: string): PlaylistItem | null {
    const { items } = this.store.get();
    const idx = items.findIndex((item) => item.id === id);
    if (idx <= 0) return null;
    return items[idx - 1] ?? null;
  }

  /**
   * Marca el item que suena. Si el id ya no está en la lista (se quitó o
   * la lista se reemplazó), queda null y la reproducción actual sigue sin
   * continuidad.
   */
  setPlaying(id: string | null): void {
    const { items, playingId } = this.store.get();
    const next =
      id === null ? null : items.some((item) => item.id === id) ? id : null;
    if (next === playingId) return;
    this.store.set({ playingId: next });
  }

  /**
   * Reemplaza la lista con items restaurados de una sesión anterior. Solo
   * entran los que tienen ruta: un item sin ruta no tiene bytes recuperables
   * al reiniciar la app. No marca nada como sonando.
   */
  restore(
    entries: readonly { name: string; path: string | null; duration: number | null }[]
  ): void {
    const items: PlaylistItem[] = [];
    for (const entry of entries) {
      if (!entry.path) continue;
      items.push({
        id: crypto.randomUUID(),
        name: entry.name,
        file: null,
        path: entry.path,
        duration: entry.duration
      });
    }
    if (items.length === 0) return;
    this.store.set({ items, selectedId: null, playingId: null });
  }

  /** Serializa la playlist a texto .m3u (UTF-8). */
  toM3U(): string {
    return serializeM3U(
      this.store.get().items.map((item) => ({
        // Sin ruta conocida (navegador), escribimos el nombre del archivo:
        // al menos es un marcador legible en el .m3u.
        path: item.path ?? item.name,
        title: item.name,
        // Duración medida (o la que traía el .m3u); null → -1 en el archivo.
        duration: item.duration
      }))
    );
  }

  /**
   * Reemplaza la playlist por la de un .m3u parseado. `baseDir` es el
   * directorio del propio .m3u, para resolver rutas relativas (Winamp
   * resuelve contra la ubicación del playlist).
   */
  fromM3U(text: string, baseDir?: string): void {
    const entries = parseM3U(text);
    const items: PlaylistItem[] = entries.map((entry) => {
      const path = resolveEntryPath(entry.path, baseDir);
      return {
        id: crypto.randomUUID(),
        name: entry.title ?? displayNameFromPath(path),
        file: null,
        path,
        // Duración que traía el propio .m3u (informativa); al reproducir
        // se reemplaza por la medida por el engine.
        duration: entry.duration ?? null
      };
    });
    this.store.set({ items, selectedId: null, playingId: null });
  }

  /**
   * Guarda la duración medida (por el engine) en un item. Solo cambia ese
   * item y emite; el orden y todo lo demás quedan intactos.
   */
  setDuration(id: string, duration: number | null): void {
    const { items } = this.store.get();
    const idx = items.findIndex((item) => item.id === id);
    if (idx < 0) return;
    const item = items[idx];
    if (item.duration === duration) return;
    const next = [...items];
    next[idx] = { ...item, duration };
    this.store.set({ items: next });
  }

  /**
   * Directorio del .m3u elegido por el usuario, como base para resolver
   * rutas relativas. null si la ruta del archivo es desconocida (navegador).
   */
  baseDirFor(file: File): string | null {
    const path = this.resolvePath(file);
    return path ? dirnameOf(path) : null;
  }
}
