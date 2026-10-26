import type { PlaylistController } from '../playlist/PlaylistController';
import { parseID3 } from '../metadata/mp3';
import { resolvePlaylistFile, type BytesReader } from '../playlist/materialize';
import type { PlaylistItem, PlaylistState } from '../playlist/types';
import type { TagEdit, TagWriteResult } from '../metadata/types';

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
    /** Escritura de tags (editor Alt+3): solo MP3 en disco. */
    writeTags?: (path: string, tags: TagEdit) => Promise<TagWriteResult>;
    /** Aviso tras guardar: el cableado actualiza playlist y player. */
    onTagsSaved?: (id: string, tags: TagEdit) => void;
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
    void showTrackInfo(item, deps);
  };
  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.code === 'Digit3' || e.code === 'Numpad3')) {
      e.preventDefault();
      openInfo();
    }
  });

  // --- Ítems del menú ---
  // Grupos: archivos/ítems · administración · orden · inspección.
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
  // Grupo 3: orden de la lista (no cambia qué suena).
  const sortName = menuItem('Ordenar por nombre', () => controller.sortBy('name'));
  const sortPath = menuItem('Ordenar por ruta', () => controller.sortBy('path'));
  const reverseBtn = menuItem('Invertir orden', () => controller.reverse());
  const randomBtn = menuItem('Aleatorio', () => controller.randomize());
  menuSeparator();
  // Grupo 4: inspección — no muta la lista ni la persiste.
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

    const canOrder = state.items.length > 1;
    sortName.disabled = !canOrder;
    sortPath.disabled = !canOrder;
    reverseBtn.disabled = !canOrder;
    randomBtn.disabled = !canOrder;

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

/** Dependencias del diálogo de info/edición (Alt+3). */
interface TrackInfoDeps {
  readFile?: BytesReader;
  writeTags?: (path: string, tags: TagEdit) => Promise<TagWriteResult>;
  onTagsSaved?: (id: string, tags: TagEdit) => void;
}

/**
 * Info de la pista / editor de tags (estilo Winamp File Info, Alt+3).
 *
 * Lee los tags SIN reproducir (bytes en memoria o IPC). Si el item es un MP3
 * con ruta en disco, los campos son editables y se guardan con writeTags;
 * en el resto de los casos el diálogo es de solo lectura con el motivo.
 */
