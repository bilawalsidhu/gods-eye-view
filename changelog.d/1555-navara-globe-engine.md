- Add Navara, an experimental three.js/WASM globe, as a second engine next to
  Cesium, switchable live under Display → Globe Engine or with
  `?engine=navara`. Layers keep their data across a switch and draw on both
  engines; Cesium loads only when a Cesium globe or a Cesium-only feature
  needs it (German, @gekh, #1555).
