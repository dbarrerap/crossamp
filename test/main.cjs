const { app, BrowserWindow } = require('electron');
const path = require('path');

// Main del harness de validacion. Carga test/out/index.html en una ventana
// oculta, reenvia la consola del renderer a stdout y sale con el codigo que
// el test comunica via __CROSSAMP_TEST_DONE__<code>.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let done = false;

function finish(code) {
  if (done) return;
  done = true;
  // Pequeño margen para que flush de consola llegue antes de salir.
  setTimeout(() => app.exit(code), 150);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.on('console-message', (event) => {
    const message = event.message ?? '';
    process.stdout.write(message + '\n');

    const m = /__CROSSAMP_TEST_DONE__(\d+)/.exec(message);
    if (m) finish(Number(m[1]));
  });

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    process.stderr.write(`FATAL: did-fail-load ${code} ${desc}\n`);
    finish(1);
  });

  win.loadFile(path.join(__dirname, 'out', 'index.html'));

  // Red de seguridad por si el test se cuelga.
  setTimeout(() => {
    if (!done) {
      process.stderr.write('FATAL: timeout del harness (60s)\n');
      finish(1);
    }
  }, 60000);
});

app.on('window-all-closed', () => {
  if (!done) finish(1);
});
