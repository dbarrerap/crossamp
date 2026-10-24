import './styles/tokens.css';
import './styles/base.css';
import './styles/player.css';
import './styles/playlist.css';
import { WebAudioEngine } from './audio/WebAudioEngine';
import { PlayerController } from './state/PlayerController';
import { PlaylistController } from './playlist/PlaylistController';
import { connectPlaylistPlayback } from './playlist/connect';
import { connectSessionPersistence, restoreSession } from './persistence/connect';
import { createPlayerUI } from './ui/player';
import { createPlaylistUI } from './ui/playlist';

// Punto de entrada del renderer. Debe seguir siendo browser-portable:
// no importar 'electron' ni APIs de Node. Todo puentado va por window.crossamp.
const root = document.getElementById('app');
if (!root) throw new Error('#app no encontrado');

// Composicion: el engine es la fuente de verdad de reproduccion, el
// controller lo refleja en el store, y la UI solo se suscribe al store.
const engine = new WebAudioEngine();
const controller = new PlayerController(engine);

// La playlist resuelve rutas reales via el preload (Electron); en navegador
// el resolver devuelve null y el guardado del .m3u se degrada a nombres.
const playlist = new PlaylistController((file) => {
  const path = window.crossamp?.getPathForFile(file);
  return path ? path : null;
});

// readFile (IPC) solo existe en Electron; en navegador solo se reproducen e
// inspeccionan items que tengan sus bytes en memoria.
const readFile = window.crossamp
  ? (path: string) => window.crossamp!.readFile(path)
  : undefined;

// Unico punto donde playlist y transporte se conocen: Play sin pista arranca
// desde el primer item, y al terminar una pista sigue con la siguiente.
const playback = connectPlaylistPlayback({
  player: controller,
  playlist,
  readFile
});

// Persistencia de sesión: lista + última pista (en pausa) en localStorage.
// Browser-portable: sin IPC/rutas la app funciona igual, solo no restaura.
const session = {
  player: controller,
  playlist,
  storage: window.localStorage,
  readFile,
  resolvePath: (file: File) => window.crossamp?.getPathForFile(file) ?? null
};
connectSessionPersistence(session);

// Shell de la app: un contenedor por encima de los paneles para que la piel
// Bento (Fase 3) los maquete como tarjetas.
const shell = document.createElement('div');
shell.className = 'app';
shell.append(
  createPlayerUI(controller, {
    openFile: (file) => {
      void playback.openFile(file);
    }
  }),
  createPlaylistUI(playlist, {
    playItem: (id) => {
      void playback.playItem(id);
    },
    readFile
  })
);

root.appendChild(shell);

// La restauración es async (IPC + decode): la UI ya está montada y se
// actualiza sola vía store cuando el estado llegue.
void restoreSession(session);

console.info('[crossamp] listo — modo:', window.crossamp ? 'electron' : 'navegador');
