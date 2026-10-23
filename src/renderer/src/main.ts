import './styles.css';
import { createPlayerUI } from './ui/player';

// Punto de entrada del renderer. Debe seguir siendo browser-portable:
// no importar 'electron' ni APIs de Node. Todo puentado va por window.crossamp.
const root = document.getElementById('app');
if (!root) throw new Error('#app no encontrado');

root.appendChild(createPlayerUI());

// Diagnóstico mínimo para verificar que el scaffold arranca.
console.info('[crossamp] scaffold listo — modo:', window.crossamp ? 'electron' : 'navegador');
