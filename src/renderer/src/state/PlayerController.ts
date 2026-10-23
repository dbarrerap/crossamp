import type { AudioEngine } from '../audio/AudioEngine';
import { parseID3 } from '../metadata/mp3';
import type { ParsedTags, TrackMetadata } from '../metadata/types';
import { Store, initialPlayerState, type PlayerState, type Track } from './store';

/**
 * Controller: puente entre el AudioEngine y el Store.
 *
 * Reglas:
 *  - El AudioEngine es la única fuente de verdad de reproducción.
 *  - El Store solo refleja el estado discreto que la UI pinta.
 *  - La posición continua NO pasa por el Store: la UI la lee con
 *    getPosition() en su propio requestAnimationFrame. Emitir posición a
 *    60fps por el pub/sub sería un desperdicio.
 *  - La carátula vive en el Store como object URL (blob:), nunca como
 *    data URL base64 (un PNG de 1 MB serían ~1,4 M de chars en cada
 *    emisión). Este controller es el DUEÑO de la URL: la crea al cargar
 *    la pista y la revoca al cambiar de pista o en dispose(). Sin
 *    revocar, cada pista dejaría su blob vivo para siempre.
 */
export class PlayerController {
  readonly store: Store<PlayerState>;
  private engine: AudioEngine;

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.store = new Store<PlayerState>(initialPlayerState);

    // Fin de pista natural: reflejamos el estado y nos situamos al final.
    this.engine.onEnded(() => {
      this.store.set({
        isPlaying: false,
        position: this.engine.getDuration()
      });
    });
  }

  /**
   * Carga y decodifica una pista. Reemplaza la actual.
   *
   * Lee el File UNA sola vez a ArrayBuffer: de esos bytes se parsean los
   * metadatos y se los pasamos al engine. Así no leemos un MP3 grande dos
   * veces (una para tags, otra para decodificar). El engine clona el buffer
   * antes de decodificar (decodeAudioData lo desengancha), así que nuestro
   * ArrayBuffer sigue siendo válido tras load().
   */
  async loadTrack(track: Track): Promise<void> {
    // Capturamos la URL de la pista anterior, notificamos el cambio (la UI
    // suelta su referencia al instante) y recién AHÍ revocamos: ese orden
    // evita que un img siga apuntando a un blob ya revocado.
    const previousPicture = this.store.get().metadata?.picture ?? null;

    this.store.set({
      isLoading: true,
      currentTrack: track,
      metadata: null,
      position: 0,
      duration: 0
    });

    if (previousPicture?.startsWith('blob:')) URL.revokeObjectURL(previousPicture);

    try {
      const bytes = await track.file.arrayBuffer();

      // Best-effort: un tag corrupto no debe impedir la reproducción.
      // El nombre del archivo rellena los huecos que los tags dejaron vacíos.
      const tags = parseID3(bytes, track.file.name);
      this.store.set({ metadata: this.resolveMetadata(tags) });

      await this.engine.load(bytes);
      this.store.set({
        isLoading: false,
        duration: this.engine.getDuration(),
        position: 0
      });
    } catch (err) {
      const failedPicture = this.store.get().metadata?.picture ?? null;
      this.store.set({ isLoading: false, currentTrack: null, metadata: null });
      if (failedPicture?.startsWith('blob:')) URL.revokeObjectURL(failedPicture);
      throw err;
    }
  }

  /**
   * Convierte la salida cruda del parser en TrackMetadata de UI: crea la
   * object URL de la carátula (nada de base64 inline). El dueño de esa URL
   * es este controller: loadTrack() la revoca al cambiar de pista y
   * dispose() la revoca al final.
   */
  private resolveMetadata(tags: ParsedTags): TrackMetadata {
    return {
      title: tags.title,
      artist: tags.artist,
      album: tags.album,
      picture: tags.picture
        ? URL.createObjectURL(
            new Blob([tags.picture.data], { type: tags.picture.mime })
          )
        : null
    };
  }

  play(): void {
    this.engine.play();
    this.store.set({ isPlaying: this.engine.isPlaying(), position: this.engine.getTime() });
  }

  pause(): void {
    this.engine.pause();
    this.store.set({ isPlaying: false, position: this.engine.getTime() });
  }

  /** Alterna play/pause. */
  toggle(): void {
    if (this.store.get().isPlaying) this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    this.engine.seek(seconds);
    this.store.set({ position: this.engine.getTime() });
  }

  setVolume(volume: number): void {
    this.engine.setVolume(volume);
    this.store.set({ volume });
  }

  /** Posición en vivo, en segundos. La UI la lee en su bucle rAF. */
  getPosition(): number {
    return this.engine.getTime();
  }

  /** Acceso al analyser para el VU meter (Fase 2). */
  getAnalyser(): AnalyserNode | null {
    const maybe = this.engine as { getAnalyser?: () => AnalyserNode };
    return typeof maybe.getAnalyser === 'function' ? maybe.getAnalyser() : null;
  }

  dispose(): void {
    // El controller es dueño de la object URL de la carátula: al morir,
    // liberarla (si no, el blob queda vivo hasta recargar el documento).
    const picture = this.store.get().metadata?.picture ?? null;
    if (picture?.startsWith('blob:')) URL.revokeObjectURL(picture);
    this.engine.dispose();
  }
}
