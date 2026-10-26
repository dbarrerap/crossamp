/**
 * Contrato del motor de audio.
 *
 * La UI NUNCA habla con el backend de reproducción directamente; solo con
 * esta interfaz. Ese aislamiento es lo que permite que la Fase 4 (gapless)
 * reemplace el backend sin tocar la UI ni el store.
 *
 * Implementación actual: ninguna (stub). La feature branch
 * `feature/audio-engine` añade un backend Web Audio.
 */
export interface AudioEngine {
  /** Carga una pista y la deja lista para play(). Reemplaza la actual. */
  load(source: File | ArrayBuffer): Promise<void>;
  /**
   * Decodifica una pista SIN tocar la reproducción actual. Es la base del
   * gapless: el siguiente buffer se prepara mientras suena el actual.
   */
  decode(source: File | ArrayBuffer): Promise<AudioBuffer>;
  /**
   * Agenda `buffer` para empezar exactamente al final de la fuente activa.
   * Devuelve el instante de AudioContext en que empieza (0 si no se pudo).
   */
  queue(buffer: AudioBuffer, onStart?: () => void): number;
  /** Cancela la fuente agendada (pause, seek, cambio de pista, etc.). */
  clearQueue(): void;
  play(): void;
  pause(): void;
  /** Salta a una posición en segundos. */
  seek(seconds: number): void;
  /** Posición actual en segundos. */
  getTime(): number;
  /** Duración total en segundos (0 si aún no está cargada). */
  getDuration(): number;
  /** true si está sonando actualmente. */
  isPlaying(): boolean;
  setVolume(volume: number): void;
  /** Se dispara al terminar la pista naturalmente. */
  onEnded(callback: () => void): void;
  dispose(): void;
}
