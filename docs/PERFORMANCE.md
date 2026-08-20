# Performance Report

## Budget

- Target: 60 FPS on a current discrete-GPU desktop, scalable to integrated graphics.
- Main renderer: one WebGL canvas, capped device pixel ratio per preset.
- Static repeated scenery: instanced meshes.
- Weather and sparks: fixed-size pools; no unbounded emit arrays.
- Enemies: capped encounter population and reused scene nodes.
- World: train stays near origin while scenery segments wrap.
- Shadows: bounded to the train and selectively disabled by lower presets.
- Simulation: deterministic fixed step with serialized plain-data state.

## Presets

| Preset | Resolution scale | Shadows | Particle density | Intended hardware |
|---|---:|---|---:|---|
| Low | 0.72 | Off | 29% | Older integrated GPU |
| Medium | 0.86 | Full | 58% | Current integrated GPU |
| High | 1.0 | Full slice | 100% | Mid-range discrete GPU |
| Ultra | 1.0 | Full + denser effects | 156% | High-end discrete GPU |

## Measured slice results

Measured on the checked-in travel scene at 1280×720 in headless Chromium with ANGLE/SwiftShader, forcing GPU completion with `gl.finish()` after warm-up. This is a reproducible software-renderer check, not a substitute for release profiling on target GPUs.

| Preset | Draw calls | Triangles | p50 frame | p95 frame |
|---|---:|---:|---:|---:|
| Low | 211 | 591,932 | 7.8 ms | 8.3 ms |
| High | 402 | 1,174,418 | 8.6 ms | 9.0 ms |

The first quality review measured roughly 2,042 calls before the train-kit batching pass. Static fittings are now merged by material, wheels and bogies are instanced, scenery remains instanced, and moving machinery stays independently animated. A passenger-car view with all physical crew visible measured 276 calls on Low. The development debug panel exposes live draw calls, triangles, geometries, and textures; shipping profiling should still cover discrete/integrated GPUs, boarding peaks, station overlays, and long-run thermal behavior.

Hero surfaces use 512² seeded color, roughness, normal, and metalness maps shared by material family. Ambient occlusion remains a scalar lighting contribution in this runtime kit: adding a second UV set to every merged/instanced procedural fitting would increase vertex memory and complicate batching for limited visual gain in the continuously lit train interior.
