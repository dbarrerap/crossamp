import type { PlayerState } from '../state/store';
import type { PlayerController } from '../state/PlayerController';
import { seekKeyTarget } from './seek';
import { createIcon } from './icons';

/**
 * UI del player — piel Bento (Fase 3).
 *
 * Tarjeta con carátula (o placeholder), info de la pista, tiempo a los lados
 * del seek y transporte con iconos. La lógica es la misma de Fase 1/2: el
 * estado llega del store y la posición en vivo se lee con getPosition() en
 * un requestAnimationFrame (no se emite posición a 60 fps por el pub/sub).
 */
export function createPlayerUI(
  controller: PlayerController,
  deps?: {
    /**
     * "Eject"/Open: en Winamp abrir un archivo reemplaza la playlist con
     * ese archivo (o carga el .m3u) y reproduce. La UI delega; el cableado
     * vive en main.ts → connect.openFile.
     */
    openFile?: (file: File) => void;
  }
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'player';

  const store = controller.store;

  // --- Carátula + placeholder ---
  const art = document.createElement('div');
  art.className = 'player-art';

  const cover = document.createElement('img');
  cover.className = 'player-cover';
  cover.alt = '';
  cover.hidden = true;

  const artEmpty = document.createElement('div');
  artEmpty.className = 'player-art-empty';
  artEmpty.append(createIcon('note'));

  art.append(cover, artEmpty);

  // --- Titulo / artista / album ---
  const title = document.createElement('div');
  title.className = 'player-title';
  title.textContent = 'Sin pista';

  const subtitle = document.createElement('div');
  subtitle.className = 'player-subtitle';
  subtitle.textContent = '';

  const meta = document.createElement('div');
  meta.className = 'player-meta';
  meta.append(title, subtitle);

  // --- Progreso: tiempo a los lados + barra ---
  const time = document.createElement('div');
  time.className = 'player-time';
  const timeNow = document.createElement('span');
  timeNow.className = 'player-time-now';
  timeNow.textContent = '0:00';
  const timeTotal = document.createElement('span');
  timeTotal.className = 'player-time-total';
  timeTotal.textContent = '0:00';
  time.append(timeNow, timeTotal);

  const seek = document.createElement('input');
  seek.type = 'range';
  seek.min = '0';
  seek.max = '1';
  // "any": toda la resolución del tema; antes se mapeaba a 0..1000, así que
  // en un tema largo cada paso era > 1 s.
  seek.step = 'any';
  seek.value = '0';
  seek.className = 'player-seek';
  seek.setAttribute('aria-label', 'Posición');
  // true mientras el usuario arrastra el pulgar: solo hay preview, el seek
  // real se hace al soltar.
  let seeking = false;

  const progress = document.createElement('div');
  progress.className = 'player-progress';
  progress.append(time, seek);

  // --- Controles ---
  const controls = document.createElement('div');
  controls.className = 'player-controls';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'player-btn player-btn-primary';
  playBtn.append(createIcon('play'));
  playBtn.setAttribute('aria-label', 'Reproducir');
  playBtn.title = 'Reproducir';
  playBtn.addEventListener('click', () => controller.toggle());

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  // El eject abre audio o listas: elegir un .m3u lo carga como playlist.
  fileInput.accept = 'audio/*,.m3u,.m3u8';
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    // Reset para poder re-elegir el mismo archivo (p. ej. reabrir un .m3u).
    fileInput.value = '';
    if (!file) return;

    if (deps?.openFile) {
      deps.openFile(file);
      return;
    }

    // Sin conector (embed aislado): comportamiento previo, cargar directo.
    void controller
      .loadTrack({ id: crypto.randomUUID(), title: file.name, file })
      .catch((err) => {
        console.error('[crossamp] error cargando pista', err);
      });
  });

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'player-btn player-btn-open';
  openBtn.append(createIcon('eject'));
  openBtn.setAttribute('aria-label', 'Abrir archivo');
  openBtn.title = 'Abrir archivo…';
  openBtn.addEventListener('click', () => fileInput.click());

  // --- Volumen compacto, a la derecha del transporte ---
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.value = '100';
  volume.className = 'player-volume';
  volume.setAttribute('aria-label', 'Volumen');
  volume.style.setProperty('--volume-progress', '100%');
  volume.addEventListener('input', () => {
    controller.setVolume(Number(volume.value) / 100);
    volume.style.setProperty('--volume-progress', `${volume.value}%`);
  });

  const volumeIcon = document.createElement('span');
  volumeIcon.className = 'player-volume-icon';
  volumeIcon.append(createIcon('volume'));

  const volumeWrap = document.createElement('div');
  volumeWrap.className = 'player-volume-wrap';
  volumeWrap.append(volumeIcon, volume);

  const spacer = document.createElement('div');
  spacer.className = 'player-controls-spacer';

  controls.append(playBtn, openBtn, spacer, volumeWrap);

  el.append(art, meta, progress, controls, fileInput);

  // --- Utilidades de tiempo y progreso ---
  const fmt = (s: number): string => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const setTime = (pos: number, dur: number): void => {
    timeNow.textContent = fmt(pos);
    timeTotal.textContent = fmt(dur);
  };

  /** Relleno del track: la barra pinta el tramo escuchado en ámbar. */
  const setProgress = (pos: number, dur: number): void => {
    const pct = dur > 0 ? Math.max(0, Math.min(pos / dur, 1)) * 100 : 0;
    seek.style.setProperty('--seek-progress', `${pct}%`);
  };

  // --- Render desde el store (estado discreto) ---
  const render = (state: PlayerState): void => {
    const tags = state.metadata;

    // El titulo prioriza el tag; si no hay, cae al nombre del archivo.
    if (!state.currentTrack) {
      title.textContent = 'Sin pista';
      subtitle.textContent = '';
    } else if (state.isLoading) {
      title.textContent = `${state.currentTrack.title} (cargando…)`;
      subtitle.textContent = '';
    } else {
      title.textContent = tags?.title || state.currentTrack.title;
      // Subtitulo: artista — album, omitiendo lo que falte.
      subtitle.textContent = [tags?.artist, tags?.album]
        .filter((v): v is string => Boolean(v))
        .join(' — ');
    }

    // Caratula: object URL (blob:). Solo cambiamos si cambio la URL; el
    // dueño de revocarla es el controller, no la UI.
    const pic = state.currentTrack && !state.isLoading ? tags?.picture : null;
    if (pic) {
      if (cover.src !== pic) cover.src = pic;
      cover.hidden = false;
    } else {
      cover.removeAttribute('src');
      cover.hidden = true;
    }
    artEmpty.hidden = Boolean(pic);

    // Icono y nombre accesible según el estado (pause = ya suena).
    playBtn.replaceChildren(createIcon(state.isPlaying ? 'pause' : 'play'));
    const playLabel = state.isPlaying ? 'Pausar' : 'Reproducir';
    playBtn.setAttribute('aria-label', playLabel);
    playBtn.title = playLabel;

    // Habilitado si hay pista cargada, O si no la hay pero la playlist
    // está lista para arrancar desde su primer item (canStartFromPlaylist,
    // espejo que mantiene connectPlaylistPlayback).
    playBtn.disabled =
      state.isLoading ||
      (!state.currentTrack && !state.canStartFromPlaylist);
    seek.max = String(state.duration > 0 ? state.duration : 1);
    seek.disabled = !state.currentTrack || state.duration === 0;
  };
  store.subscribe(render);
  // Primer pintado: el Store no emite al suscribirse.
  render(store.get());

  // --- Seek ---
  /** Busca de verdad: recorta, mueve el pulgar y muestra el destino. */
  const applySeek = (seconds: number): void => {
    const dur = store.get().duration;
    if (dur <= 0) return;
    const target = Math.max(0, Math.min(seconds, dur));
    seek.value = String(target);
    controller.seek(target);
    setTime(target, dur);
    setProgress(target, dur);
  };

  // Arrastre: preview mientras se mueve; el seek real va al soltar.
  seek.addEventListener('pointerdown', () => {
    seeking = true;
  });
  seek.addEventListener('pointerup', () => {
    seeking = false;
    applySeek(Number(seek.value));
  });
  seek.addEventListener('pointercancel', () => {
    seeking = false;
  });
  seek.addEventListener('input', () => {
    const dur = store.get().duration;
    if (seeking) {
      // Preview: tiempo y relleno muestran el destino sin tocar el audio.
      const target = Number(seek.value);
      setTime(target, dur);
      setProgress(target, dur);
    } else {
      // Sin arrastre (p. ej. lector de pantalla): el input ES la búsqueda.
      applySeek(Number(seek.value));
    }
  });

  // Teclado: flechas ±5 s, Shift ±30 s, Home/End a los extremos.
  seek.addEventListener('keydown', (e) => {
    const target = seekKeyTarget(
      e.key,
      e.shiftKey,
      Number(seek.value),
      store.get().duration
    );
    if (target === null) return;
    e.preventDefault();
    applySeek(target);
  });

  // --- Bucle de posición en vivo (rAF) ---
  const tick = (): void => {
    // Mientras se arrastra manda el preview; no pisamos el pulgar.
    if (!seeking) {
      const pos = controller.getPosition();
      const dur = store.get().duration;
      setTime(pos, dur);
      if (dur > 0) {
        seek.value = String(pos);
        setProgress(pos, dur);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return el;
}
