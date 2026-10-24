# crossamp

Reproductor de audio multiplataforma (Electron + TypeScript) inspirado en Winamp.

## Modelo de ramas

- `crossamp` → rama principal (main). Solo recibe trabajo consolidado.
- `dev` → rama de integración. Nace vacía; de aquí salen las ramas de feature.
- `feature/<nombre>` → salen de `dev`. Cada una cubre una pieza acotada.

Flujo: `feature/x` → `dev` → `crossamp`.

## Fases

- **Fase 1** — UI player + metadata MP3 + transporte de audio + cableado de estado.
- **Fase 2** — Seek preciso (VU meter descartado por ahora: es visual, no funcional).
- **Fase 3** — Apariencia Bento (solo visual).
- **Fase 4** — Gapless playback.
