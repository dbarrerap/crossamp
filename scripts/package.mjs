import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

/**
 * Empaqueta crossamp con @electron/packager.
 *
 * Uso:
 *   node scripts/package.mjs [plataforma] [arquitectura]
 *
 * Sin argumentos usa el SO y la arquitectura del host (`npm run dist:app`).
 * Ejemplos:
 *   node scripts/package.mjs win32 x64   → dist/crossamp-win32-x64
 *   node scripts/package.mjs darwin      → dist/crossamp-darwin-<arch host>
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const [platformArg, archArg] = process.argv.slice(2);
const platform = platformArg ?? process.platform;
const arch = archArg ?? process.arch;

const VALID_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
if (!VALID_PLATFORMS.has(platform)) {
  console.error(
    `Plataforma no soportada: ${platform} (usar darwin|win32|linux)`
  );
  process.exit(1);
}

// Íconos opcionales: si existen en build/, se usan; si no, el de Electron.
const icons = {
  darwin: 'build/icon.icns',
  win32: 'build/icon.ico'
};
const icon = icons[platform];
const iconPath = icon ? join(root, icon) : null;

const options = {
  dir: root,
  name: 'crossamp',
  platform,
  arch,
  out: join(root, 'dist'),
  overwrite: true,
  asar: true,
  prune: true,
  // Solo viaja lo que la app necesita en runtime: out/ + package.json
  // (+ LICENSE). Fuentes, tests, configs y builds previos quedan afuera.
  ignore: [
    /^\/dist($|\/)/,
    /^\/src($|\/)/,
    /^\/test($|\/)/,
    /^\/scripts($|\/)/,
    /^\/\.git($|\/)/,
    /^\/tsconfig/,
    /^\/electron\.vite\.config\.ts$/,
    /^\/package-lock\.json$/,
    /^\/README\.md$/
  ]
};

if (iconPath && existsSync(iconPath)) {
  options.icon = iconPath;
} else if (icon) {
  console.log(`(sin ${icon}: se usa el ícono de Electron)`);
}

if (platform !== process.platform || arch !== process.arch) {
  console.log(
    `Empaquetando ${platform}/${arch} desde ${process.platform}/${process.arch}…`
  );
}

const appPaths = await packager(options);
console.log(`\nApp empaquetada:\n  ${appPaths.join('\n  ')}`);
