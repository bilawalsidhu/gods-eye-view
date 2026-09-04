# DOM ID → Source Module Reference

This quick reference maps prominent DOM IDs from index.html to the source modules that initialize or interact with them. Use it when adding features, writing tests, or debugging UI wiring.

- #cesiumContainer — mapStartup.js (imported from src/main.js) / src/main.js
- #loading-screen — src/main.js (initialization / loader UI)
- #title-bar, #style-indicator — src/ui.js (StyleManager, visual presets)
- #top-center-actions (share, reset) — src/sharelink.js + src/ui.js
- #cockpit-hud — cockpit files (src/cockpitTracking.js, src/cockpitCloudEffects.js, src/cockpitUtilityLayout.js) and src/hud.js
- #cockpit-* elements (speed, altitude, route) — cockpit modules: src/cockpitMath.js, src/cockpitTracking.js
- #data-panel, #data-toggles — src/data/manager.js and per-layer modules under src/data/ (flights.js, aisLiveVessels.js, satellites.js, etc.)
- #scene-panel, #scene-* — src/scenes/director.js and src/scenes/recipes.js
- #key-setup, #key-setup-chip — src/keySetup.js and src/keySetupCore.mjs
- #first-run-launcher — src/firstRunExperience.js
- #intel-hud — src/hud.js and src/hudSummaryResponse.js
- #radio-panel, #cockpit-radio-* — src/data/radio.js and src/voice/gevRealtime.js (playback wiring)
- #map-stack-chips, #map-stack-status — src/mapStackController.js and src/mapStartup.js
- #share-btn, share link behaviour — src/sharelink.js
- #param-sliders / #param-slider-panel — UI parameter system wired from src/ui.js and DataLayerManager
- #safe-frame-overlay, #scene-runtime — layout / scene host; controlled from src/scenes/director.js and src/ui.js

Notes:
- Many IDs are populated or controlled via runtime-inserted components (DOM template nodes, parameter surfaces) — search for `getElementById('...')` and `querySelector` in `src/` to find exact handlers.
- For data-layer-specific UI, see `src/data/layerState.js` and each `src/data/*.js` module; layer registration is centralized in `src/data/manager.js`.
- The `src/main.js` entry-point wires many of these subsystems together; start there when tracing app startup.
