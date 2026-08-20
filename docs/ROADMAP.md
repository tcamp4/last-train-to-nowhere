# Vertical Slice Expansion Roadmap

## 1. Optional offline asset packaging

The slice already ships original custom-profile/spline-sweep hero and creature meshes with real skinning, skeletons, and AnimationMixer clips. Optionally bake those final runtime assets to Meshopt-compressed GLBs and transcode their 512² material maps to KTX2 for faster transfer/startup, while retaining procedural train-kit and scenery variation.

## 2. Regions and colossal threat

Add frozen checkpoint, toxic marsh, night forest, and industrial graveyard segment libraries. Each adds hazards that reuse the existing power/damage contracts. Introduce one multi-stage pursuer requiring turret, cooling, track scanner, and passenger coordination.

## 3. Passenger campaign

Expand authored passenger event graphs, shelter/assist navigation, relationships, loyalty checks, delayed deal consequences, and faction reputation. Keep prose authored and data-driven.

## 4. Build variety

Grow visible upgrades across engine, generator, battery, cooling, armor, windows, weapons, medical, radar, and storage. Add synergy tags and mutually exclusive train configurations.

## 5. Content pipeline and release hardening

Add GLB/KTX2 validation, license validation, visual regression shots, longer seeded simulation tests, browser GPU profiling, accessibility settings, controller remapping, save migration, and multi-region soak tests.
