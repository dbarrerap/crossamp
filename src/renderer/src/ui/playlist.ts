import type { PlaylistController } from '../playlist/PlaylistController';
import { parseID3 } from '../metadata/mp3';
import { resolvePlaylistFile, type BytesReader } from '../playlist/materialize';
import type { PlaylistItem, PlaylistState } from '../playlist/types';

/**
 * UI de la playlist — funcional, sin pulir (el aspecto Bento es Fase 3).
 *
 * Muestra la lista numerada y el menú de acciones de Fase 2.1 (agrupado
 * en un desplegable de la cabecera: agregar, cargar .m3u, quitar, limpiar,
 * guardar .m3u). Doble clic en un item lo reproduce (Ajuste 2), con la
 * lista como contexto de continuación.
 *
 * El I/O del .m3u vive AQUI, no en el controller: guardar usa File System
 * Access API (estándar web, funciona en Electron) con fallback a descarga
 * directa; cargar usa un <input type=file> y le pasamos el texto al
 * controller. Así el controller solo ve texto y sigue testeable sin
 * navegador.
 *
 * `deps.playItem` viene del conector de reproducción (connect.ts): la UI
 * no conoce al PlayerController, solo invoca la acción.
 */
export function createPlaylistUI(
  controller: PlaylistController,
  deps?: {
    playItem?: (id: string) => void;
    /** Lectura por IPC (Electron), para inspeccionar items de un .m3u. */
    readFile?: BytesReader;
  }
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'playlist';

  const store = controller.store;

  // --- Cabecera: título, contador y menú de acciones ---
  // Los 5 botones en fila no caben en 275px de ancho (al llegar "Limpiar"
  // se desbordaba la ventana) y la mezcla "Guardar/Cargar" prestaba a
  // confusión: todos son acciones sobre ESTA lista, así que van agrupados
  // en un desplegable de la cabecera.
  const header = document.createElement('div');
  header.className = 'playlist-header';

  const heading = document.createElement('div');
  heading.className = 'playlist-title';
  heading.textContent = 'Playlist';

  const count = document.createElement('div');
  count.className = 'playlist-count';
  count.textContent = '0';

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'playlist-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'Acciones de la playlist';
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.setAttribute('aria-expanded', 'false');

  const headerRight = document.createElement('div');
  headerRight.className = 'playlist-header-right';
  headerRight.append(count, menuBtn);

  header.append(heading, headerRight);

  // --- Menú desplegable ---
  const menu = document.createElement('div');
  menu.className = 'playlist-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const setMenuOpen = (open: boolean): void => {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
  };

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen(menu.hidden);
  });

  // Cierre estándar de menú: clic fuera (los items se cierran solos al
  // ejecutarse) y Escape devuelve el foco al disparador.
  document.addEventListener('click', (e) => {
    const target = e.target as Node | null;
    if (menu.hidden || !target) return;
    if (!menu.contains(target) && !headerRight.contains(target)) setMenuOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setMenuOpen(false);
      menuBtn.focus();
    }
  });

  /** Ítem del menú: cierra el menú y ejecuta la acción. */
  const menuItem = (label: string, action: () => void): HTMLButtonElement => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'playlist-menu-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.addEventListener('click', () => {
      setMenuOpen(false);
      action();
    });
    menu.append(item);
    return item;
  };

  const menuSeparator = (): void => {
    const sep = document.createElement('div');
    sep.className = 'playlist-menu-sep';
    sep.setAttribute('role', 'separator');
    menu.append(sep);
  };

  // --- Lista ---
  const list = document.createElement('ol');
  list.className = 'playlist-list';

  const emptyMsg = document.createElement('div');
  emptyMsg.className = 'playlist-empty';
  emptyMsg.textContent = 'Vacía — agrega archivos o carga un .m3u';

  // --- Inputs ocultos (disparados desde los ítems del menú) ---
  const addInput = document.createElement('input');
  addInput.type = 'file';
  addInput.accept = 'audio/*';
  addInput.multiple = true;
  addInput.hidden = true;
  addInput.addEventListener('change', () => {
    const files = addInput.files;
    if (files && files.length > 0) controller.addFiles(files);
    // Reset para poder re-elegir los mismos archivos en otra ocasión.
    addInput.value = '';
  });

  const loadInput = document.createElement('input');
  loadInput.type = 'file';
  loadInput.accept = '.m3u,.m3u8';
  loadInput.hidden = true;
  loadInput.addEventListener('change', () => {
    const file = loadInput.files?.[0];
    loadInput.value = '';
    if (!file) return;
    void loadPlaylist(controller, file).catch((err) => {
      console.error('[crossamp] error cargando playlist', err);
    });
  });

  // Info de la pista (estilo Winamp Alt+3): inspecciona la SELECCIÓN sin
  // reproducirla. El atajo usa e.code (en macOS Alt+3 escribe '£', pero la
  // tecla física sigue siendo Digit3).
  const openInfo = (): void => {
    const { selectedId, items } = store.get();
    const item = selectedId ? (items.find((entry) => entry.id === selectedId) ?? null) : null;
    if (!item) return;
    void showTrackInfo(item, deps?.readFile);
  };
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.code === 'Digit3' || e.code === 'Numpad3')) {
      e.preventDefault();
      openInfo();
    }
  });

  // --- Ítems del menú, en 2 grupos ---
  // Grupo 1: manejo directo de archivos/ítems — agrega y quita lo marcado.
  menuItem('Agregar archivos…', () => addInput.click());
  const removeBtn = menuItem('Quitar seleccionado', () => controller.removeSelected());
  menuSeparator();
  // Grupo 2: administración del playlist — persistirlo o vaciarlo.
  menuItem('Guardar .m3u…', () => {
    void savePlaylist(controller).catch((err) => {
      console.error('[crossamp] error guardando playlist', err);
    });
  });
  menuItem('Cargar .m3u…', () => loadInput.click());
  const clearBtn = menuItem('Limpiar lista', () => controller.clear());
  clearBtn.title = 'Vacía la lista (no detiene la pista en reproducción)';
  menuSeparator();
  // Grupo aparte: inspección — no muta la lista ni la persiste.
  const infoBtn = menuItem('Info de la pista…', openInfo);

  el.append(header, menu, emptyMsg, list, addInput, loadInput);

  let lastScrolledPlayingId: string | null = null;

  // --- Render desde el store ---
  const render = (state: PlaylistState): void => {
    count.textContent = String(state.items.length);
    emptyMsg.hidden = state.items.length > 0;
    removeBtn.disabled = state.selectedId === null;
    clearBtn.disabled = state.items.length === 0;
    infoBtn.disabled = state.selectedId === null;

    list.replaceChildren(
      ...state.items.map((item) => {
        const li = document.createElement('li');
        li.className = 'playlist-item';
        if (item.id === state.selectedId) li.classList.add('selected');
        if (item.id === state.playingId) li.classList.add('playing');

        const name = document.createElement('span');
        name.className = 'playlist-item-name';
        name.textContent = item.name;
        li.append(name);

        // Duración solo si la conocemos (medida al reproducir o traída del
        // .m3u). Desconocida = sin número en la lista y -1 en el archivo.
        if (item.duration !== null && item.duration > 0) {
          const dur = document.createElement('span');
          dur.className = 'playlist-item-dur';
          dur.textContent = formatDuration(item.duration);
          li.append(dur);
        }

        li.title = item.path ?? item.name;
        li.addEventListener('click', () => controller.select(item.id));
        // Doble clic = reproducir este item y continuar con la lista
        // (Ajuste 2). El clic simple de arriba también dispara la selección,
        // lo cual es inocuo: mientras suena, el item queda seleccionado.
        li.addEventListener('dblclick', () => deps?.playItem?.(item.id));
        return li;
      })
    );

    // Auto-scroll: la lista sigue al item sonando. Solo cuando CAMBIA
    // playingId — si no, cada clic de selección movería la vista.
    if (state.playingId !== lastScrolledPlayingId) {
      lastScrolledPlayingId = state.playingId;
      if (state.playingId !== null) {
        const idx = state.items.findIndex((entry) => entry.id === state.playingId);
        const li = list.children[idx] as HTMLLIElement | undefined;
        li?.scrollIntoView({ block: 'nearest' });
      }
    }
  };
  store.subscribe(render);
  // Primer pintado: el Store no emite al suscribirse.
  render(store.get());

  return el;
}

