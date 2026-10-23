/**
 * UI del player.
 * Fase 1: stub visual. La implementación real llega con la feature branch
 * `feature/player-ui`.
 */
export function createPlayerUI(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'player';
  el.textContent = 'crossamp — scaffold';
  return el;
}
