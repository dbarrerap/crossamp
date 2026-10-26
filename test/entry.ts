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
  isM3UFileName,
  resolveEntryPath
} from '../src/renderer/src/playlist/m3u';
import { PlaylistController } from '../src/renderer/src/playlist/PlaylistController';
import { handleDroppedFiles } from '../src/renderer/src/playlist/drop';
import { resolvePlaylistFile } from '../src/renderer/src/playlist/materialize';
import { connectPlaylistPlayback } from '../src/renderer/src/playlist/connect';
import { seekKeyTarget } from '../src/renderer/src/ui/seek';
import type { AudioEngine } from '../src/renderer/src/audio/AudioEngine';
import { createPlayerUI } from '../src/renderer/src/ui/player';
import { createPlaylistUI } from '../src/renderer/src/ui/playlist';
import { attachFileDrop } from '../src/renderer/src/ui/drop';
import {
  buildSession,
  decodeSession,
  encodeSession,
  SESSION_VERSION
} from '../src/renderer/src/persistence/session';
import { loadSession, saveSession, type StorageLike } from '../src/renderer/src/persistence/storage';
import { connectSessionPersistence, restoreSession } from '../src/renderer/src/persistence/connect';
import { connectMediaSession, type MediaSessionLike } from '../src/renderer/src/media/session';
import { handleMediaAction } from '../src/renderer/src/media/actions';
import { endTimeOf, startBuffer } from '../src/renderer/src/audio/gapless';

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

/** Engine falso para tests sin audio (UI, persistencia). */
function createFakeEngine(): AudioEngine {
  return {
    load: async () => {},
    decode: async () => ({ duration: 100 } as AudioBuffer),
    queue: () => 0,
    clearQueue: () => {},
    play: () => {},
    pause: () => {},
    seek: () => {},
    getTime: () => 0,
    getDuration: () => 100,
    isPlaying: () => false,
    setVolume: () => {},
    onEnded: () => {},
    dispose: () => {}
  };
}

/** Storage en memoria para tests, con la interfaz de localStorage. */
function createMemoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    }
  };
}

/**
 * Persistencia de sesión: codec puro, storage con fallos, restore de lista,
 * loadTrack en pausa y el wiring completo (guardado + restauración).
 */
