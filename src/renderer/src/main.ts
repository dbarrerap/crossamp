import './styles.css';
import { WebAudioEngine } from './audio/WebAudioEngine';
import { PlayerController } from './state/PlayerController';
import { createPlayerUI } from './ui/player';

// Punto de entrada del renderer. Debe seguir siendo browser-portable:
// no importar 'electron' ni APIs de Node. Todo puentado va por window.crossamp.
const root = document.getElementById('app');
if (!root) throw new Error('#app no encontrado');

// Composicion: el engine es la fuente de verdad de reproduccion, el
// controller lo refleja en el store, y la UI solo se suscribe al store.
const engine = new WebAudioEngine();
const controller = new PlayerController(engine);

root.appendChild(createPlayerUI(controller));

console.info('[crossamp] listo — modo:', window.crossamp ? 'electron' : 'navegador');
