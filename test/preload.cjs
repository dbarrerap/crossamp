const { contextBridge } = require('electron');
const fs = require('fs');

// Preload del harness de test (NO usa sandbox porque necesita fs para leer
// los MP3 reales). Expone readFile + la lista de paths al renderer de test.
const paths = JSON.parse(process.env.CROSSAMP_TEST_PATHS || '[]');

contextBridge.exposeInMainWorld('crossampTest', {
  paths,
  async readFile(path) {
    const buf = fs.readFileSync(path);
    // Copia para poder pasarla al renderer sin mantener el Buffer vivo.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
});
