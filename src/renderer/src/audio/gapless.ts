/**
 * Núcleo de agendado gapless.
 *
 * La clave es no esperar el evento `ended` de la fuente actual (llega tarde
 * y dispara la carga/decodificación de la siguiente). En cambio, calculamos
 * el instante exacto de fin con el reloj del AudioContext y agendamos la
 * siguiente fuente ahí mismo: el mezclador de Web Audio las empalma sin
 * silencio.
 */
export function endTimeOf(
  startedAt: number,
  offset: number,
  duration: number
): number {
  return startedAt + Math.max(0, duration - offset);
}

/** Crea y arranca una fuente en un instante absoluto del contexto. */
export function startBuffer(
  ctx: BaseAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  when: number,
  offset = 0
): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(destination);
  source.start(when, offset);
  return source;
}
