/**
 * Acciones de transporte disparadas desde el sistema (atajos globales del
 * main). Módulo puro para poder testear el despacho sin Electron.
 */
export type MediaAction = 'play-pause' | 'next' | 'previous';

export interface MediaActionDeps {
  player: { toggle(): void };
  playback: {
    next(): Promise<boolean>;
    previous(): Promise<boolean>;
  };
}

/** Ejecuta una acción; devuelve false si no es una acción conocida. */
export function handleMediaAction(action: string, deps: MediaActionDeps): boolean {
  switch (action) {
    case 'play-pause':
      deps.player.toggle();
      return true;
    case 'next':
      void deps.playback.next();
      return true;
    case 'previous':
      void deps.playback.previous();
      return true;
    default:
      return false;
  }
}
