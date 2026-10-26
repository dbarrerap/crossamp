# crossamp

Reproductor de audio multiplataforma (Electron + TypeScript) inspirado en Winamp.

## Modelo de ramas

- `crossamp` → rama principal (main). Solo recibe trabajo consolidado.
- `dev` → rama de integración. Nace vacía; de aquí salen las ramas de feature.
- `feature/<nombre>` → salen de `dev`. Cada una cubre una pieza acotada.

Flujo: `feature/x` → `dev` → `crossamp`.

## Atajos y teclas multimedia

En la app:

| Atajo | Acción |
|---|---|
| Doble clic en un item | Reproduce ese item y sigue con la lista |
| `Alt+3` | Info de la pista seleccionada (sin reproducirla) |
| `←` / `→` (con la barra de seek enfocada) | ±5 s |
| `Shift` + `←` / `→` | ±30 s |
| `Home` / `End` | Inicio / fin del tema |

Globales (funcionan con la app en segundo plano):

| Atajo | Acción |
|---|---|
| `Cmd/Ctrl+Alt+P` | Play / Pausa |
| `Cmd/Ctrl+Alt+←` | Anterior |
| `Cmd/Ctrl+Alt+→` | Siguiente |

Teclas multimedia del sistema (MediaSession): play/pausa, anterior/siguiente,
seek ±10 s y “Now Playing” con título/artista/carátula. En macOS el sistema
registra la app cuando reproduce audio por primera vez, así que las teclas
multimedia quedan activas **después del primer Play**; los atajos globales
funcionan desde el arranque.

## Estrategia de pruebas

El proyecto usa un **harness propio sobre Electron** (`test/`) en lugar de Jest:

- Corre en el mismo runtime que la app (Chromium + Web Audio), así que prueba
  de verdad la decodificación, el reloj de audio, el seek, el auto-avance, la
  persistencia y el smoke de UI.
- Jest/Vitest no pueden ejecutar Web Audio en Node (jsdom tampoco lo
  implementa); un mock convertiría esos tests en una simulación sin valor.

| Comando | Qué hace |
|---|---|
| `npm run test:engine` | Harness completo (MP3 de `~/Downloads` o rutas como argumento) |
| `npm run typecheck` | Typecheck de main / preload / renderer |
| `npm run typecheck:test` | Typecheck del harness (vive fuera de los tsconfig de la app) |
| `npm run check` | typecheck + typecheck:test + harness + build |

Nota: cierra cualquier `npm run preview` (u otra app Electron) antes de
`test:engine`; un proceso abierto retiene el dispositivo de audio y los tests
de reloj fallan.

## Empaquetar

Con `@electron/packager`:

| Comando | Salida |
|---|---|
| `npm run dist:app` | App para el SO/arquitectura del host |
| `npm run dist:mac` | `dist/crossamp-darwin-<arch>/crossamp.app` |
| `npm run dist:win` | `dist/crossamp-win32-x64/crossamp.exe` |

El script es `scripts/package.mjs` (acepta plataforma y arquitectura). Se puede
empaquetar para Windows desde macOS; conviene probar el `.exe` en Windows.

Los binarios van **sin firma**. En macOS se abren directo en esta máquina; si
se copian a otra, puede pedir clic derecho → Abrir (o `xattr -cr crossamp.app`).
En Windows, SmartScreen puede advertir (Más información → Ejecutar de todos
modos). Todavía no hay ícono propio: si existe `build/icon.icns` o
`build/icon.ico`, el script lo usa; si no, queda el de Electron.

La app empaquetada guarda su sesión en `~/Library/Application Support/crossamp`
(macOS) o `%APPDATA%\crossamp` (Windows) y usa su propio origen `file://`, así
que no hereda la sesión de `npm run preview`.

Requiere Node 22+.

## Fases

- **Fase 1** — UI player + metadata MP3 + transporte de audio + cableado de estado.
- **Fase 2** — Seek preciso (VU meter descartado por ahora: es visual, no funcional).
- **Fase 3** — Apariencia Bento (solo visual): ventana 275×700, grafito + ámbar; tokens en `src/renderer/src/styles/`.
- **Fase 4** — Gapless playback (implementado): la siguiente pista se decodifica por adelantado y se agenda al final exacto de la actual.

## Gapless

La siguiente pista de la lista se decodifica por adelantado y se agenda en el
instante exacto en que termina la actual (`AudioBufferSourceNode.start(when)`),
así que no hay silencio introducido por la app. Pausa, seek y Next descartan y
re-agendan la cola; si algo falla, se usa el avance normal (con gap).

Matiz: el MP3 lleva delay/padding del encoder; sin trim (LAME/Xing) puede quedar
un residuo de silencio de decenas de ms en el borde. FLAC/OGG no lo tienen.

## Licencia

MIT © 2026 David E. Barrera. Ver [LICENSE](LICENSE).
