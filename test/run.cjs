const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lanza el harness de validacion del motor con los MP3 reales.
// Uso: node test/run.cjs [ruta ...]
// Sin args, usa los MP3 de ~/Downloads.

function findDefaultMp3s() {
  const dir = path.join(os.homedir(), 'Downloads');
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mp3'))
    .map((f) => path.join(dir, f));
}

const args = process.argv.slice(2);
const files = args.length > 0 ? args : findDefaultMp3s();

if (files.length === 0) {
  console.error('No hay MP3 que probar.');
  process.exit(1);
}

for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`No existe: ${f}`);
    process.exit(1);
  }
}

console.log(`Probando ${files.length} archivo(s):`);
files.forEach((f) => console.log(`  - ${path.basename(f)}`));

const electronBin = require('electron');

const res = spawnSync(
  electronBin,
  [path.join(__dirname, 'main.cjs')],
  {
    stdio: 'inherit',
    env: { ...process.env, CROSSAMP_TEST_PATHS: JSON.stringify(files) }
  }
);

process.exit(res.status === null ? 1 : res.status);
