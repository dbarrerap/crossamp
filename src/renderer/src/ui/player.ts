import type { PlayerState } from '../state/store';
import type { PlayerController } from '../state/PlayerController';
import { seekKeyTarget } from './seek';

/**
 * UI del player — funcional, sin pulir visual.
 *
 * Esta es la capa de Fase 1: conecta controles reales al PlayerController
 * para que el reproductor funcione de punta a punta. El aspecto Bento
 * llega en la Fase 3 (feature/player-ui); aqui solo importa que funcione.
 *
 * La UI lee el estado del store via subscribe() y pinta. La posición en
 * vivo la lee con getPosition() en un bucle requestAnimationFrame, no del
 * store (evita emitir a 60fps por el pub/sub).
 */
export function createPlayerUI(controller: PlayerController): HTMLElement {
  const el = document.createElement('div');
  el.className = 'player';

  const store = controller.store;

  // --- Caratula ---
  const cover = document.createElement('img');
  cover.className = 'player-cover';
  cover.alt = '';
  cover.hidden = true;

  // --- Titulo / artista / album ---
  const title = document.createElement('div');
  title.className = 'player-title';
  title.textContent = 'Sin pista';

  const subtitle = document.createElement('div');
  subtitle.className = 'player-subtitle';
  subtitle.textContent = '';

  // --- Tiempo posicion / duracion ---
  const time = document.createElement('div');
  time.className = 'player-time';
  time.textContent = '0:00 / 0:00';

  // --- Barra de seek (en segundos: la precisión no depende del tema) ---
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

  // --- Controles ---
  const controls = document.createElement('div');
  controls.className = 'player-controls';

  const playBtn = document.createElement('button');
  playBtn.textContent = 'Play';
  playBtn.addEventListener('click', () => controller.toggle());

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/*';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void controller
      .loadTrack({ id: crypto.randomUUID(), title: file.name, file })
      .catch((err) => {
        console.error('[crossamp] error cargando pista', err);
      });
  });

  controls.append(playBtn, fileInput);

  // --- Volumen ---
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.value = '100';
  volume.className = 'player-volume';
  volume.addEventListener('input', () => {
    controller.setVolume(Number(volume.value) / 100);
  });

  el.append(cover, title, subtitle, time, seek, controls, volume);

  // --- Render desde el store (estado discreto) ---
  const render = (state: PlayerState): void => {
    const meta = state.metadata;

    // El titulo prioriza el tag; si no hay, cae al nombre del archivo.
    if (!state.currentTrack) {
      title.textContent = 'Sin pista';
      subtitle.textContent = '';
    } else if (state.isLoading) {
      title.textContent = `${state.currentTrack.title} (cargando…)`;
      subtitle.textContent = '';
    } else {
      title.textContent = meta?.title || state.currentTrack.title;
      // Subtitulo: artista — album, omitiendo lo que falte.
      subtitle.textContent = [meta?.artist, meta?.album]
        .filter((v): v is string => Boolean(v))
        .join(' — ');
    }

    // Caratula: object URL (blob:). Solo cambiamos si cambio la URL; el
    // dueño de revocarla es el controller, no la UI.
    const pic = state.currentTrack && !state.isLoading ? meta?.picture : null;
    if (pic) {
      if (cover.src !== pic) cover.src = pic;
      cover.hidden = false;
    } else {
      cover.removeAttribute('src');
      cover.hidden = true;
    }

    playBtn.textContent = state.isPlaying ? 'Pause' : 'Play';
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
  const fmt = (s: number): string => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  /** Busca de verdad: recorta, mueve el pulgar y muestra el destino. */
  const applySeek = (seconds: number): void => {
    const dur = store.get().duration;
    if (dur <= 0) return;
    const target = Math.max(0, Math.min(seconds, dur));
    seek.value = String(target);
    controller.seek(target);
    time.textContent = `${fmt(target)} / ${fmt(dur)}`;
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
    if (seeking) {
      // Preview: la etiqueta muestra el destino sin tocar el audio.
      const dur = store.get().duration;
      time.textContent = `${fmt(Number(seek.value))} / ${fmt(dur)}`;
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
      time.textContent = `${fmt(pos)} / ${fmt(dur)}`;
      if (dur > 0) seek.value = String(pos);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return el;
}