async function runPersistence(): Promise<void> {
  log('\n===== persistencia: codec y storage =====');

  // --- buildSession: solo items con ruta, con duración y última pista ---
  const source = new PlaylistController();
  source.restore([
    { name: 'Uno', path: '/a/uno.mp3', duration: 65 },
    { name: 'Sin ruta', path: null, duration: null }
  ]);
  const session = buildSession(source.store.get().items, {
    name: 'Uno',
    path: '/a/uno.mp3',
    position: 12.5
  });
  assert(session.version === SESSION_VERSION, 'sesión: versión actual');
  assert(session.playlist.length === 1, 'sesión: descarta items sin ruta');
  assert(session.playlist[0].duration === 65, 'sesión: conserva duración');
  assert(session.last?.position === 12.5, 'sesión: conserva posición');

  // --- round-trip ---
  const decoded = decodeSession(encodeSession(session));
  assert(
    decoded !== null &&
      decoded.playlist[0]?.path === '/a/uno.mp3' &&
      decoded.last?.name === 'Uno',
    'sesión: round-trip encode/decode'
  );

  // --- tolerancia a datos corruptos/antiguos ---
  assert(decodeSession(null) === null, 'sesión: null → null');
  assert(decodeSession('no es json') === null, 'sesión: JSON inválido → null');
  assert(
    decodeSession(JSON.stringify({ version: 999, playlist: [] })) === null,
    'sesión: versión desconocida → null'
  );
  const tolerant = decodeSession(
    JSON.stringify({
      version: SESSION_VERSION,
      playlist: [
        { name: 'ok', path: '/ok.mp3', duration: -3 },
        { name: 'sin path' },
        'basura'
      ],
      last: { name: 'x', path: '', position: -2 }
    })
  );
  assert(
    tolerant !== null &&
      tolerant.playlist.length === 1 &&
      tolerant.playlist[0].duration === null,
    'sesión: items inválidos descartados y duración saneada'
  );
  assert(tolerant?.last === null, 'sesión: última pista inválida descartada');

  // --- storage con fallos ---
  const storage = createMemoryStorage();
  saveSession(storage, session);
  assert(loadSession(storage)?.playlist.length === 1, 'storage: guarda y recupera');

  const broken: StorageLike = {
    getItem: () => {
      throw new Error('bloqueado');
    },
    setItem: () => {
      throw new Error('lleno');
    },
    removeItem: () => {}
  };
  assert(loadSession(broken) === null, 'storage: lectura bloqueada → null');
  saveSession(broken, session); // no debe lanzar
  assert(true, 'storage: escritura bloqueada no lanza');

  log('\n===== persistencia: restauración =====');
  const player = new PlayerController(createFakeEngine());
  const playlist = new PlaylistController();
  const restored = await restoreSession({
    player,
    playlist,
    storage,
    readFile: async () => new Uint8Array([0x49, 0x44, 0x33])
  });
  assert(restored === true, 'restore: había sesión');
  assert(playlist.store.get().items.length === 1, 'restore: lista recuperada');
  assert(
    playlist.store.get().selectedId === playlist.store.get().items[0].id,
    'restore: la pista restaurada queda seleccionada'
  );
  assert(player.store.get().currentTrack?.title === 'Uno', 'restore: pista cargada');
  assert(player.store.get().isPlaying === false, 'restore: carga EN PAUSA');

  // La playlist domina: si la pista está en la lista, se delega loadItem.
  const playerP = new PlayerController(createFakeEngine());
  const playlistP = new PlaylistController();
  const delegated: Array<{ id: string; position: number }> = [];
  const restoredP = await restoreSession({
    player: playerP,
    playlist: playlistP,
    storage,
    readFile: async () => new Uint8Array([0x49, 0x44, 0x33]),
    loadItem: async (id, position) => {
      delegated.push({ id, position });
      return true;
    }
  });
  assert(restoredP === true, 'restore playlist: true');
  assert(delegated.length === 1, 'restore playlist: delega en loadItem');
  assert(
    delegated[0].id === playlistP.store.get().items[0].id,
    'restore playlist: usa el id del item restaurado'
  );
  assert(
    delegated[0].position === 12.5,
    'restore playlist: pasa la posición guardada'
  );
  assert(
    playlistP.store.get().selectedId === delegated[0].id,
    'restore playlist: selecciona el item'
  );
  assert(
    playerP.store.get().currentTrack === null,
    'restore playlist: no carga standalone si la playlist lo hizo'
  );
  playerP.dispose();

  // Si la playlist no puede cargarlo, cae al respaldo standalone.
  const playerF = new PlayerController(createFakeEngine());
  const playlistF = new PlaylistController();
  await restoreSession({
    player: playerF,
    playlist: playlistF,
    storage,
    readFile: async () => new Uint8Array([0x49, 0x44, 0x33]),
    loadItem: async () => false
  });
  assert(
    playerF.store.get().currentTrack?.title === 'Uno',
    'restore playlist: fallback standalone si loadItem falla'
  );
  playerF.dispose();

  // Regresión: tras restaurar, el siguiente guardado no debe borrar `last`
  // (antes la pista restaurada no tenía ruta y el snapshot la anulaba).
  const keep = connectSessionPersistence({ player, playlist, storage });
  keep.flush();
  assert(
    loadSession(storage)?.last?.path === '/a/uno.mp3',
    'restore: el guardado conserva la última pista'
  );
  keep.dispose();
  player.dispose();

  // Sin bytes (archivo movido): conserva la lista y no lanza.
  const player2 = new PlayerController(createFakeEngine());
  const playlist2 = new PlaylistController();
  await restoreSession({
    player: player2,
    playlist: playlist2,
    storage,
    readFile: async () => null
  });
  assert(playlist2.store.get().items.length === 1, 'restore sin bytes: conserva la lista');
  assert(player2.store.get().currentTrack === null, 'restore sin bytes: no carga pista');
  player2.dispose();

  // --- loadTrack autoplay:false ---
  const paused = new PlayerController(createFakeEngine());
  await paused.loadTrack(
    { id: 'p', title: 'P', file: new File([], 'p.mp3') },
    { autoplay: false }
  );
  assert(!paused.store.get().isPlaying, 'loadTrack autoplay:false: no reproduce');
  assert(paused.store.get().duration === 100, 'loadTrack autoplay:false: duración reflejada');
  paused.dispose();

  // --- wiring: guarda al cambiar (flush) ---
  const player3 = new PlayerController(createFakeEngine());
  const playlist3 = new PlaylistController();
  const storage3 = createMemoryStorage();
  const persistence = connectSessionPersistence({
    player: player3,
    playlist: playlist3,
    storage: storage3
  });
  playlist3.restore([{ name: 'Dos', path: '/b/dos.mp3', duration: 30 }]);
  persistence.flush();
  const saved = loadSession(storage3);
  assert(
    saved !== null &&
      saved.playlist.length === 1 &&
      saved.playlist[0].path === '/b/dos.mp3',
    'wiring: guarda la lista'
  );
  persistence.dispose();
  player3.dispose();

  // Sin sesión guardada: no toca nada y avisa con false.
  const emptyStorage = createMemoryStorage();
  const player4 = new PlayerController(createFakeEngine());
  const playlist4 = new PlaylistController();
  const nothing = await restoreSession({
    player: player4,
    playlist: playlist4,
    storage: emptyStorage
  });
  assert(nothing === false, 'restore: sin sesión → false');
  player4.dispose();

  log('  ===== persistencia ok =====');
}

