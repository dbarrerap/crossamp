import { WebAudioEngine } from '../src/renderer/src/audio/WebAudioEngine';
import { PlayerController, type PlaybackHooks } from '../src/renderer/src/state/PlayerController';
import { parseID3 } from '../src/renderer/src/metadata/mp3';
import { trackFromFilename } from '../src/renderer/src/metadata/filename';
import { Store, initialPlayerState, type PlayerState, type Track } from '../src/renderer/src/state/store';
import {
  parseM3U,
  serializeM3U,
  displayNameFromPath,
  dirnameOf,
  isAbsolutePath,
  resolveEntryPath
} from '../src/renderer/src/playlist/m3u';
import { PlaylistController } from '../src/renderer/src/playlist/PlaylistController';
import { resolvePlaylistFile } from '../src/renderer/src/playlist/materialize';
import { connectPlaylistPlayback } from '../src/renderer/src/playlist/connect';
import { seekKeyTarget } from '../src/renderer/src/ui/seek';
import type { AudioEngine } from '../src/renderer/src/audio/AudioEngine';
import { createPlayerUI } from '../src/renderer/src/ui/player';
import { createPlaylistUI } from '../src/renderer/src/ui/playlist';

// Harness de validacion del backend contra MP3 reales.
// Corre dentro de Chromium (Electron). Recibe los bytes del MP3 por IPC
// (preload.readFile) y ejercita la maquina de estados del motor.

interface TestApi {
  readFile(path: string): Promise<ArrayBuffer>;
  paths: string[];
}

