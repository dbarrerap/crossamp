/**
 * Reglas de búsqueda con teclado sobre la barra de seek.
 *
 * Puro y sin DOM para poder probarlo en el harness: la UI traduce la tecla
 * a un destino en segundos y deja que el controller haga el resto.
 *
 * Convención tipo Winamp: flechas ±5 s, con Shift ±30 s, Home/End a los
 * extremos.
 */

/** Paso de las flechas al buscar con teclado (segundos). */
export const SEEK_STEP = 5;

/** Paso con Shift (segundos). */
export const SEEK_STEP_LARGE = 30;

/**
 * Devuelve el destino (segundos, ya recortado a [0, duration]) para una
 * tecla, o null si esa tecla no busca.
 */
export function seekKeyTarget(
  key: string,
  shiftKey: boolean,
  current: number,
  duration: number
): number | null {
  if (!(duration > 0)) return null;

  const step = shiftKey ? SEEK_STEP_LARGE : SEEK_STEP;
  let target: number;
  switch (key) {
    case 'ArrowLeft':
      target = current - step;
      break;
    case 'ArrowRight':
      target = current + step;
      break;
    case 'Home':
      target = 0;
      break;
    case 'End':
      target = duration;
      break;
    default:
      return null;
  }

  return Math.max(0, Math.min(target, duration));
}