/**
 * Smoke tests de UI (Fase 3): construyen los paneles reales con un engine
 * falso y verifican estructura + interacciones básicas. No reproducen audio;
 * protegen el rediseño Bento de romper selectores o handlers.
 */
function runUiSmoke(): void {
  log('\n===== ui: smoke =====');

  // --- Player ---
  const opened: File[] = [];
  const player = new PlayerController(createFakeEngine());
  const ui = createPlayerUI(player, {
    openFile: (file) => {
      opened.push(file);
    }
  });

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

  const ejectInput = ui.querySelector('input[type=file]') as HTMLInputElement | null;
  assert(
    ejectInput !== null && ejectInput.accept.includes('.m3u'),
    'UI player: el eject acepta audio y .m3u'
  );
  const chosen = new File([], 'elegida.mp3');
  if (ejectInput) {
    Object.defineProperty(ejectInput, 'files', { value: [chosen], configurable: true });
    ejectInput.dispatchEvent(new Event('change'));
  }
  assert(opened[0] === chosen, 'UI player: el eject delega en openFile');

  const playBtn = ui.querySelector('.player-btn-primary') as HTMLButtonElement | null;
  const prevBtn = ui.querySelector('button[aria-label="Anterior"]') as HTMLButtonElement | null;
  const nextBtn = ui.querySelector('button[aria-label="Siguiente"]') as HTMLButtonElement | null;
  assert(
    playBtn !== null && prevBtn !== null && nextBtn !== null,
    'UI player: Play/Prev/Next presentes'
  );
  assert(playBtn?.disabled === true, 'UI player: Play deshabilitado sin pista');
  assert(prevBtn?.disabled === true, 'UI player: Prev deshabilitado sin pista');
  assert(nextBtn?.disabled === true, 'UI player: Next deshabilitado sin pista ni lista');

  player.store.set({ canStartFromPlaylist: true });
  assert(playBtn?.disabled === false, 'UI player: Play habilitado con lista');
  assert(nextBtn?.disabled === false, 'UI player: Next habilitado con lista');

  player.store.set({
    currentTrack: { id: 't', title: 'T', file: new File([], 't.mp3') }
  });
  assert(prevBtn?.disabled === false, 'UI player: Prev habilitado con pista');
  player.dispose();

  // --- Playlist ---
  const pl = new PlaylistController();
  let playedId: string | null = null;
  const plUi = createPlaylistUI(pl, {
    playItem: (id) => {
      playedId = id;
    }
  });

  const sortItem = [...plUi.querySelectorAll('.playlist-menu-item')].find(
    (item) => item.textContent === 'Ordenar por nombre'
  ) as HTMLButtonElement | undefined;
  assert(sortItem?.disabled === true, 'UI playlist: orden deshabilitado con <2 items');

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

  // Orden desde el menú.
  assert(sortItem?.disabled === false, 'UI playlist: orden habilitado con 2 items');
  sortItem?.click();
  assert(
    pl.store.get().items.map((item) => item.name).join(',') === 'Dos,Uno',
    'UI playlist: ordenar por nombre desde el menú'
  );

  // --- Zona de drop ---
  const zone = document.createElement('div');
  const dropped: File[][] = [];
  attachFileDrop(zone, (files) => dropped.push(files));
  const dt = new DataTransfer();
  dt.items.add(new File([], 'drop.mp3'));
  zone.dispatchEvent(
    new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
  );
  assert(zone.classList.contains('drag-over'), 'drop: resalta la zona al arrastrar');
  zone.dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
  );
  assert(
    dropped.length === 1 && dropped[0][0]?.name === 'drop.mp3',
    'drop: entrega los archivos'
  );
  assert(!zone.classList.contains('drag-over'), 'drop: quita el resaltado');

  log('  ===== ui smoke ok =====');
}

/**
 * Teclas multimedia y atajos globales: despacho de acciones y MediaSession
 * con fakes (metadata, playbackState y handlers).
 */