declare global {
  interface Window {
    crossampTest?: TestApi;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let failures = 0;

function assert(cond: boolean, label: string): void {
  const ok = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${ok}] ${label}`);
}

function log(msg: string): void {
  console.log(msg);
}

async function runOne(path: string): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path;
  log(`\n===== ${name} =====`);

  const engine = new WebAudioEngine();
  engine.setVolume(0.5);

  // Carga + decodificacion
  const bytes = await window.crossampTest!.readFile(path);
  assert(bytes.byteLength > 0, 'leyo bytes del archivo');

  const t0 = performance.now();
  await engine.load(bytes);
  const decodeMs = Math.round(performance.now() - t0);

  const duration = engine.getDuration();
  log(`  decodificado en ${decodeMs}ms, duracion=${duration.toFixed(2)}s`);
  assert(duration > 0, 'decodeAudioData produce buffer con duracion > 0');
  assert(duration < 3600, 'duracion plausible (< 1h)');

  // Posicion inicial
  assert(engine.getTime() === 0, 'getTime() == 0 tras load');

  // Reproduccion avanza
  engine.play();
  assert(engine.isPlaying(), 'isPlaying() true tras play');
  await sleep(600);
  const t1 = engine.getTime();
  log(`  tras 600ms de play, getTime()=${t1.toFixed(3)}s`);
  assert(t1 > 0.2, 'el reloj avanza mientras suena');

  // Pausa congela
  engine.pause();
  assert(!engine.isPlaying(), 'isPlaying() false tras pause');
  const pausedAt = engine.getTime();
  await sleep(400);
  const pausedAfter = engine.getTime();
  assert(
    Math.abs(pausedAfter - pausedAt) < 0.01,
    'getTime() congelado durante pause'
  );

  // Seek preciso
  engine.seek(1);
  const seeked = engine.getTime();
  log(`  seek(1) -> getTime()=${seeked.toFixed(3)}s`);
  assert(Math.abs(seeked - 1) < 0.01, 'seek(1) fija el reloj a ~1s');

  // Seek fuera de rango se recorta
  engine.seek(999999);
  assert(
    Math.abs(engine.getTime() - duration) < 0.01,
    'seek(999999) se recorta al final'
  );
  engine.seek(-5);
  assert(engine.getTime() === 0, 'seek(-5) se recorta a 0');

  // Seek mientras suena: corta y re-arranca en el destino (con micro-fade),
  // y el reloj sigue avanzando desde ahí.
  engine.play();
  await sleep(200);
  const midTarget = Math.min(2, duration / 2);
  engine.seek(midTarget);
  await sleep(300);
  const afterPlayingSeek = engine.getTime();
  log(`  seek en reproducción -> getTime()=${afterPlayingSeek.toFixed(3)}s`);
  assert(
    afterPlayingSeek > midTarget - 0.05,
    'seek en reproducción: el reloj arranca en el destino'
  );
  assert(engine.isPlaying(), 'seek en reproducción: sigue sonando');
  engine.pause();

  // Fin natural dispara onEnded
  let ended = false;
  engine.onEnded(() => {
    ended = true;
  });
  engine.seek(duration - 0.35);
  engine.play();
  await sleep(1200);
  assert(ended, 'onEnded se dispara al terminar la pista');
  assert(!engine.isPlaying(), 'isPlaying() false tras terminar');

  // Volumen se aplica
  engine.setVolume(0.25);
  engine.setVolume(2);
  engine.setVolume(-1); // no debe lanzar
  assert(true, 'setVolume acepta valores sin lanzar');

  engine.dispose();
  log(`  ===== ${failures === 0 ? 'ok' : 'con fallos'} =====`);
}

// Prueba del cableado AudioEngine <-> Store <-> Controller.
async function runController(path: string): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path;
  log(`\n===== controller: ${name} =====`);

  const engine = new WebAudioEngine();
  const controller = new PlayerController(engine);

  // Track con un File construido desde los bytes leidos.
  const bytes = await window.crossampTest!.readFile(path);
  const file = new File([bytes], name);
  const track: Track = { id: 't1', title: name, file };

  // El store debe emitir al suscribirse.
  let emitted = 0;
  const unsubscribe = controller.store.subscribe(() => {
    emitted++;
  });
  assert(emitted === 0, 'sin emision antes de tocar nada');

  // loadTrack: isLoading true -> duration conocida, isLoading false.
  const loadPromise = controller.loadTrack(track);
  // Tras el primer await interno isLoading ya deberia estar reflejado.
  const loadingState = controller.store.get();
  assert(loadingState.currentTrack?.id === 't1', 'currentTrack fijado en loadTrack');
  await loadPromise;

  const afterLoad = controller.store.get();
  assert(afterLoad.isLoading === false, 'isLoading false tras cargar');
  assert(afterLoad.duration > 0, 'duration reflejado en el store');
  // Cargar un archivo implica escucharlo: loadTrack auto-play (Winamp).
  assert(afterLoad.isPlaying === true, 'isPlaying true tras cargar (auto-play)');
  assert(emitted >= 2, 'el store emitió durante loadTrack');

  // play -> isPlaying true
  controller.play();
  assert(controller.store.get().isPlaying === true, 'isPlaying true tras play');

  // La posicion en vivo avanza via getPosition() (no por el store).
  await sleep(400);
  const live = controller.getPosition();
  assert(live > 0.1, `getPosition() avanza (${live.toFixed(2)}s)`);

  // pause -> isPlaying false y position reflejado
  controller.pause();
  const afterPause = controller.store.get();
  assert(afterPause.isPlaying === false, 'isPlaying false tras pause');
  assert(afterPause.position > 0, 'position reflejado en el store tras pause');

  // toggle invierte
  controller.toggle();
  assert(controller.store.get().isPlaying === true, 'toggle() reanuda');
  controller.toggle();
  assert(controller.store.get().isPlaying === false, 'toggle() pausa');

  // seek refleja position en el store
  controller.seek(2);
  assert(
    Math.abs(controller.store.get().position - 2) < 0.01,
    'seek(2) refleja position=2 en el store'
  );

  // setVolume refleja volume
  controller.setVolume(0.3);
  assert(
    Math.abs(controller.store.get().volume - 0.3) < 0.001,
    'setVolume refleja volume en el store'
  );

  // Fin natural: el store pasa a isPlaying false.
  controller.seek(afterLoad.duration - 0.3);
  controller.play();
  await sleep(1200);
  assert(
    controller.store.get().isPlaying === false,
    'onEnded refleja isPlaying=false en el store'
  );

  unsubscribe();
  controller.dispose();
  log('  ===== controller ok =====');
}

// Validacion del parser ID3 contra los MP3 reales.
// Hechos verificados con inspeccion hex: ambos archivos son ID3v2.3, sin
// frames de texto (TIT2/TPE1/TALB ausentes) y sin ID3v1. Por eso mismo
// ejercitan bien el fallback A (nombre "Artista - Titulo") y la extraccion
// de la caratula APIC (PNG).
async function runMetadata(path: string): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path;
  log(`\n===== metadata: ${name} =====`);

  const bytes = await window.crossampTest!.readFile(path);

  // Sin filename: los campos sin tag quedan null (no se inventan).
  const tagsOnly = parseID3(bytes);
  assert(tagsOnly.title === null, 'sin filename: title queda null (no hay TIT2)');
  assert(tagsOnly.artist === null, 'sin filename: artist queda null (no hay TPE1)');
  assert(tagsOnly.picture !== null, 'APIC extraido aunque no haya texto');

  // Con filename (fallback A): huecos rellenos desde "Artista - Titulo",
  // sin pisar ningun tag valido (aqui no hay tags de texto, asi que todo
  // lo rellena el nombre).
  const tags = parseID3(bytes, name);
  const fromName = trackFromFilename(name);
  assert(tags.title === fromName.title, `fallback A: title desde nombre (${JSON.stringify(tags.title)})`);
  assert(tags.artist === fromName.artist, `fallback A: artist desde nombre (${JSON.stringify(tags.artist)})`);

  // title/artist/album: string no vacio o null, nunca cadena vacia.
  for (const [k, v] of Object.entries({
    title: tags.title,
    artist: tags.artist,
    album: tags.album
  })) {
    assert(v === null || (typeof v === 'string' && v.length > 0), `${k}: null o string no vacio`);
  }

  // Caratula: bytes crudos + mime. Sin data URL (fallback C: la object URL
  // la crea el controller, el parser solo expone los bytes).
  if (tags.picture !== null) {
    const { mime, data } = tags.picture;
    assert(/^image\/(png|jpeg|webp|gif)$/.test(mime), `mime de imagen valido (${mime})`);
    assert(data.length > 1000, `picture con contenido real (${data.length} bytes)`);
    // En estos ficheros concretos la caratula es PNG (verificado): comprobamos
    // la firma magica real, no el string del tag, que podria mentir.
    assert(
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47,
      'picture es PNG por firma magica (dato verificado en estos MP3)'
    );
  } else {
    log('  (sin caratula en este archivo)');
  }

  log(`  title=${JSON.stringify(tags.title)} artist=${JSON.stringify(tags.artist)} album=${JSON.stringify(tags.album)}`);
  log('  ===== metadata ok =====');
}

// Integracion: el controller debe reflejar los metadatos en el store y ser
// dueno de la object URL de la caratula (crearla al cargar, revocarla al
// cambiar de pista y en dispose).
async function runControllerMetadata(path: string): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path;
  log(`\n===== controller+metadata: ${name} =====`);

  const engine = new WebAudioEngine();
  const controller = new PlayerController(engine);

  const bytes = await window.crossampTest!.readFile(path);
  const file = new File([bytes], name);
  const track: Track = { id: 'tm', title: name, file };

  await controller.loadTrack(track);

  const state = controller.store.get();
  assert(state.metadata !== null, 'store.metadata poblado tras loadTrack');
  assert(state.duration > 0, 'state.duration poblado desde el engine');
  assert(
    state.metadata?.title === trackFromFilename(name).title,
    'title con fallback A reflejado en el store'
  );
  assert(
    state.metadata?.picture?.startsWith('blob:') === true,
    'metadata.picture es una object URL blob: (fallback C)'
  );

  // --- Control positivo + revocación (fallback C) ---
  // Antes de probar que una URL se revoca, hay que demostrar que una URL
  // viva SÍ se puede leer. Si no, el aserto "fetch falla" sería un falso
  // positivo (una URL sin revocar daría ese mismo fallo, p.ej. por CSP).
  const firstUrl = state.metadata!.picture!;
  const alive = await fetch(firstUrl)
    .then(() => true)
    .catch(() => false);
  assert(alive, 'object URL viva es legible (control positivo)');

  // Cambiar de pista: la URL anterior DEBE quedar revocada (no podemos
  // "leer" una URL revocada, pero si que fetch sobre ella falle).
  await controller.loadTrack({ id: 'tm2', title: 'otra', file });
  const secondUrl = controller.store.get().metadata?.picture ?? null;
  // Escenario del bug original: cargar encima de una pista EN SONIDO debe
  // arrancar la nueva sola (sin exigir pause+play manual).
  assert(controller.store.get().isPlaying === true, 'auto-play al cargar encima de otra pista');
  assert(secondUrl !== null && secondUrl !== firstUrl, 'URL nueva tras recargar (no se reutiliza la vieja)');
  const oldStillWorks = await fetch(firstUrl)
    .then(() => true)
    .catch(() => false);
  assert(!oldStillWorks, 'la object URL anterior queda revocada al cambiar de pista');

  // dispose(): la URL vigente tambien se revoca. Control positivo: la URL
  // actual debe ser legible ANTES del dispose.
  const currentUrl = secondUrl!;
  const currentAliveBeforeDispose = await fetch(currentUrl)
    .then(() => true)
    .catch(() => false);
  assert(currentAliveBeforeDispose, 'URL vigente legible antes de dispose (control positivo)');

  controller.dispose();
  const currentStillWorks = await fetch(currentUrl)
    .then(() => true)
    .catch(() => false);
  assert(!currentStillWorks, 'dispose() revoca la object URL vigente');

  log('  ===== controller+metadata ok =====');
}

/**
 * Smoke tests de UI (Fase 3): construyen los paneles reales con un engine
 * falso y verifican estructura + interacciones básicas. No reproducen audio;
 * protegen el rediseño Bento de romper selectores o handlers.
 */
function runUiSmoke(): void {
  log('\n===== ui: smoke =====');

  const fakeEngine: AudioEngine = {
    load: async () => {},
    play: () => {},
    pause: () => {},
    seek: () => {},
    getTime: () => 0,
    getDuration: () => 0,
    isPlaying: () => false,
    setVolume: () => {},
    onEnded: () => {},
    dispose: () => {}
  };

  // --- Player ---
  const player = new PlayerController(fakeEngine);
  const ui = createPlayerUI(player);

  assert(ui.classList.contains('player'), 'UI player: contenedor .player');
  assert(ui.querySelector('.player-cover') !== null, 'UI player: carátula');
  assert(
    ui.querySelector('.player-title')?.textContent === 'Sin pista',
    'UI player: título inicial'
  );
  assert(ui.querySelector('.player-time') !== null, 'UI player: tiempo');

  const seek = ui.querySelector('.player-seek') as HTMLInputElement | null;
  assert(
    seek !== null && seek.step === 'any' && seek.getAttribute('aria-label') === 'Posición',
    'UI player: seek en segundos y accesible'
  );

  const playBtn = ui.querySelector('.player-controls button') as HTMLButtonElement | null;
  assert(playBtn?.disabled === true, 'UI player: Play deshabilitado sin pista');
  player.store.set({ canStartFromPlaylist: true });
  assert(playBtn?.disabled === false, 'UI player: Play habilitado con lista');
  player.dispose();

  // --- Playlist ---
  const pl = new PlaylistController();
  let playedId: string | null = null;
  const plUi = createPlaylistUI(pl, {
    playItem: (id) => {
      playedId = id;
    }
  });

  assert(plUi.querySelector('.playlist-list')?.tagName === 'OL', 'UI playlist: lista es <ol>');
  assert(
    plUi.querySelector('.playlist-count')?.textContent === '0',
    'UI playlist: contador en 0'
  );
  assert(
    plUi.querySelector('.playlist-empty')?.hasAttribute('hidden') === false,
    'UI playlist: mensaje de vacío visible'
  );
  assert(
    plUi.querySelector('.playlist-menu')?.hasAttribute('hidden') === true,
    'UI playlist: menú cerrado al inicio'
  );

  pl.addFiles([new File([], 'Uno.mp3'), new File([], 'Dos.mp3')]);
  assert(
    plUi.querySelector('.playlist-count')?.textContent === '2',
    'UI playlist: contador se actualiza'
  );

  const rows = plUi.querySelectorAll('.playlist-item');
  assert(rows.length === 2 && rows[0].textContent === 'Uno', 'UI playlist: filas renderizadas');

  rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert(
    pl.store.get().selectedId === pl.store.get().items[0].id,
    'UI playlist: clic selecciona'
  );

  rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  assert(playedId === pl.store.get().items[0].id, 'UI playlist: doble clic reproduce');

  log('  ===== ui smoke ok =====');
}

// Reglas de seek con teclado (puras): flechas, Shift, Home/End y recortes.
function runSeekKeys(): void {
  log('\n===== seek: teclado =====');
  assert(seekKeyTarget('ArrowRight', false, 10, 200) === 15, 'flecha derecha: +5 s');
  assert(seekKeyTarget('ArrowLeft', false, 10, 200) === 5, 'flecha izquierda: -5 s');
  assert(seekKeyTarget('ArrowRight', true, 10, 200) === 40, 'Shift+flecha: +30 s');
  assert(seekKeyTarget('ArrowLeft', false, 3, 200) === 0, 'flecha izquierda: recorta a 0');
  assert(seekKeyTarget('ArrowRight', false, 198, 200) === 200, 'flecha derecha: recorta al final');
  assert(seekKeyTarget('Home', false, 42, 200) === 0, 'Home: al inicio');
  assert(seekKeyTarget('End', false, 42, 200) === 200, 'End: al final');
  assert(seekKeyTarget('ArrowUp', false, 42, 200) === null, 'tecla que no busca → null');
  assert(seekKeyTarget('ArrowRight', false, 10, 0) === null, 'sin duración → null');
  log('  ===== teclado ok =====');
}

// Validacion del codec M3U y del PlaylistController (Fase 2.1).
// El codec es puro (texto -> entradas), asi que se prueba sin I/O ni
// Electron. Los items cargados desde .m3u traen file: null a proposito:
// una lista no se volca a RAM; se lee al reproducir (Fase 2.2).
function runPlaylist(): void {
  log('\n===== playlist: codec m3u =====');

  // --- parseM3U: comentarios, EXTINF, CRLF, BOM ---
  const sample = [
    '#EXTM3U',
    '#EXTINF:123,Artista - Título',
    '/musica/tema.mp3',
    '',
    '#EXTINF:-1,Con, coma',
    'C:\\Music\\otro.flac',
    '# comentario suelto',
    'relativa/cancion.ogg'
  ].join('\r\n');
  const parsed = parseM3U('\uFEFF' + sample);
  assert(parsed.length === 3, 'parseM3U: 3 entradas (ignora comentarios y vacías)');
  assert(parsed[0].path === '/musica/tema.mp3', 'parseM3U: ruta POSIX leída');
  assert(parsed[0].title === 'Artista - Título', 'parseM3U: título del EXTINF');
  assert(parsed[1].path === 'C:\\Music\\otro.flac', 'parseM3U: ruta Windows leída');
  assert(parsed[1].title === 'Con, coma', 'parseM3U: título conserva comas tras la primera');
  assert(parsed[2].title === null, 'parseM3U: sin EXTINF el título queda null');
  assert(parsed[2].path === 'relativa/cancion.ogg', 'parseM3U: ruta relativa tal cual');

  // --- serialize -> parse round-trip ---
  const entries = [
    { path: '/a/uno.mp3', title: 'Uno' },
    { path: '/a/dos.mp3', title: null }
  ];
  const roundTrip = parseM3U(serializeM3U(entries));
  assert(roundTrip.length === 2, 'round-trip: 2 entradas');
  assert(roundTrip[0].path === '/a/uno.mp3' && roundTrip[0].title === 'Uno', 'round-trip: path y título estables');
  assert(roundTrip[1].title === null, 'round-trip: título null sobrevive');
  assert(serializeM3U(entries).startsWith('#EXTM3U'), 'serialize: encabezado #EXTM3U presente');

  // --- duraciones del EXTINF ---
  const withDurs = parseM3U(
    '#EXTM3U\n#EXTINF:214,Con duración\n/a/214.mp3\n#EXTINF:-1,Sin duración\n/a/menos1.mp3\n#EXTINF:190\n/a/sin-titulo.mp3\n'
  );
  assert(withDurs[0].duration === 214, 'parseM3U: duración del EXTINF');
  assert(withDurs[1].duration === null, 'parseM3U: -1 → duración desconocida');
  assert(withDurs[2].duration === 190 && withDurs[2].title === null, 'parseM3U: EXTINF sin coma → solo duración');
  assert(
    parseM3U('#EXTM3U\n#EXTINF:abc,X\n/a.mp3\n')[0].duration === null,
    'parseM3U: duración no numérica → null'
  );
  assert(
    serializeM3U([{ path: '/a/uno.mp3', title: 'Uno', duration: 214.4 }]).includes('#EXTINF:214,Uno'),
    'serialize: duración real (segundos redondeados)'
  );
  assert(
    parseM3U(serializeM3U([{ path: '/a/uno.mp3', title: 'Uno', duration: 214 }]))[0].duration === 214,
    'round-trip: duración sobrevive'
  );

  // --- file:// y normalización ---
  const fileUri = parseM3U('#EXTM3U\nfile:///home/u/tema.mp3\n');
  assert(fileUri[0].path === '/home/u/tema.mp3', 'file:// POSIX -> ruta');
  const winUri = parseM3U('#EXTM3U\nfile:///C:/Music/tema.mp3\n');
  assert(winUri[0].path === 'C:/Music/tema.mp3', 'file:// Windows -> ruta sin barra inicial');

  // --- helpers ---
  assert(displayNameFromPath('/musica/tema.mp3') === 'tema', 'displayNameFromPath: quita dir y extensión');
  assert(displayNameFromPath('C:\\x\\cancion.flac') === 'cancion', 'displayNameFromPath: separador Windows');
  assert(dirnameOf('/a/b/c.m3u') === '/a/b', 'dirnameOf: POSIX');
  assert(dirnameOf('C:\\a\\p.m3u') === 'C:\\a', 'dirnameOf: Windows');
  assert(isAbsolutePath('/x') && isAbsolutePath('C:\\x'), 'isAbsolutePath: absolutas reconocidas');
  assert(!isAbsolutePath('rel/x.mp3'), 'isAbsolutePath: relativa no lo es');
  assert(resolveEntryPath('t.mp3', '/listas') === '/listas/t.mp3', 'resolveEntryPath: relativa + baseDir');
  assert(resolveEntryPath('/abs/t.mp3', '/listas') === '/abs/t.mp3', 'resolveEntryPath: absoluta intacta');

  log('\n===== playlist: controller =====');
  const pl = new PlaylistController();

  // --- agregar (sin resolver de rutas: navegador) ---
  let emitted = 0;
  pl.store.subscribe(() => {
    emitted++;
  });
  pl.addFiles([new File([], 'Canción - Bonita.mp3'), new File([], 'otro eh.flac')]);
  const items = pl.store.get().items;
  assert(items.length === 2, 'addFiles: 2 items agregados');
  assert(items[0].name === 'Canción - Bonita', `addFiles: nombre sin extensión (${items[0].name})`);
  assert(items[0].path === null, 'addFiles: path null sin resolver (navegador)');
  assert(items[0].file !== null, 'addFiles: file conservado en memoria');
  assert(emitted === 1, 'addFiles: store emitió una vez');

  // --- selección y quitar ---
  pl.select(items[1].id);
  assert(pl.store.get().selectedId === items[1].id, 'select: fija selectedId');
  pl.removeSelected();
  const afterRemove = pl.store.get();
  assert(afterRemove.items.length === 1, 'removeSelected: quitó el seleccionado');
  assert(afterRemove.items[0].name === 'Canción - Bonita', 'removeSelected: quedó el otro');
  // Al quitar el seleccionado y aún quedar items, la selección avanza al
  // restante (estándar de lista), no se anula.
  assert(
    afterRemove.selectedId === afterRemove.items[0].id,
    'removeSelected: selección avanza al item restante'
  );
  // Sin selección, quitar es no-op.
  pl.select(null);
  pl.removeSelected();
  assert(pl.store.get().items.length === 1, 'removeSelected: sin selección es no-op');

  // --- selección avanza al siguiente al quitar ---
  pl.addFiles([new File([], 'b.mp3'), new File([], 'c.mp3'), new File([], 'd.mp3')]);
  // items: [Canción, b, c, d]
  pl.select(pl.store.get().items[1].id); // b
  pl.removeSelected();
  assert(
    pl.store.get().items.map((i) => i.name).join(',') === 'Canción - Bonita,c,d',
    'removeSelected: quita enmedio y conserva orden'
  );
  assert(pl.store.get().selectedId === pl.store.get().items[1].id, 'removeSelected: selección avanza al siguiente');

  // --- toM3U con resolver de rutas ---
  const withPaths = new PlaylistController((file) => `/musica/${file.name}`);
  withPaths.addFiles([new File([], 'tema.mp3'), new File([], 'otro.mp3')]);
  const m3uText = withPaths.toM3U();
  assert(m3uText.includes('/musica/tema.mp3'), 'toM3U: escribe la ruta resuelta');
  assert(m3uText.includes('#EXTINF:-1,tema'), 'toM3U: escribe EXTINF con nombre');
  const reparsed = parseM3U(m3uText);
  assert(reparsed.length === 2 && reparsed[0].path === '/musica/tema.mp3', 'toM3U: round-trip estable');

  // Con duración medida (setDuration): el .m3u lleva segundos reales.
  withPaths.setDuration(withPaths.store.get().items[0].id, 65.4);
  assert(withPaths.toM3U().includes('#EXTINF:65,tema'), 'toM3U: duración medida → segundos reales');

  // --- toM3U sin resolver: degrada a nombre ---
  assert(pl.toM3U().includes('Canción - Bonita'), 'toM3U sin path: degrada a nombre');

  // --- fromM3U: items con file null (no se leen bytes) ---
  const loaded = new PlaylistController();
  loaded.fromM3U('#EXTM3U\n#EXTINF:40,Título Bonito\n/musica/cargado.mp3\n');
  const loadedItems = loaded.store.get().items;
  assert(loadedItems.length === 1, 'fromM3U: 1 item');
  assert(loadedItems[0].name === 'Título Bonito', 'fromM3U: usa título del EXTINF');
  assert(loadedItems[0].file === null, 'fromM3U: file null (bytes no se leen al cargar)');
  assert(loadedItems[0].path === '/musica/cargado.mp3', 'fromM3U: path guardado');
  assert(loadedItems[0].duration === 40, 'fromM3U: duración del EXTINF guardada en el item');

  // --- fromM3U con baseDir resuelve relativas ---
  loaded.fromM3U('relativa.mp3\n', '/listas');
  assert(loaded.store.get().items[0].path === '/listas/relativa.mp3', 'fromM3U: relativa + baseDir resuelta');
  assert(loaded.store.get().items[0].name === 'relativa', 'fromM3U: sin EXTINF el nombre sale del archivo');

  // --- fromM3U reemplaza la lista (estilo Winamp: cargar = nueva lista) ---
  assert(loaded.store.get().items.length === 1, 'fromM3U: reemplaza la lista anterior');

  log('  ===== playlist ok =====');
}

// ===== Ajustes 2 y 3: transporte playlist ⇄ player =====

/**
 * Ajuste 1 (limpiar) + playingId + materialización + orquestación con
 * stub de player. Todo sin audio: valida la lógica de continuidad.
 */
async function runPlaylistTransport(): Promise<void> {
  log('\n===== playlist: limpiar =====');
  const pl = new PlaylistController();
  pl.addFiles([new File([], 'a.mp3'), new File([], 'b.mp3')]);
  let emitted = 0;
  const off = pl.store.subscribe(() => {
    emitted++;
  });
  pl.clear();
  assert(pl.store.get().items.length === 0, 'clear: vacía la lista');
  assert(pl.store.get().selectedId === null, 'clear: deselecciona');
  assert(pl.store.get().playingId === null, 'clear: playingId a null (no hay continuidad)');
  assert(emitted === 1, 'clear: emite una vez');
  pl.clear();
  assert(emitted === 1, 'clear sobre lista vacía: no-op (no emite)');
  off();

  log('\n===== playlist: playingId y navegación =====');
  const pl2 = new PlaylistController();
  pl2.addFiles([new File([], '1.mp3'), new File([], '2.mp3'), new File([], '3.mp3')]);
  const [i1, i2, i3] = pl2.store.get().items;
  assert(pl2.firstItem()?.id === i1.id, 'firstItem: primer item');
  assert(pl2.nextOf(i1.id)?.id === i2.id, 'nextOf: siguiente correcto');
  assert(pl2.nextOf(i3.id) === null, 'nextOf: último item → null');
  assert(pl2.nextOf('inexistente') === null, 'nextOf: id desconocido → null');

  pl2.setPlaying(i2.id);
  assert(pl2.store.get().playingId === i2.id, 'setPlaying: id válido se fija');
  pl2.setPlaying('inexistente');
  assert(pl2.store.get().playingId === null, 'setPlaying: id fuera de la lista → null');
  pl2.setPlaying(i2.id);
  pl2.select(i2.id);
  pl2.removeSelected();
  assert(pl2.store.get().items.length === 2, 'remove del que suena: la lista queda (audio no se corta)');
  assert(pl2.store.get().playingId === null, 'remove del que suena: playingId → null (para al terminar)');

  pl2.fromM3U('#EXTM3U\n/otra.mp3\n');
  assert(pl2.store.get().playingId === null, 'fromM3U: playingId reseteado (lista nueva)');

  log('\n===== playlist: materializar bytes =====');
  const fileItem = {
    id: 'x',
    name: 'memoria',
    file: new File(['hola'], 'memoria.mp3'),
    path: '/ruta/memoria.mp3',
    duration: null
  };
  let readCalls = 0;
  const fakeRead = async (path: string): Promise<Uint8Array | null> => {
    readCalls++;
    return new TextEncoder().encode('bytes:' + path);
  };
  const direct = await resolvePlaylistFile(fileItem, fakeRead);
  assert(direct === fileItem.file, 'materializar: item con file → se usa tal cual');
  assert(readCalls === 0, 'materializar: no toca disco si ya tiene file');

  const diskItem = { id: 'y', name: 'disco', file: null, path: '/musica/tema ok.mp3', duration: null };
  const fromDisk = await resolvePlaylistFile(diskItem, fakeRead);
  assert(fromDisk !== null, 'materializar: item de m3u → lee por IPC');
  assert(fromDisk!.name === 'tema ok.mp3', 'materializar: File nombrado con el basename del path');
  assert(readCalls === 1, 'materializar: una sola lectura');
  const bytes = new Uint8Array(await fromDisk!.arrayBuffer());
  assert(new TextDecoder().decode(bytes) === 'bytes:/musica/tema ok.mp3', 'materializar: bytes correctos');

  const missing = await resolvePlaylistFile(diskItem, async () => null);
  assert(missing === null, 'materializar: lectura fallida → null (no lanza)');
  const noReader = await resolvePlaylistFile(diskItem);
  assert(noReader === null, 'materializar: sin reader (navegador) → null');
  const noPath = await resolvePlaylistFile({ id: 'z', name: 'nada', file: null, path: null, duration: null });
  assert(noPath === null, 'materializar: sin file ni path → null');

  log('\n===== playlist: orquestación (stub player) =====');
  const stubHooks: { current: PlaybackHooks | null } = {
    current: null
  };
  const loaded: Track[] = [];
  const failIds = new Set<string>();
  const stub = {
    store: new Store<PlayerState>(initialPlayerState),
    setHooks: (h: PlaybackHooks): void => {
      stubHooks.current = h;
    },
    loadTrack: async (t: Track): Promise<void> => {
      if (failIds.has(t.id)) throw new Error('decode fail');
      loaded.push(t);
      // El engine real mide la duración al decodificar: el stub lo imita.
      stub.store.set({ currentTrack: t, isPlaying: true, duration: 123 });
    }
  };

  const pl3 = new PlaylistController();
  connectPlaylistPlayback({ player: stub, playlist: pl3 });
  assert(stubHooks.current !== null, 'connect: instaló los hooks en el transporte');
  assert(stub.store.get().canStartFromPlaylist === false, 'connect: lista vacía → Play sigue deshabilitado');

  pl3.addFiles([new File([], 'uno.mp3'), new File([], 'dos.mp3')]);
  const [u1, u2] = pl3.store.get().items;
  assert(stub.store.get().canStartFromPlaylist === true, 'connect: con lista → Play habilitado (req 3)');

  // Req 3: play() sin pista → primer item.
  const handled = await stubHooks.current!.onPlayEmpty!();
  assert(handled === true, 'req3: onPlayEmpty manejó la petición');
  // item.name es el nombre SIN extensión (displayNameFromPath): así viaja
  // como Track.title, que es lo que la UI muestra como fallback.
  assert(loaded.length === 1 && loaded[0].title === 'uno', 'req3: cargó el PRIMER item');
  assert(pl3.store.get().playingId === u1.id, 'req3: playingId = primer item');
  assert(pl3.store.get().items[0].duration === 123, 'req3: duración medida guardada en el item');
  assert(stub.store.get().canStartFromPlaylist === true, 'req3: espejo sigue true (hay lista)');

  // Req 2: fin de pista → siguiente.
  await stubHooks.current!.onTrackEnded!();
  assert(loaded.length === 2 && loaded[1].title === 'dos', 'req2: onTrackEnded cargó el segundo');
  assert(pl3.store.get().playingId === u2.id, 'req2: playingId avanzó');

  // Fin de lista → para (decisión de producto: sin repeat).
  const loadedAtEnd = loaded.length;
  await stubHooks.current!.onTrackEnded!();
  assert(loaded.length === loadedAtEnd, 'fin de lista: para (no carga nada)');

  // playingId null → no intenta avanzar.
  pl3.setPlaying(null);
  await stubHooks.current!.onTrackEnded!();
  assert(loaded.length === loadedAtEnd, 'sin playingId: no avanza');

  // Item ilegible en medio: se salta al siguiente legible.
  const pl4 = new PlaylistController();
  connectPlaylistPlayback({ player: stub, playlist: pl4 });
  pl4.addFiles([new File([], 'ok1.mp3')]);
  pl4.store.set({
    items: [
      ...pl4.store.get().items,
      { id: 'ilegible', name: 'ilegible', file: null, path: null, duration: null },
      { id: 'ok2', name: 'ok2', file: new File([], 'ok2.mp3'), path: null, duration: null }
    ]
  });
  const [k1, , k2] = pl4.store.get().items;
  pl4.setPlaying(k1.id);
  const beforeSkip = loaded.length;
  await stubHooks.current!.onTrackEnded!();
  assert(
    loaded.length === beforeSkip + 1 && loaded[loaded.length - 1].id === k2.id,
    'item ilegible: se salta y sigue con el siguiente'
  );
  assert(pl4.store.get().playingId === k2.id, 'skip: playingId saltó al legible');

  // loadTrack falla → playingId anulado, no promete continuidad.
  const pl5 = new PlaylistController();
  const pb5 = connectPlaylistPlayback({ player: stub, playlist: pl5 });
  pl5.addFiles([new File([], 'rota.mp3')]);
  const r1 = pl5.store.get().items[0];
  failIds.add(r1.id);
  const failResult = await pb5.playItem(r1.id);
  assert(failResult === false, 'loadTrack fallido → playItem devuelve false');
  assert(pl5.store.get().playingId === null, 'loadTrack fallido → playingId anulado');
  failIds.delete(r1.id);
  const retry = await pb5.playItem(r1.id);
  assert(retry === true, 'reintento tras fallo → true');
  assert(pl5.store.get().playingId === r1.id, 'reintento → playingId fijado');

  // play() con hook que no maneja → cae al engine sin lanzar.
  const enginePlayer = new PlayerController(new WebAudioEngine());
  let hookCalls = 0;
  enginePlayer.setHooks({
    onPlayEmpty: async () => {
      hookCalls++;
      return false;
    }
  });
  await enginePlayer.play();
  assert(hookCalls === 1, 'play() sin pista: invoca onPlayEmpty');
  assert(enginePlayer.store.get().currentTrack === null, 'play() sin pista ni lista: no-op seguro');
  enginePlayer.dispose();

  log('  ===== transporte ok =====');
}

/**
 * Integración real: MP3 de verdad, engine real, reproducción y avance
 * automático de pista (los req 2 y 3 de punta a punta).
 */
async function runPlaylistIntegration(paths: string[]): Promise<void> {
  log('\n===== playlist: integración real (auto-avance) =====');
  if (paths.length === 0) {
    log('  (sin MP3s: se omite)');
    return;
  }

  const toFile = async (p: string): Promise<File> => {
    const bytes = await window.crossampTest!.readFile(p);
    const name = p.split(/[\\/]/).pop() ?? 'pista.mp3';
    return new File([bytes], name);
  };

  const pl = new PlaylistController();
  pl.addFiles([await toFile(paths[0]), await toFile(paths[1] ?? paths[0])]);
  const items = pl.store.get().items;

  const player = new PlayerController(new WebAudioEngine());
  connectPlaylistPlayback({ player, playlist: pl });

  assert(player.store.get().canStartFromPlaylist, 'req3: Play habilitado con lista y sin pista');
  assert(player.store.get().currentTrack === null, 'req3: arranca sin pista cargada');

  // Req 3: play() sin pista → reproduce desde el primer item.
  await player.play();
  const s1 = player.store.get();
  assert(s1.currentTrack !== null, 'req3: Play arrancó desde la lista');
  assert(s1.currentTrack?.title === items[0].name, 'req3: es el PRIMER item');
  assert(pl.store.get().playingId === items[0].id, 'req3: playingId = primer item');
  assert(s1.isPlaying, 'req3: reproduciendo');
  assert(s1.duration > 0, 'req3: duración medida por el engine');
  const firstItemDur = pl.store.get().items[0].duration;
  assert(
    firstItemDur !== null && Math.abs(firstItemDur - s1.duration) < 1,
    'req3: duración del item = la medida por el engine'
  );

  // Req 2: acercamos el final y esperamos el avance automático.
  player.seek(Math.max(0, s1.duration - 0.4));
  await sleep(2500);
  const s2 = player.store.get();
  assert(pl.store.get().playingId === items[1].id, 'req2: avanzó al segundo item');
  assert(s2.currentTrack?.title === items[1].name, 'req2: segunda pista cargada');
  assert(s2.isPlaying, 'req2: continúa sonando tras el avance');
  assert(!player.store.get().isLoading, 'req2: avance terminado (no isLoading)');

  // Fin de lista → para (sin repeat).
  const dur2 = player.store.get().duration;
  player.seek(Math.max(0, dur2 - 0.4));
  await sleep(2500);
  const s3 = player.store.get();
  assert(!s3.isPlaying, 'fin de lista: detenido');
  assert(s3.currentTrack?.title === items[1].name, 'fin de lista: sin cargas nuevas');
  assert(s3.position >= s3.duration - 0.5, 'fin de lista: posicion al final');

  player.dispose();
  log('  ===== integración ok =====');
}

async function main(): Promise<void> {
  if (!window.crossampTest) {
    log('FATAL: API de test no expuesta por el preload');
    report(1);
    return;
  }

  const paths = window.crossampTest.paths;
  log(`Archivos a probar: ${paths.length}`);

  for (const p of paths) {
    try {
      await runOne(p);
    } catch (err) {
      failures++;
      log(`[FAIL] excepcion en runOne: ${String(err)}`);
    }
  }

  // Cableado controller/store: basta con un archivo.
  if (paths.length > 0) {
    try {
      await runController(paths[0]);
    } catch (err) {
      failures++;
      log(`[FAIL] excepcion en runController: ${String(err)}`);
    }
  }

  // Parser ID3: contra todos los archivos.
  for (const p of paths) {
    try {
      await runMetadata(p);
    } catch (err) {
      failures++;
      log(`[FAIL] excepcion en runMetadata: ${String(err)}`);
    }
  }

  // Integracion: el controller refleja los metadatos en el store.
  if (paths.length > 0) {
    try {
      await runControllerMetadata(paths[0]);
    } catch (err) {
      failures++;
      log(`[FAIL] excepcion en runControllerMetadata: ${String(err)}`);
    }
  }

  // Codec M3U + controller de playlist (Fase 2.1). No necesita MP3s:
  // es logica pura sobre texto y File sintéticos.
  try {
    runPlaylist();
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runPlaylist: ${String(err)}`);
  }

  // Reglas de seek con teclado (puras, sin audio).
  try {
    runSeekKeys();
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runSeekKeys: ${String(err)}`);
  }

  // Smoke de UI (Fase 3): estructura de paneles y handlers básicos.
  try {
    runUiSmoke();
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runUiSmoke: ${String(err)}`);
  }

  // Ajustes 2 y 3: transporte playlist ⇄ player (clear, playingId,
  // materializar, orquestación con stub).
  try {
    await runPlaylistTransport();
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runPlaylistTransport: ${String(err)}`);
  }

  // De punta a punta con MP3 reales: Play desde lista y auto-avance.
  try {
    await runPlaylistIntegration(paths);
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runPlaylistIntegration: ${String(err)}`);
  }

  log(`\n########## RESULTADO: ${failures === 0 ? 'TODO OK' : `${failures} FALLOS`} ##########`);
  report(failures === 0 ? 0 : 1);
}

function report(code: number): void {
  // El mainprocess escucha esta linea para salir con el codigo adecuado.
  console.log(`__CROSSAMP_TEST_DONE__${code}`);
}

void main();