/** Formato m:ss para la duración mostrada junto a cada item. */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Info de la pista (estilo Winamp Alt+3): lee los tags del item SIN
 * reproducirlo. Si el item no tiene bytes en memoria (vino de un .m3u) los
 * lee por IPC — el punto de inflexión de esta feature. Abre un diálogo
 * ligero con lo que el parser encuentre; un tag ausente o corrupto se
 * muestra como "—" sin tumbar el diálogo.
 */
async function showTrackInfo(item: PlaylistItem, readFile?: BytesReader): Promise<void> {
  const overlay = document.createElement('div');
  overlay.className = 'info-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Info de la pista');

  const panel = document.createElement('div');
  panel.className = 'info-panel';

  const heading = document.createElement('div');
  heading.className = 'info-heading';
  heading.textContent = 'Info de la pista';

  const rows = document.createElement('div');
  rows.className = 'info-rows';
  const values = new Map<string, HTMLElement>();
  const setValue = (label: string, text: string): void => {
    const el = values.get(label);
    if (!el) return;
    el.textContent = text;
    el.title = text;
  };
  for (const label of ['Título', 'Artista', 'Álbum', 'Archivo']) {
    const row = document.createElement('div');
    row.className = 'info-row';
    const key = document.createElement('span');
    key.className = 'info-key';
    key.textContent = label;
    const val = document.createElement('span');
    val.className = 'info-val';
    val.textContent = '…';
    row.append(key, val);
    rows.append(row);
    values.set(label, val);
  }
  setValue('Archivo', item.name);

  const note = document.createElement('div');
  note.className = 'info-note';
  note.hidden = true;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'info-close';
  closeBtn.textContent = 'Cerrar';

  panel.append(heading, rows, note, closeBtn);
  overlay.append(panel);

  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  closeBtn.focus();

  try {
    const file = await resolvePlaylistFile(item, readFile);
    if (!file) throw new Error('no se pudo leer el archivo');
    const tags = parseID3(await file.arrayBuffer(), file.name);
    setValue('Título', tags.title ?? '—');
    setValue('Artista', tags.artist ?? '—');
    setValue('Álbum', tags.album ?? '—');
    if (!tags.title && !tags.artist && !tags.album) {
      note.textContent = 'Sin etiquetas ID3: al reproducir se usará el nombre del archivo.';
      note.hidden = false;
    }
  } catch (err) {
    setValue('Título', '—');
    setValue('Artista', '—');
    setValue('Álbum', '—');
    note.textContent = `No se pudo leer: ${err instanceof Error ? err.message : String(err)}`;
    note.hidden = false;
  }
}

