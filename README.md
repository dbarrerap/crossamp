# crossamp

Reproductor de audio multiplataforma (Electron + TypeScript) inspirado en Winamp.

## Modelo de ramas

- `crossamp` → rama principal (main). Solo recibe trabajo consolidado.
- `dev` → rama de integración. Nace vacía; de aquí salen las ramas de feature.
- `feature/<nombre>` → salen de `dev`. Cada una cubre una pieza acotada.

Flujo: `feature/x` → `dev` → `crossamp`.

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
