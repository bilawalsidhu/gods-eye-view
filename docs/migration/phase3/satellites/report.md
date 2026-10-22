# T14 — satellites, orbits and CelestialRing

## 14a — Cesium extraction

Base: `c69f13b8`. Synthetic QA catalogs: 839 core TLEs (including ISS, MEO and GEO) + 6000 dense Starlink-like TLEs. All TLEs have valid checksums and propagate through unchanged satellite.js. No claim about live CelesTrak availability.

Cesium points, synchronous orbit primitives with depth-fail colour, tracked Entity, native click handler and follow are now behind `satellites/render/cesium.js`. Shared logic uses geo and Rgba; physical propagation, ring baking/GMST and orbit lookup use appClock, while catalog/UI throttles keep wall time. CelestialRing screen geometry uses geo/projector; its exact legacy Simon1994/ICRF planetary calculation and bare-viewer fallback are isolated in `celestialRing/render/cesium.js`.

Baseline and extracted Cesium QA: **15/15 each**. All 839 core ECEF positions are exactly equal at core, dense, ISS tracking, MEO and GEO checkpoints (maximum delta 0 m). ISS label is measured through its actual canvas paint rectangle; startup flight must finish before setting the QA pose. Dense totals are 6839, with only core records in voice/detection.

Review fixed the extraction ordering of native clicks: pointer ownership and enabled state are checked before scene.pick. Source assertions moved with their code: inputOwnership now checks the Cesium renderer, the renderer registry includes satellites, and the unported-layer import fixture uses earthquakes. No existing behavioural test expectations changed.

Validation: Node24 ordinary tests 7107 total, 7106 pass, 1 skip, 0 fail; all 15 allocation probes pass. Boundaries/format/build/panel pass. Main 2896553 B raw / 899309 gzip (+930 B raw, about 0.032%); no Navara/three in initial chunks. Contracts C73/73 and N79/79. The first N boot timed out because optimized three/postprocessing URLs returned local Vite504; after restarting only server4193 with its own cache reoptimized, a fresh browser passed79/79 with no page-start errors. Earlier logs are retained. Shell QA C23/23, N25/25, cross4/4 passes; both share directions and the fixed camera pose agree to displayed 0 m / 0 degrees. 14a is complete; 14b remains pending.

Local evidence: `qa-artifacts/t14/cesium-base.json`, `cesium-extracted.json`; logs `/tmp/gev-t14*.log`. All browser runs headless Chromium/Metal on port4193. No subagents/push/publication.

## 14b — Navara

Pending implementation and acceptance checks; T14 is not yet complete.
