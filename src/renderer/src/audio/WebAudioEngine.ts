import type { AudioEngine } from './AudioEngine';

/**
 * Duración del micro-fade al buscar mientras suena. Cortar y re-arrancar la
 * fuente deja un salto de señal audible (click); bajar el gain ~6 ms y subir
 * en el mismo valle lo elimina sin que se note.
 */
const SEEK_FADE_SECONDS = 0.006;

/**
 * Backend de audio sobre Web Audio API.
 *
 * Elección deliberada: usa AudioBufferSourceNode en vez del elemento <audio>.
 * Es la misma base que necesita la Fase 4 (gapless), de modo que esa fase
 * solo añade el agendado de buffers por encima sin reescribir el backend.
 *
 * Contrapartidas conocidas (aceptadas):
 *  - El archivo se decodifica completo a memoria (AudioBuffer).
 *  - La posición se trackea manualmente respecto a AudioContext.currentTime.
 *
 * El grafo es:  source -> gain -> destination
 *                        └----> analyser   (tap, no afecta a la salida)
 */
export class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  /** Segundos dentro del buffer desde donde arrancó la reproducción actual. */
  private offset = 0;
  /** AudioContext.currentTime en el momento en que empezó a sonar. */
  private startedAt = 0;
  private playing = false;
  /** Volumen de usuario (0..1). Se guarda para restaurarlo tras el fade de seek. */
  private volume = 1;
  private endedCallback: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();

    this.gain.connect(this.ctx.destination);
    // El analyser es un tap de solo lectura: no se conecta a destination,
    // así no colorea la salida.
    this.gain.connect(this.analyser);
  }

  async load(source: File | ArrayBuffer): Promise<void> {
    // decodeAudioData desengancha (detacha) el ArrayBuffer que recibe.
    // Si nos pasan un File leemos nuestra propia copia; si nos pasan un
    // ArrayBuffer lo clonamos para no invalidar el del llamante (que
    // podria necesitarlo p.ej. el parser de metadatos).
    const bytes =
      source instanceof File ? await source.arrayBuffer() : source.slice(0);

    // Detenemos la pista actual ANTES de decodificar: cargar un archivo
    // nuevo sustituye lo que suena ahora, y decodificar puede tardar. Así
    // el cambio es inmediato y, si la decodificación falla, no queda
    // audio "huérfano" sonando sin control.
    this.stopSource();
    this.playing = false;

    const buffer = await this.ctx.decodeAudioData(bytes);

    this.buffer = buffer;
    this.offset = 0;
  }

  play(): void {
    if (!this.buffer || this.playing) return;

    // Politica de autoplay: el contexto puede arrancar suspended hasta que
    // haya un gesto del usuario. Lo reanudamos en cada play.
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    // Si estamos al final, play() reinicia desde el principio.
    if (this.offset >= this.buffer.duration) this.offset = 0;

    this.startSource(this.offset);
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;

    this.offset = this.getTime();
    this.stopSource();
    this.playing = false;
  }

  seek(seconds: number): void {
    if (!this.buffer) return;

    const clamped = Math.max(0, Math.min(seconds, this.buffer.duration));

    if (this.playing) {
      // Paramos la fuente actual y agendamos la nueva en el valle del fade:
      // el audio nunca se corta en seco.
      const now = this.ctx.currentTime;
      const resumeAt = now + SEEK_FADE_SECONDS;

      if (this.source) {
        this.source.onended = null; // stop() manual no debe disparar el fin
        this.source.stop(resumeAt);
      }

      const gain = this.gain.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, resumeAt);
      gain.setValueAtTime(0, resumeAt);
      gain.linearRampToValueAtTime(this.volume, resumeAt + SEEK_FADE_SECONDS);

      this.startSource(clamped, resumeAt);
    } else {
      this.offset = clamped;
    }
  }

  getTime(): number {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;

    // Math.max(0, …): la fuente del seek arranca unos ms en el futuro, y en
    // ese hueco el reloj no debe retroceder por debajo del destino.
    const elapsed =
      this.offset + Math.max(0, this.ctx.currentTime - this.startedAt);
    return Math.min(elapsed, this.buffer.duration);
  }

  getDuration(): number {
    return this.buffer?.duration ?? 0;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.gain.gain.value = this.volume;
  }

  onEnded(callback: () => void): void {
    this.endedCallback = callback;
  }

  /** Tap del analyser para el VU meter (Fase 2). No forma parte de la interfaz. */
  getAnalyser(): AnalyserNode {
    return this.analyser;
  }

  /** true si hay una pista cargada. */
  isLoaded(): boolean {
    return this.buffer !== null;
  }

  /** true si esta sonando. */
  isPlaying(): boolean {
    return this.playing;
  }

  dispose(): void {
    this.stopSource();
    this.buffer = null;
    this.endedCallback = null;
    void this.ctx.close();
  }

  private startSource(offset: number, when?: number): void {
    if (!this.buffer) return;

    // when: instante absoluto de AudioContext en el que debe sonar. Omitido
    // (play normal) = ahora mismo.
    const startAt = when ?? this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    source.onended = () => this.handleEnded(source);

    this.source = source;
    this.startedAt = startAt;
    this.offset = offset;

    // start(when, offset) arranca `offset` segundos dentro del buffer.
    source.start(startAt, offset);
  }

  private stopSource(): void {
    if (!this.source) return;

    // Anulamos onended para que stop() manual no dispare el callback de fin.
    this.source.onended = null;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
  }

  private handleEnded(source: AudioBufferSourceNode): void {
    // Ignoramos fuentes que ya no sean la activa (carrera entre end y seek).
    if (source !== this.source) return;

    this.source = null;
    this.playing = false;
    this.offset = this.buffer?.duration ?? 0;
    this.endedCallback?.();
  }
}
