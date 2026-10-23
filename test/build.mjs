import { build } from 'vite';
import { resolve } from 'path';
import { copyFile } from 'fs/promises';

// Compila test/entry.ts a test/out/entry.js (ESM) para que el harness de
// Electron lo cargue. No añade dependencias: usa el Vite ya instalado.
await build({
  root: resolve(import.meta.dirname),
  logLevel: 'warn',
  build: {
    outDir: 'out',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'entry.ts'),
      output: {
        entryFileNames: 'entry.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});

// index.html referencia ./entry.js, asi que debe vivir junto al bundle.
await copyFile(
  resolve(import.meta.dirname, 'index.html'),
  resolve(import.meta.dirname, 'out', 'index.html')
);
