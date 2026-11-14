# Sky view star-data size report (measured 2026-10-11)

| Item | Raw | gzip -9 |
| --- | ---: | ---: |
| data/stars.json (8,920 stars) | 443,602 B | 164,629 B |
| data/constellations.json (88) | 11,489 B | 4,424 B |
| Data files total (budget 200 KB gz) | 455,091 B | 169,053 B |
| ephemeris.js + starData.js + skyMath.js + astronomy-engine, esbuild bundle, minified, satellite.js external | 65,230 B | 28,857 B |
| of which astronomy-engine (tree-shaken) | 51,835 B | n/a |

- `npm ci` size: node_modules 360,481,089 B before, 362,320,025 B after adding
  astronomy-engine 2.1.19 (pinned exact): +1,838,936 B (the package unpacks to
  1,838,627 B, no dependencies).
- Vite (repo vite.config.js) emits both JSON files as hashed same-origin assets
  (assets/stars-<hash>.json, assets/constellations-<hash>.json) from
  `new URL('./data/*.json', import.meta.url)` in starData.js; they are fetched only
  when loadSkyData() is called, not part of any JS chunk.
- P3a adds no import from skyView.js, so the current lazy Sky chunk is unchanged
  until P3b wires drawing in.
- The gzip total is asserted by starData.test.mjs (<= 200 KB).
