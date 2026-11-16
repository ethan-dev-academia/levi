# Levi

A low-poly 2.5D browser MMO: 3D flat-shaded terrain, 2D pixel billboard sprites,
LoL-style controls, OSRS-style progression. All content is JSON.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run typecheck
```

## Layout

| Path | Purpose |
| --- | --- |
| `shared/` | Deterministic code used by client and server: terrain height, walk grid, A*, movement, intent protocol, zod content schemas |
| `client/` | Vite + Three.js renderer, camera, input, OSRS-style HTML/CSS HUD |
| `server/` | *(Step 2)* Colyseus authoritative room @ 20 TPS |
| `content/` | Game data (maps, sprites, …). Every `*.json` is auto-loaded and validated |

## Rules

- **Gameplay is 2D.** Movement, pathing and hit tests run on the (X, Z) plane.
  Y is visual only: `mesh.position.y = getTerrainHeight(hm, x, z)`.
- **Clients send intent only** (`move`, `stop`, `cast`, `useItem`), validated by `IntentSchema`.
- **No globals.** Game state never touches `window`.

## Controls

Right-click: walk · Right/middle-drag: orbit camera · Wheel: zoom · Arrows: rotate camera ·
QWER / DF: abilities · 1–4: items · S: stop · Enter: chat · Click minimap: walk
