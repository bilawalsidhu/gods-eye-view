- Add Navara, an experimental three.js/WASM globe, as a second engine next to
  Cesium, switchable live under VISUAL PRESETS → Globe Engine or with
  `?engine=navara`. Navara draws at CSS pixels like Cesium; Navara HD
  (`?engine=navara-hd`) draws at the screen's full resolution and needs about
  1 GiB more on a Retina screen. Layers keep their data across a switch and
  draw on both engines; Cesium loads only when a Cesium globe or a
  Cesium-only feature needs it (German, @gekh, #1555).
- Keep the cockpit camera steady near the ground: it no longer jumps up and
  down when an aircraft's reported altitude sits below the globe's terrain,
  on either engine (German, @gekh, #1555).