function runMedia(): void {
  log('\n===== media: teclas y atajos =====');

  // --- Despacho de acciones de los atajos globales ---
  const toggles: string[] = [];
  const calls: string[] = [];
  const actionDeps = {
    player: {
      toggle: () => {
        toggles.push('toggle');
      }
    },
    playback: {
      next: async () => {
        calls.push('next');
        return true;
      },
      previous: async () => {
        calls.push('previous');
        return true;
      }
    }
  };

  assert(
    handleMediaAction('play-pause', actionDeps) === true && toggles.length === 1,
    'media action: play-pause'
  );
  assert(handleMediaAction('next', actionDeps) === true, 'media action: next');
  assert(handleMediaAction('previous', actionDeps) === true, 'media action: previous');
  assert(calls.join(',') === 'next,previous', 'media action: despacha next/previous');
  assert(handleMediaAction('desconocida', actionDeps) === false, 'media action: desconocida → false');

  // --- MediaSession ---
  let playingFlag = false;
  let lastSeek = -1;
  const engine: AudioEngine = {
    load: async () => {},
    decode: async () => ({ duration: 100 } as AudioBuffer),
    queue: () => 0,
    clearQueue: () => {},
    play: () => {
      playingFlag = true;
    },
    pause: () => {
      playingFlag = false;
    },
    seek: (seconds: number) => {
      lastSeek = seconds;
    },
    getTime: () => 42,
    getDuration: () => 100,
    isPlaying: () => playingFlag,
    setVolume: () => {},
    onEnded: () => {},
    dispose: () => {}
  };

  const player = new PlayerController(engine);
  const trackCalls: string[] = [];
  const playback = {
    next: async () => {
      trackCalls.push('next');
      return true;
    },
    previous: async () => {
      trackCalls.push('previous');
      return true;
    }
  };

  const handlers = new Map<string, (details?: { seekTime?: number }) => void>();
  const session: MediaSessionLike = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: (action, handler) => {
      if (handler) {
        handlers.set(action, handler as unknown as (details?: { seekTime?: number }) => void);
      } else {
        handlers.delete(action);
      }
    }
  };

  const metas: Array<{ title?: string; artist?: string; album?: string }> = [];
  connectMediaSession({
    player,
    playback,
    mediaSession: session,
    createMetadata: (init) => {
      metas.push(init);
      return init as unknown as MediaMetadata;
    }
  });

  assert(session.playbackState === 'none', 'mediaSession: none sin pista');

  player.store.set({
    currentTrack: { id: 'm1', title: 'T', file: new File([], 't.mp3') },
    metadata: { title: 'Canción', artist: 'Artista', album: 'Álbum', picture: null },
    duration: 100
  });
  assert(session.playbackState === 'paused', 'mediaSession: paused con pista');
  assert(
    metas[metas.length - 1]?.title === 'Canción' &&
      metas[metas.length - 1]?.artist === 'Artista',
    'mediaSession: metadata del tag'
  );

  player.store.set({ isPlaying: true });
  assert(session.playbackState === 'playing', 'mediaSession: playing');

  handlers.get('pause')?.();
  assert(player.store.get().isPlaying === false, 'mediaSession: pause');
  handlers.get('play')?.();
  assert(player.store.get().isPlaying === true, 'mediaSession: play');

  handlers.get('nexttrack')?.();
  handlers.get('previoustrack')?.();
  assert(trackCalls.join(',') === 'next,previous', 'mediaSession: next/previous');

  handlers.get('seekforward')?.();
  assert(lastSeek === 52, 'mediaSession: seekforward +10 s');
  handlers.get('seekbackward')?.();
  assert(lastSeek === 32, 'mediaSession: seekbackward -10 s');
  handlers.get('seekto')?.({ seekTime: 12 });
  assert(lastSeek === 12, 'mediaSession: seekto');

  player.dispose();
  log('  ===== media ok =====');
}

