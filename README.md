# Last Train to Nowhere

A fully playable Three.js vertical slice about keeping a failing armored train alive through an ash storm. Fight boarders, reroute scarce electrical power, make quick field repairs, and survive to Lantern Mile Depot.

## Start

Requires a current Node.js release.

```bash
npm install --cache .npm-cache
npm run dev
```

Open `http://localhost:5173`. For a production check:

```bash
npm run build
npm run preview
```

## Controls

- `WASD`: move through the train
- Mouse: over-the-shoulder camera
- `Shift`: sprint
- `Space`: dodge
- `R`: reload the K-12 from reserve ammunition
- `E`: interact / advance a repair step / mount or dismount the rear turret
- Left mouse: equipped weapon or tool / fire the mounted turret
- Right mouse: aim / alternate tool function
- `1–3` or mouse wheel: switch equipment
- `Tab`: brass electrical routing board
- `Escape`: pause and settings
- `F`: fullscreen

Click the 3D view to capture the mouse. The browser releases it with Escape.

## The slice

The train has four physically connected cars: locomotive/control, engineering, passenger/operations, and defense/cargo. A complete loop leaves the ash depot, receives threat warnings, fights three boarder archetypes, suffers localized system failures, reaches Lantern Mile Depot, spends scrap on repairs/upgrades or takes a questionable reactor deal, saves, and departs into a harder region.

See [architecture](docs/ARCHITECTURE.md), [asset manifest](docs/ASSET_MANIFEST.md), [performance report](docs/PERFORMANCE.md), and [roadmap](docs/ROADMAP.md).
