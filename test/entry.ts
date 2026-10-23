import { WebAudioEngine } from '../src/renderer/src/audio/WebAudioEngine';
import { PlayerController } from '../src/renderer/src/state/PlayerController';
import { parseID3 } from '../src/renderer/src/metadata/mp3';
import type { Track } from '../src/renderer/src/state/store';

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
  assert(afterLoad.isPlaying === false, 'isPlaying false tras cargar');
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
async function runMetadata(path: string): Promise<void> {
  const name = path.split(/[\\/]/).pop() ?? path;
  log(`\n===== metadata: ${name} =====`);

  const bytes = await window.crossampTest!.readFile(path);
  const meta = parseID3(bytes);

  // duration lo aporta el engine, nunca el parser.
  assert(meta.duration === null, 'duration queda null (no la estima el parser)');

  // title/artist/album: string no vacio o null, nunca cadena vacia.
  for (const [k, v] of Object.entries({
    title: meta.title,
    artist: meta.artist,
    album: meta.album
  })) {
    assert(v === null || (typeof v === 'string' && v.length > 0), `${k}: null o string no vacio`);
  }

  log(`  title=${JSON.stringify(meta.title)} artist=${JSON.stringify(meta.artist)} album=${JSON.stringify(meta.album)}`);

  // Caratula: si existe, debe ser un data URL de imagen valido.
  if (meta.picture !== null) {
    assert(/^data:image\/(png|jpeg|webp|gif);base64,/.test(meta.picture), 'picture es un data URL de imagen');
    assert(meta.picture.length > 1000, `picture tiene contenido real (${meta.picture.length} chars)`);
    // En estos ficheros concretos la caratula es PNG (verificado).
    assert(meta.picture.startsWith('data:image/png;base64,'), 'picture es PNG (dato verificado en estos MP3)');
  } else {
    log('  (sin caratula en este archivo)');
  }

  log('  ===== metadata ok =====');
}

// Integracion: el controller debe reflejar los metadatos en el store tras
// loadTrack(). Con estos MP3 reales no hay frames de texto, pero si hay
// caratula PNG, asi que validamos que metadata llega con el picture.
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
  assert(
    state.metadata?.duration === null,
    'metadata.duration sigue null (la duracion exacta va en state.duration)'
  );
  assert(state.duration > 0, 'state.duration poblado desde el engine');
  assert(
    state.metadata?.picture?.startsWith('data:image/png;base64,') === true,
    'metadata.picture con caratula PNG reflejada en el store'
  );

  controller.dispose();
  log('  ===== controller+metadata ok =====');
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

  log(`\n########## RESULTADO: ${failures === 0 ? 'TODO OK' : `${failures} FALLOS`} ##########`);
  report(failures === 0 ? 0 : 1);
}

function report(code: number): void {
  // El mainprocess escucha esta linea para salir con el codigo adecuado.
  console.log(`__CROSSAMP_TEST_DONE__${code}`);
}

void main();
