import type { PlayerController } from '../state/PlayerController';

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

  // --- Barra de seek ---
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.min = '0';
  seek.max = '1000';
  seek.value = '0';
  seek.className = 'player-seek';
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
  store.subscribe((state) => {
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
    seek.disabled = !state.currentTrack || state.duration === 0;
  });

  // --- Seek: el usuario arrastra, soltamos al final ---
  seek.addEventListener('pointerdown', () => {
    seeking = true;
  });
  seek.addEventListener('pointerup', () => {
    seeking = false;
    const dur = store.get().duration;
    if (dur > 0) controller.seek((Number(seek.value) / 1000) * dur);
  });

  // --- Bucle de posición en vivo (rAF) ---
  const fmt = (s: number): string => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const tick = (): void => {
    const pos = controller.getPosition();
    const dur = store.get().duration;
    time.textContent = `${fmt(pos)} / ${fmt(dur)}`;
    if (!seeking && dur > 0) {
      seek.value = String(Math.round((pos / dur) * 1000));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return el;
}
