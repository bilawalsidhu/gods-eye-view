- Remove four modules nothing in the app imports: `src/app/sourceSlot.js`,
  `src/data/flowTiles.js`, `src/data/issPass.js` and `src/data/localGeojson.js`.
  The local GeoJSON layer tests now build layers the way the catalog does, so
  they keep covering `localGeojsonCore.js`. Package exports are unchanged
  (samehkhamis, #1403).