/**
 * Guarda el .m3u. File System Access API muestra el diálogo nativo "Guardar
 * como"; si no existe (navegador sin soporte), fallback a <a download>.
 * Cancelar el diálogo lanza AbortError: no es un error, se ignora.
 */
async function savePlaylist(controller: PlaylistController): Promise<void> {
  const text = controller.toM3U();
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<{
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    }
  ).showSaveFilePicker;

  if (!picker) {
    const blob = new Blob([text], { type: 'audio/x-mpegurl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'playlist.m3u';
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  try {
    const handle = await picker({
      suggestedName: 'playlist.m3u',
      types: [
        {
          description: 'Playlist M3U',
          accept: { 'audio/x-mpegurl': ['.m3u', '.m3u8'] }
        }
      ]
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([text], { type: 'audio/x-mpegurl' }));
    await writable.close();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    throw err;
  }
}

/**
 * Carga un .m3u elegido por el usuario. La ruta del propio .m3u (si el
 * resolvePath la conoce, p.ej. Electron) define baseDir para resolver
 * entradas relativas; en navegador no hay baseDir y se quedan tal cual.
 */
async function loadPlaylist(
  controller: PlaylistController,
  file: File
): Promise<void> {
  const text = await file.text();
  const baseDir = controller.baseDirFor(file);
  controller.fromM3U(text, baseDir ?? undefined);
}
