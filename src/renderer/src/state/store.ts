/**
 * Store tipado mínimo (sin framework).
 *
 * El estado de reproducción REAL vive en el AudioEngine; aquí solo se
 * refleja lo que la UI necesita pintar. Es un pub/sub de estado discreto:
 * cambia cuando algo "ocurre" (play, pause, fin de pista, nueva pista).
 *
 * La posición de reproducción NO se emite por aquí a 60fps: es un valor
 * continuo y el controller lo expone aparte (getPosition()) para que la UI
 * lo lea en su propio bucle requestAnimationFrame. Emitir position a 60Hz
 * por un pub/sub sería un desperdicio.
 */
import type { TrackMetadata } from '../metadata/types';

export interface PlayerState {
  isPlaying: boolean;
  currentTrack: Track | null;
  /** Segundos. Solo se actualiza en eventos discretos (seek, load, pause). */
  position: number;
  /** Segundos. 0 hasta que la pista se decodifica. */
  duration: number;
  volume: number;
  /** true mientras decodifica una pista en loadTrack(). */
  isLoading: boolean;
  /** Metadatos del archivo en reproducción. null si aún no se parsearon. */
  metadata: TrackMetadata | null;
}

export interface Track {
  id: string;
  /** Nombre del archivo. Sirve de fallback si el tag no trae título. */
  title: string;
  file: File;
}

export const initialPlayerState: PlayerState = {
  isPlaying: false,
  currentTrack: null,
  position: 0,
  duration: 0,
  volume: 1,
  isLoading: false,
  metadata: null
};

type Listener<S> = (state: S) => void;

/**
 * Emitter de estado inmutable. `set` fusiona un parche y notifica.
 * `subscribe` devuelve la función de baja inmediata.
 */
export class Store<S extends object> {
  private state: S;
  private listeners = new Set<Listener<S>>();

  constructor(initial: S) {
    this.state = initial;
  }

  get(): S {
    return this.state;
  }

  set(partial: Partial<S>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: Listener<S>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
