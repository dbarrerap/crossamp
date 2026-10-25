/**
 * Integración con el sistema operativo (Fase 2 del "desktop player"):
 * Now Playing + teclas multimedia vía MediaSession, y acciones/seek desde
 * los controles del sistema.
 *
 * Las teclas multimedia no se registran a mano: Chromium las enruta a
 * MediaSession cuando hay audio. Los atajos propios de la app viven en el
 * main (globalShortcut) y llegan por IPC.
 */
import type { PlaylistPlayback } from '../playlist/connect';
import type { PlayerController } from '../state/PlayerController';

/** Subconjunto de MediaSession que usamos (facilita inyectar un fake). */
export interface MediaSessionLike {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null
  ): void;
}

export interface MediaSessionDeps {
  player: PlayerController;
  playback: Pick<PlaylistPlayback, 'next' | 'previous'>;
  /** Inyectable para tests; por defecto `navigator.mediaSession`. */
  mediaSession?: MediaSessionLike;
  /** Inyectable para tests; por defecto `new MediaMetadata(...)`. */
  createMetadata?: (init: MediaMetadataInit) => MediaMetadata;
}

/** Paso de los botones de seek del sistema (segundos). */
const SEEK_STEP_SECONDS = 10;

export function connectMediaSession(deps: MediaSessionDeps): void {
  const session = deps.mediaSession ?? navigator.mediaSession;
  if (!session) return;

  const createMetadata =
    deps.createMetadata ?? ((init: MediaMetadataInit) => new MediaMetadata(init));

  const update = (): void => {
    const state = deps.player.store.get();

    session.playbackState = state.isPlaying
      ? 'playing'
      : state.currentTrack
        ? 'paused'
        : 'none';

    const track = state.currentTrack;
    if (!track) {
      session.metadata = null;
      return;
    }

    const meta = state.metadata;
    session.metadata = createMetadata({
      title: meta?.title ?? track.title,
      artist: meta?.artist ?? '',
      album: meta?.album ?? '',
      artwork: meta?.picture ? [{ src: meta.picture }] : []
    });
  };

  deps.player.store.subscribe(update);
  update();

  const seekBy = (delta: number): void => {
    const { duration } = deps.player.store.get();
    if (duration <= 0) return;
    const target = Math.max(
      0,
      Math.min(deps.player.getPosition() + delta, duration)
    );
    deps.player.seek(target);
  };

  const setHandler = (
    action: MediaSessionAction,
    handler: MediaSessionActionHandler
  ): void => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Acción no soportada por la plataforma: se ignora.
    }
  };

  setHandler('play', () => {
    void deps.player.play();
  });
  setHandler('pause', () => deps.player.pause());
  setHandler('previoustrack', () => {
    void deps.playback.previous();
  });
  setHandler('nexttrack', () => {
    void deps.playback.next();
  });
  setHandler('seekbackward', () => seekBy(-SEEK_STEP_SECONDS));
  setHandler('seekforward', () => seekBy(SEEK_STEP_SECONDS));
  setHandler('seekto', (details) => {
    if (typeof details.seekTime === 'number') {
      deps.player.seek(details.seekTime);
    }
  });
  setHandler('stop', () => deps.player.pause());
}