// Reglas de seek con teclado (puras): flechas, Shift, Home/End y recortes.
function runSeekKeys(): void {  log('\n===== seek: teclado =====');
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
  assert(displayNameFromPath('/musica/tema.mp3') === 'tema', 'displayNameFromPath: quita dir y extensión');  assert(displayNameFromPath('C:\\x\\cancion.flac') === 'cancion', 'displayNameFromPath: separador Windows');

  // --- detección de listas para el eject ---
  assert(
    isM3UFileName('lista.m3u') && isM3UFileName('LISTA.M3U8'),
    'isM3UFileName: reconoce .m3u/.m3u8'
  );
  assert(
    !isM3UFileName('tema.mp3') && !isM3UFileName('m3u'),
    'isM3UFileName: rechaza audio y sin extensión'
  );
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

  // --- replaceFiles: abrir un archivo reemplaza la lista (eject) ---
  const repl = new PlaylistController();
  repl.addFiles([new File([], 'vieja1.mp3'), new File([], 'vieja2.mp3')]);
  const replaced = repl.replaceFiles([new File([], 'nueva.mp3')]);
  assert(
    replaced.length === 1 && replaced[0].name === 'nueva',
    'replaceFiles: devuelve el item creado'
  );
  assert(
    repl.store.get().items.length === 1 && repl.store.get().items[0].name === 'nueva',
    'replaceFiles: reemplaza la lista'
  );
  assert(
    repl.store.get().selectedId === null && repl.store.get().playingId === null,
    'replaceFiles: resetea selección y playing'
  );

  // --- orden de la lista: sort / reverse / randomize ---
  const ord = new PlaylistController();
  ord.addFiles([new File([], 'c.mp3'), new File([], 'a.mp3'), new File([], 'b.mp3')]);
  ord.sortBy('name');
  assert(
    ord.store.get().items.map((i) => i.name).join(',') === 'a,b,c',
    'sortBy name: ordena alfabéticamente'
  );
  ord.reverse();
  assert(
    ord.store.get().items.map((i) => i.name).join(',') === 'c,b,a',
    'reverse: invierte el orden'
  );

  const rnd = new PlaylistController();
  rnd.addFiles([new File([], 'a.mp3'), new File([], 'b.mp3'), new File([], 'c.mp3')]);
  rnd.randomize(() => 0);
  assert(
    rnd.store.get().items.map((i) => i.name).join(',') === 'b,c,a',
    'randomize: Fisher-Yates determinista'
  );

  const byPath = new PlaylistController((file) =>
    file.name === 'a.mp3' ? '/3-a' : file.name === 'b.mp3' ? '/1-b' : '/2-c'
  );
  byPath.addFiles([new File([], 'a.mp3'), new File([], 'b.mp3'), new File([], 'c.mp3')]);
  byPath.sortBy('path');
  assert(
    byPath.store.get().items.map((i) => i.name).join(',') === 'b,c,a',
    'sortBy path: ordena por ruta'
  );

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
  assert(pl2.prevOf(i2.id)?.id === i1.id, 'prevOf: anterior correcto');
  assert(pl2.prevOf(i1.id) === null, 'prevOf: primer item → null');
  assert(pl2.prevOf('inexistente') === null, 'prevOf: id desconocido → null');

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
  const seeks: number[] = [];
  const preparedTracks: Track[] = [];
  let enqueuedPrepared = 0;
  let clearedPrepared = 0;
  const failIds = new Set<string>();
  const stub = {
    store: new Store<PlayerState>(initialPlayerState),
    setHooks: (h: PlaybackHooks): void => {
      stubHooks.current = h;
    },
    loadTrack: async (
      t: Track,
      options?: { autoplay?: boolean }
    ): Promise<void> => {
      if (failIds.has(t.id)) throw new Error('decode fail');
      loaded.push(t);
      // El engine real mide la duración al decodificar: el stub lo imita.
      // Con autoplay:false la pista queda cargada en pausa.
      stub.store.set({
        currentTrack: t,
        isPlaying: options?.autoplay !== false,
        duration: 123
      });
    },
    seek: (seconds: number): void => {
      seeks.push(seconds);
    },
    prepareNext: async (t: Track): Promise<boolean> => {
      preparedTracks.push(t);
      return true;
    },
    enqueuePrepared: (): number => {
      enqueuedPrepared++;
      return 0;
    },
    clearPrepared: (): void => {
      clearedPrepared++;
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

  // Eject/Open: un archivo reemplaza la lista y suena; un .m3u se carga.
  const pl6 = new PlaylistController();
  const pb6 = connectPlaylistPlayback({
    player: stub,
    playlist: pl6,
    readFile: async () => new Uint8Array([1, 2, 3])
  });
  pl6.addFiles([new File([], 'previa.mp3')]);

  const beforeOpen = loaded.length;
  const openedAudio = await pb6.openFile(new File([], 'sola.mp3'));
  assert(openedAudio === true, 'openFile audio: reproduce');
  assert(
    pl6.store.get().items.length === 1 && pl6.store.get().items[0].name === 'sola',
    'openFile audio: lista de un solo item'
  );
  assert(
    loaded.length === beforeOpen + 1 && loaded[loaded.length - 1].title === 'sola',
    'openFile audio: carga esa pista'
  );
  assert(
    pl6.store.get().playingId === pl6.store.get().items[0].id,
    'openFile audio: playingId fijado'
  );

  const m3uText = '#EXTM3U\n/abrir/uno.mp3\n/abrir/dos.mp3\n';
  const openedList = await pb6.openFile(new File([m3uText], 'lista.m3u'));
  assert(openedList === true, 'openFile m3u: reproduce');
  const openItems = pl6.store.get().items;
  assert(
    openItems.length === 2 && openItems[0].path === '/abrir/uno.mp3',
    'openFile m3u: lista cargada'
  );
  assert(
    pl6.store.get().playingId === openItems[0].id,
    'openFile m3u: reproduce el primero'
  );
  assert(
    loaded[loaded.length - 1].title === 'uno',
    'openFile m3u: título sin extensión'
  );
  assert(
    loaded[loaded.length - 1].path === '/abrir/uno.mp3',
    'openFile m3u: la pista lleva la ruta del item'
  );

  const emptyList = await pb6.openFile(new File(['#EXTM3U\n'], 'vacia.m3u'));
  assert(emptyList === false, 'openFile m3u vacío: false');
  assert(pl6.store.get().items.length === 0, 'openFile m3u vacío: lista vacía');

  // Next/Prev: navegación por la lista con la misma continuidad.
  const pl7 = new PlaylistController();
  const pb7 = connectPlaylistPlayback({ player: stub, playlist: pl7 });
  pl7.addFiles([new File([], 'n1.mp3'), new File([], 'n2.mp3'), new File([], 'n3.mp3')]);
  const [n1, n2, n3] = pl7.store.get().items;

  const nextBoot = await pb7.next();
  assert(
    nextBoot === true && pl7.store.get().playingId === n1.id,
    'next: sin playingId arranca en el primero'
  );
  assert(
    (await pb7.next()) === true && pl7.store.get().playingId === n2.id,
    'next: avanza'
  );
  assert(
    (await pb7.next()) === true && pl7.store.get().playingId === n3.id,
    'next: llega al último'
  );
  assert(
    (await pb7.next()) === false && pl7.store.get().playingId === n3.id,
    'next: en el último no envuelve'
  );

  assert(
    (await pb7.previous()) === true && pl7.store.get().playingId === n2.id,
    'previous: retrocede'
  );
  assert(
    (await pb7.previous()) === true && pl7.store.get().playingId === n1.id,
    'previous: llega al primero'
  );
  assert(
    (await pb7.previous()) === false && pl7.store.get().playingId === n1.id,
    'previous: en el primero no hace nada'
  );

  // Los ilegibles se saltan también al navegar.
  const pl8 = new PlaylistController();
  const pb8 = connectPlaylistPlayback({ player: stub, playlist: pl8 });
  pl8.addFiles([new File([], 'okA.mp3')]);
  pl8.store.set({
    items: [
      ...pl8.store.get().items,
      { id: 'ilegible2', name: 'ilegible', file: null, path: null, duration: null },
      { id: 'okB', name: 'okB', file: new File([], 'okB.mp3'), path: null, duration: null }
    ]
  });
  const [a1, , b2] = pl8.store.get().items;
  pl8.setPlaying(a1.id);
  assert(
    (await pb8.next()) === true && pl8.store.get().playingId === b2.id,
    'next: salta ilegibles'
  );

  // loadItem (restauración): carga EN PAUSA, asociada a la lista.
  const pl9 = new PlaylistController();
  const pb9 = connectPlaylistPlayback({
    player: stub,
    playlist: pl9,
    readFile: async () => new Uint8Array([1])
  });
  pl9.restore([
    { name: 'r1', path: '/r/uno.mp3', duration: null },
    { name: 'r2', path: '/r/dos.mp3', duration: null }
  ]);
  const [q1, q2] = pl9.store.get().items;

  const loadedItem = await pb9.loadItem(q1.id, { position: 30 });
  assert(loadedItem === true, 'loadItem: carga el item');
  assert(pl9.store.get().playingId === q1.id, 'loadItem: queda como playingId');
  assert(
    loaded[loaded.length - 1].id === q1.id &&
      loaded[loaded.length - 1].path === '/r/uno.mp3',
    'loadItem: misma pista e id que el item de la lista'
  );
  assert(stub.store.get().isPlaying === false, 'loadItem: en pausa');
  assert(seeks[seeks.length - 1] === 30, 'loadItem: aplica la posición');
  assert(pl9.store.get().items[0].duration === 123, 'loadItem: guarda la duración');

  // Continuidad: la pista restaurada queda asociada, así que al terminar
  // avanza al siguiente item (el bug que reportó el usuario).
  await stubHooks.current!.onTrackEnded!();
  assert(
    pl9.store.get().playingId === q2.id,
    'loadItem: al terminar avanza al siguiente'
  );

  // Drag & drop: sobre el player reemplaza y reproduce; sobre la playlist
  // agrega. Un .m3u se abre como lista en cualquier zona.
  const dropPlaylist = new PlaylistController();
  const dropCalls: string[] = [];
  const dropPlayback = {
    playItem: async (id: string): Promise<boolean> => {
      dropCalls.push(`play:${id}`);
      return true;
    },
    openFile: async (file: File): Promise<boolean> => {
      dropCalls.push(`open:${file.name}`);
      return true;
    }
  };

  dropPlaylist.addFiles([new File([], 'previa.mp3')]);
  await handleDroppedFiles(
    { playlist: dropPlaylist, playback: dropPlayback },
    [new File([], 'uno.mp3'), new File([], 'dos.mp3')],
    'append'
  );
  assert(dropPlaylist.store.get().items.length === 3, 'drop append: agrega sin borrar');

  await handleDroppedFiles(
    { playlist: dropPlaylist, playback: dropPlayback },
    [new File([], 'sola.mp3')],
    'replace'
  );
  assert(
    dropPlaylist.store.get().items.length === 1 &&
      dropPlaylist.store.get().items[0].name === 'sola',
    'drop replace: reemplaza la lista'
  );
  assert(
    dropCalls.some((call) => call.startsWith('play:')),
    'drop replace: reproduce el primero'
  );

  const openedDrops: string[] = [];
  const m3uPlaylist = new PlaylistController();
  await handleDroppedFiles(
    {
      playlist: m3uPlaylist,
      playback: {
        playItem: async () => true,
        openFile: async (file: File): Promise<boolean> => {
          openedDrops.push(file.name);
          return true;
        }
      }
    },
    [new File(['#EXTM3U\n'], 'lista.m3u')],
    'append'
  );
  assert(openedDrops[0] === 'lista.m3u', 'drop .m3u: se abre como lista');
  assert(
    m3uPlaylist.store.get().items.length === 0,
    'drop .m3u: no agrega el archivo como item'
  );

  // Invalidación: cambiar la lista cancela la precarga obsoleta.
  const gapPl = new PlaylistController();
  const gapPb = connectPlaylistPlayback({ player: stub, playlist: gapPl });
  gapPl.addFiles([new File([], 'g1.mp3'), new File([], 'g2.mp3')]);
  const [g1, g2] = gapPl.store.get().items;
  await gapPb.playItem(g1.id);
  await sleep(30);
  assert(
    preparedTracks.some((track) => track.id === g2.id),
    'gapless: precarga la siguiente tras playItem'
  );
  const clearsBefore = clearedPrepared;
  gapPl.select(g2.id);
  gapPl.removeSelected();
  await sleep(30);
  assert(clearedPrepared > clearsBefore, 'gapless: mutación invalida la precarga');

  // El borde mueve playingId mediante el hook.
  const hookPl = new PlaylistController();
  const hookPb = connectPlaylistPlayback({ player: stub, playlist: hookPl });
  hookPl.addFiles([new File([], 'h1.mp3'), new File([], 'h2.mp3')]);
  const [h1, h2] = hookPl.store.get().items;
  await hookPb.playItem(h1.id);
  stubHooks.current!.onTrackStarted?.({
    id: h2.id,
    title: 'h2',
    file: new File([], 'h2.mp3'),
    path: null
  });
  assert(hookPl.store.get().playingId === h2.id, 'gapless: onTrackStarted mueve playingId');

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

// ===== Fase 4: gapless =====

async function runGaplessOffline(): Promise<void> {
  log('\n===== gapless: agendado offline =====');
  const sr = 44100;
  const ctx = new OfflineAudioContext(1, sr * 2, sr);
  const first = ctx.createBuffer(1, sr, sr);
  const second = ctx.createBuffer(1, sr, sr);
  first.getChannelData(0).fill(0.5);
  second.getChannelData(0).fill(0.5);

  const startAt = endTimeOf(0, 0, first.duration);
  assert(Math.abs(startAt - 1) < 1e-9, 'gapless: endTimeOf calcula el fin exacto');
  startBuffer(ctx, ctx.destination, first, 0);
  startBuffer(ctx, ctx.destination, second, startAt);

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);

  let min = 1;
  for (let i = sr - 100; i <= sr + 100; i++) min = Math.min(min, data[i]);
  assert(min > 0.49, 'gapless: 200 muestras continuas en el borde');
  assert(
    Math.abs(data[sr - 1] - 0.5) < 1e-3 && Math.abs(data[sr] - 0.5) < 1e-3,
    'gapless: muestras a ambos lados del borde'
  );
}

function createGaplessEngine() {
  let playing = false;
  let lastQueue: { buffer: AudioBuffer; onStart?: () => void } | null = null;
  let clears = 0;
  const engine: AudioEngine = {
    load: async () => {
      playing = false;
    },
    decode: async () => ({ duration: 100 } as AudioBuffer),
    queue: (buffer, onStart) => {
      lastQueue = { buffer, onStart };
      return 42;
    },
    clearQueue: () => {
      lastQueue = null;
      clears++;
    },
    play: () => {
      playing = true;
    },
    pause: () => {
      playing = false;
      lastQueue = null;
      clears++;
    },
    seek: () => {
      lastQueue = null;
      clears++;
    },
    getTime: () => 0,
    getDuration: () => 100,
    isPlaying: () => playing,
    setVolume: () => {},
    onEnded: () => {},
    dispose: () => {}
  };

  return {
    engine,
    promote: (): void => {
      lastQueue?.onStart?.();
    },
    hasQueue: (): boolean => lastQueue !== null,
    clears: (): number => clears
  };
}

async function runGaplessController(): Promise<void> {
  log('\n===== gapless: controller =====');
  const fake = createGaplessEngine();
  const player = new PlayerController(fake.engine);
  const started: string[] = [];
  player.setHooks({ onTrackStarted: (track) => started.push(track.id) });

  const mk = (id: string): Track => ({
    id,
    title: id.toUpperCase(),
    file: new File([id], `${id}.mp3`),
    path: `/${id}.mp3`
  });

  await player.loadTrack(mk('a'));
  assert(player.store.get().currentTrack?.id === 'a', 'gapless: carga A');

  assert((await player.prepareNext(mk('b'))) === true, 'gapless: prepara B');
  assert(
    player.store.get().currentTrack?.id === 'a',
    'gapless: preparar no cambia la pista actual'
  );

  assert(player.enqueuePrepared() === 42 && fake.hasQueue(), 'gapless: agenda B');
  fake.promote();
  assert(player.store.get().currentTrack?.id === 'b', 'gapless: el borde cambia a B');
  assert(started.join(',') === 'b', 'gapless: hook onTrackStarted');
  assert(
    player.store.get().duration === 100 && player.store.get().isPlaying,
    'gapless: estado de B'
  );
  assert(player.enqueuePrepared() === 0, 'gapless: sin preparada, enqueue 0');

  // Pause limpia la cola; play y seek re-agendan lo preparado.
  await player.prepareNext(mk('c'));
  assert(player.enqueuePrepared() === 42, 'gapless: agenda C');
  player.pause();
  assert(!fake.hasQueue(), 'gapless: pause limpia la cola');
  await player.play();
  assert(fake.hasQueue(), 'gapless: play re-agenda lo preparado');
  player.seek(10);
  assert(fake.hasQueue(), 'gapless: seek re-agenda lo preparado');

  // loadTrack manual cancela cola y preparada.
  await player.loadTrack(mk('d'));
  assert(!fake.hasQueue(), 'gapless: loadTrack cancela la cola');
  assert(player.enqueuePrepared() === 0, 'gapless: loadTrack descarta la preparada');

  player.dispose();
}

async function runGaplessEngine(paths: string[]): Promise<void> {
  log('\n===== gapless: motor real =====');
  if (paths.length === 0) {
    log('  (sin MP3s: se omite)');
    return;
  }

  const toFile = async (p: string): Promise<File> => {
    const bytes = await window.crossampTest!.readFile(p);
    const name = p.split(/[\\/]/).pop() ?? 'pista.mp3';
    return new File([bytes], name);
  };

  const engine = new WebAudioEngine();
  const fileA = await toFile(paths[0]);
  const fileB = await toFile(paths[1] ?? paths[0]);
  await engine.load(fileA);
  engine.play();

  const durationA = engine.getDuration();
  engine.seek(Math.max(0, durationA - 1.5));

  const bufferB = await engine.decode(fileB);
  let started = false;
  const startAt = engine.queue(bufferB, () => {
    started = true;
  });
  assert(startAt > 0, 'gapless motor: agenda un instante de arranque');

  await sleep(2200);
  assert(started, 'gapless motor: la siguiente arrancó');
  assert(
    Math.abs(engine.getDuration() - bufferB.duration) < 0.01,
    'gapless motor: la pista activa es la siguiente'
  );
  assert(engine.isPlaying(), 'gapless motor: sigue sonando');
  assert(engine.getTime() < 1.5, 'gapless motor: posición reiniciada');

  // Pausa antes del borde: la transición no debe ocurrir.
  const engine2 = new WebAudioEngine();
  await engine2.load(fileA);
  engine2.play();
  engine2.seek(Math.max(0, engine2.getDuration() - 1.5));
  const bufferB2 = await engine2.decode(fileB);
  let started2 = false;
  engine2.queue(bufferB2, () => {
    started2 = true;
  });
  engine2.pause();
  await sleep(1800);
  assert(!started2, 'gapless motor: pause cancela la transición');

  engine.dispose();
  engine2.dispose();
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

  // Teclas multimedia / atajos globales (con fakes).
  try {
    runMedia();
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runMedia: ${String(err)}`);
  }

  // Persistencia de sesión (localStorage): codec, storage, restore y wiring.
  try {
    await runPersistence();
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runPersistence: ${String(err)}`);
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

  // Fase 4: gapless (agendado offline, controller y motor real).
  try {
    await runGaplessOffline();
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runGaplessOffline: ${String(err)}`);
  }

  try {
    await runGaplessController();
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runGaplessController: ${String(err)}`);
  }

  try {
    await runGaplessEngine(paths);
  } catch (err) {
    failures++;
    log(`[FAIL] excepcion en runGaplessEngine: ${String(err)}`);
  }

  log(`\n########## RESULTADO: ${failures === 0 ? 'TODO OK' : `${failures} FALLOS`} ##########`);
  report(failures === 0 ? 0 : 1);
}

function report(code: number): void {
  // El mainprocess escucha esta linea para salir con el codigo adecuado.
  console.log(`__CROSSAMP_TEST_DONE__${code}`);
}

void main();
