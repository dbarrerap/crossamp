/**
 * Store tipado mínimo (sin framework).
 *
 * El estado de reproducción REAL vive en el AudioEngine; aquí solo se
 * refleja lo que la UI necesita pintar. La feature branch
 * `feature/state-wiring` implementa el EventEmitter y el ciclo de updates.
 */
export interface PlayerState {
  isPlaying: boolean;
  currentTrack: Track | null;
  /** Segundos. */
  position: number;
  /** Segundos. */
  duration: number;
  volume: number;
}

export interface Track {
  id: string;
  title: string;
  file: File;
}

export const initialPlayerState: PlayerState = {
  isPlaying: false,
  currentTrack: null,
  position: 0,
  duration: 0,
  volume: 1
};
