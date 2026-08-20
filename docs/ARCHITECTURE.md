# Last Train to Nowhere — Vertical Slice Architecture

The browser build uses a deterministic simulation independent from Three.js presentation. `GameState` in `src/shared/types.ts` is the contract shared by all modules.

- `src/gameplay/`: deterministic state, input intent, power/damage/repair, combat, boarding, stations, persistence.
- `src/scene/`: renderer, train/player/enemy presentation, recycled desert, particles, lighting, camera.
- `src/ui/`: title, HUD, power schematic, station choices, pause/settings, game-over summary.
- `src/audio/`: pooled Web Audio synthesizer and spatial-ish interior/exterior mix.
- `src/main.ts`: orchestration only: input → simulation → presentation → UI.

The train remains at the origin. Track, ash, terrain props, and landmarks wrap on the Z axis. The four cars share a continuous walkable coordinate system: X across the car, Y up, Z along the consist. Simulation state is serializable; scene objects never own authoritative gameplay state.

The vertical slice implements one ash-waste region, a locomotive, engineering car, passenger operations car, defense car, three boarding enemy types following 16 authored exterior attachment paths, seven power circuits, close-facing staged repairs, three physical skinned crew members, six visible upgrades, two persistent route choices, one delayed-consequence deal with an original loaded glTF reactor asset, and a full station-to-station loop.