async function showTrackInfo(
  item: PlaylistItem,
  deps?: TrackInfoDeps
): Promise<void> {
  const path = item.path;
  const writeTags = deps?.writeTags;
  const onTagsSaved = deps?.onTagsSaved;
  const editable = Boolean(
    path && /\.mp3$/i.test(path) && writeTags && onTagsSaved
  );

  const overlay = document.createElement('div');
  overlay.className = 'info-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Info de la pista');

  const panel = document.createElement('div');
  panel.className = 'info-panel';

  const heading = document.createElement('div');
  heading.className = 'info-heading';
  heading.textContent = editable ? 'Etiquetas de la pista' : 'Info de la pista';

  const rows = document.createElement('div');
  rows.className = 'info-rows';
  const values = new Map<string, HTMLElement>();
  const inputs = new Map<string, HTMLInputElement>();
  const fields = [
    { key: 'title', label: 'Título' },
    { key: 'artist', label: 'Artista' },
    { key: 'album', label: 'Álbum' }
  ] as const;

  for (const field of fields) {
    const row = document.createElement('div');
    row.className = 'info-row';
    const key = document.createElement('span');
    key.className = 'info-key';
    key.textContent = field.label;

    if (editable) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'info-input';
      input.maxLength = 512;
      input.setAttribute('aria-label', field.label);
      input.disabled = true; // hasta que termine la lectura
      row.append(key, input);
      inputs.set(field.key, input);
    } else {
      const val = document.createElement('span');
      val.className = 'info-val';
      val.textContent = '…';
      row.append(key, val);
      values.set(field.key, val);
    }
    rows.append(row);
  }

  // Archivo: siempre de solo lectura.
  const fileRow = document.createElement('div');
  fileRow.className = 'info-row';
  const fileKey = document.createElement('span');
  fileKey.className = 'info-key';
  fileKey.textContent = 'Archivo';
  const fileVal = document.createElement('span');
  fileVal.className = 'info-val';
  fileVal.textContent = item.name;
  fileVal.title = path ?? item.name;
  fileRow.append(fileKey, fileVal);
  rows.append(fileRow);

  const note = document.createElement('div');
  note.className = 'info-note';
  note.hidden = true;

  const setNote = (text: string, isError = false): void => {
    note.textContent = text;
    note.classList.toggle('info-error', isError);
    note.hidden = false;
  };

  const actions = document.createElement('div');
  actions.className = 'info-actions';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'info-close';
  closeBtn.textContent = 'Cerrar';

  const saveBtn = editable ? document.createElement('button') : null;
  if (saveBtn) {
    saveBtn.type = 'button';
    saveBtn.className = 'info-save';
    saveBtn.textContent = 'Guardar';
    saveBtn.disabled = true;
    actions.append(saveBtn, closeBtn);
  } else {
    actions.append(closeBtn);
  }

  panel.append(heading, rows, note, actions);
  overlay.append(panel);

  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  const save = async (): Promise<void> => {
    if (!saveBtn || !path || !writeTags) return;

    const tags: TagEdit = {
      title: inputs.get('title')?.value.trim() ?? '',
      artist: inputs.get('artist')?.value.trim() ?? '',
      album: inputs.get('album')?.value.trim() ?? ''
    };

    saveBtn.disabled = true;
    note.hidden = true;
    try {
      const result = await writeTags(path, tags);
      if (!result.ok) {
        setNote(
          `No se pudo guardar: ${result.error ?? 'error desconocido'}`,
          true
        );
        return;
      }

      onTagsSaved?.(item.id, tags);
      for (const field of fields) {
        const input = inputs.get(field.key);
        if (input) input.value = tags[field.key];
      }
      setNote('Guardado.');
    } catch (err) {
      setNote(
        `No se pudo guardar: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      saveBtn.disabled = false;
    }
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener('click', close);
  saveBtn?.addEventListener('click', () => {
    void save();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && editable) {
      e.preventDefault();
      void save();
    }
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  closeBtn.focus();

  if (!editable) {
    if (!path) {
      setNote('Edición no disponible: el item no tiene ruta en disco.');
    } else if (!/\.mp3$/i.test(path)) {
      setNote('Edición disponible solo para MP3 (ID3).');
    } else {
      setNote('Edición no disponible en este entorno.');
    }
  }

  try {
    const file = await resolvePlaylistFile(item, deps?.readFile);
    if (!file) throw new Error('no se pudo leer el archivo');
    const tags = parseID3(await file.arrayBuffer(), file.name);

    if (editable) {
      for (const field of fields) {
        const input = inputs.get(field.key);
        if (input) {
          input.value = tags[field.key] ?? '';
          input.disabled = false;
        }
      }
      if (saveBtn) saveBtn.disabled = false;
      return;
    }

    for (const field of fields) {
      const el = values.get(field.key);
      if (el) {
        const value = tags[field.key] ?? '—';
        el.textContent = value;
        el.title = value;
      }
    }

    if (!tags.title && !tags.artist && !tags.album) {
      const noTags = 'Sin etiquetas ID3: se usará el nombre del archivo.';
      note.textContent = note.hidden ? noTags : `${note.textContent} ${noTags}`;
      note.hidden = false;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (editable) {
      setNote(`No se pudo leer el archivo: ${message}`, true);
    } else {
      for (const field of fields) {
        const el = values.get(field.key);
        if (el) el.textContent = '—';
      }
      // En solo lectura, el motivo (sin ruta / no MP3) es más útil que el
      // error de lectura: solo lo mostramos si no había nota.
      if (note.hidden) setNote(`No se pudo leer: ${message}`, true);
    }
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
