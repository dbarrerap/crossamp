import type { AudioEngine } from '../audio/AudioEngine';
import { parseID3 } from '../metadata/mp3';
import type { ParsedTags, TrackMetadata } from '../metadata/types';
import { Store, initialPlayerState, type PlayerState, type Track } from './store';

/**
 * Puntos de extensión del transporte, inyectados desde fuera (los arma
 * connectPlaylistPlayback). El PlayerController NO conoce a la playlist:
 * solo sabe que, en ciertos momentos, alguien puede querer intervenir.
 */
export interface PlaybackHooks {
  /**
   * Play pulsado y NO hay pista cargada. Devuelve true si el llamador ya
   * se encargó (cargó y reprodujo algo); false para caer al comportamiento
   * normal del engine (no-op si no hay nada cargado).
   */
  onPlayEmpty?: () => Promise<boolean>;
  /**
   * Una pista terminó naturalmente. El transporte por defecto queda
   * detenido; con la playlist, este hook carga el siguiente item (auto-play
   * incluido vía loadTrack). void: si no hay siguiente, no hace nada.
   */
  onTrackEnded?: () => Promise<void>;
}

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
  private hooks: PlaybackHooks = {};

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.store = new Store<PlayerState>(initialPlayerState);

    // Fin de pista natural: reflejamos el estado y nos situamos al final.
    // Después, si hay un hook (playlist), pedimos el siguiente item: como
    // loadTrack() auto-playea, la continuidad queda garantizada aquí.
    this.engine.onEnded(() => {
      this.store.set({
        isPlaying: false,
        position: this.engine.getDuration()
      });
      if (this.hooks.onTrackEnded) {
        this.hooks.onTrackEnded().catch((err) => {
          console.error('[crossamp] error avanzando de pista', err);
        });
      }
    });
  }

  /** Registra (o limpia con undefined) los hooks del transporte. */
  setHooks(hooks: PlaybackHooks = {}): void {
    this.hooks = hooks;
  }

  /**
   * Carga, decodifica y reproduce una pista. Reemplaza la actual.
   *
   * Lee el File UNA sola vez a ArrayBuffer: de esos bytes se parsean los
   * metadatos y se los pasamos al engine. Así no leemos un MP3 grande dos
   * veces (una para tags, otra para decodificar). El engine clona el buffer
   * antes de decodificar (decodeAudioData lo desengancha), así que nuestro
   * ArrayBuffer sigue siendo válido tras load().
   */
  async loadTrack(
    track: Track,
    options: { autoplay?: boolean } = {}
  ): Promise<void> {
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

      // Reproducir siempre: cargar un archivo es una apertura explícita y
      // eso implica intención de escucharlo (estilo Winamp). Antes de este
      // arreglo, load() paraba el engine pero el store seguía diciendo
      // isPlaying: true; el primer clic en Play se "comía" en un pause()
      // sin efecto. play() re-sincroniza el store con el engine. (Hay pista
      // cargada, así que el hook onPlayEmpty no entra en juego aquí.)
      if (options.autoplay === false) {
        // Restauración de sesión: queda cargada y en pausa.
        this.store.set({ isPlaying: this.engine.isPlaying() });
        return;
      }
      await this.play();
    } catch (err) {
      const failedPicture = this.store.get().metadata?.picture ?? null;
      // Nunca dejamos audio huérfano: si el fallo dejó sonando la pista
      // anterior, la paramos y reflejamos isPlaying en el store.
      this.engine.pause();
      this.store.set({
        isLoading: false,
        isPlaying: false,
        currentTrack: null,
        metadata: null
      });
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

  /**
   * Reproduce. Si NO hay pista cargada y hay hook (playlist con items),
   * el hook intenta arrancar desde la lista (req: "Play con lista cargada
   * reproduce desde el primer item"). Si el hook no maneja nada, caemos al
   * engine: sin pista, play() es no-op (comportamiento previo intacto).
   */
  async play(): Promise<void> {
    if (!this.store.get().currentTrack && this.hooks.onPlayEmpty) {
      const handled = await this.hooks.onPlayEmpty();
      if (handled) return;
    }
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
    else void this.play();
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
