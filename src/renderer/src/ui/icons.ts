/**
 * Iconos SVG inline de la piel Bento (Fase 3).
 *
 * Sin dependencias ni fuentes de iconos: cada icono es un <svg> que hereda
 * `currentColor`, así el color lo decide el CSS del contenedor. Los path son
 * estáticos y propios, nunca provienen de datos del usuario.
 */
const PATHS = {
  play: 'M8 5.14v13.72c0 .8.87 1.3 1.56.9l10.98-6.86a1.06 1.06 0 0 0 0-1.8L9.56 4.24A1.06 1.06 0 0 0 8 5.14z',
  pause: 'M7 5h3.2v14H7zm6.8 0H17v14h-3.2z',
  eject: 'M12 4.5 19 13H5zM5 15.5h14v2.6H5z',
  volume:
    'M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4zm11.2-1.1a5 5 0 0 1 0 7.2l-1.3-1.3a3.2 3.2 0 0 0 0-4.6zm2.6-2.6a8.7 8.7 0 0 1 0 12.4l-1.3-1.3a6.9 6.9 0 0 0 0-9.8z',
  note: 'M9 18.2a2.7 2.7 0 1 1-1.6-2.5V6.4l11-2.3v11.6a2.7 2.7 0 1 1-1.6-2.5V7.2L9 9.1z'
} as const;

export type IconName = keyof typeof PATHS;

/** Crea el <svg> de un icono. Decorativo: el nombre accesible va en el botón. */
export function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);

  return svg;
}
