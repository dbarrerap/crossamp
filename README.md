# crossamp

Reproductor de audio multiplataforma (Electron + TypeScript) inspirado en Winamp.

## Modelo de ramas

- `crossamp` → rama principal (main). Solo recibe trabajo consolidado.
- `dev` → rama de integración. Nace vacía; de aquí salen las ramas de feature.
- `feature/<nombre>` → salen de `dev`. Cada una cubre una pieza acotada.

Flujo: `feature/x` → `dev` → `crossamp`.

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

## Empaquetar (.app)

Para uso personal, con `@electron/packager`:

```bash
npm run dist:app
```

Genera `dist/crossamp-darwin-arm64/crossamp.app` (arquitectura del host).
El `.app` va **sin firma**: se abre directo en esta máquina; si se copia a
otra, macOS puede pedir clic derecho → Abrir (o `xattr -cr crossamp.app`).
Todavía no tiene ícono propio (usa el de Electron).

La app empaquetada guarda su sesión en `~/Library/Application Support/crossamp`
y usa su propio origen `file://`, así que no hereda la sesión de
`npm run preview`.

## Fases

- **Fase 1** — UI player + metadata MP3 + transporte de audio + cableado de estado.
- **Fase 2** — Seek preciso (VU meter descartado por ahora: es visual, no funcional).
- **Fase 3** — Apariencia Bento (solo visual): ventana 275×700, grafito + ámbar; tokens en `src/renderer/src/styles/`.
- **Fase 4** — Gapless playback.
