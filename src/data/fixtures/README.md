# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used by offline decode/source tests and the explicit `qa-traffic --fixtures`
  browser mode — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never loaded by ordinary application startup. © TomTom.
- `adsb-austin-frames.txt` — 112 raw Mode S frames (`*<hex>;`, one per line,
  in receive order) received over Austin, TX, and
  `adsb-austin-dump1090-aircraft.json` — dump1090-fa's `aircraft.json` decode
  of the same frames, trimmed to the fields the tests assert on. Used by the
  Local ADS-B decoder and record-adapter tests; never loaded at runtime.
- `adsb-austin-capture-timed.json` — a second ~90 s receive over Austin, TX:
  846 extended squitters from six aircraft (`frames`: `[ms, hex]`), with
  dump1090-fa's decoded positions and emitter categories for the same
  interval (`dump1090`: per ICAO `flight`, `category` and `fixes` as
  `[ms, lat, lon]`). The capture has no per-frame timestamps; each frame's
  time is interpolated between the frames whose decoded position equals a
  dump1090 fix, timed as dump1090's `now − seen_pos`. Used by the decoder's
  category, speed-check and track-accuracy tests; never loaded at runtime.
- `hamrig-fm-repeaters-nearby.json` and `hamrig-dstar-repeaters-nearby.json` —
  one captured response each from HamRig's two public repeater routes
  (`/api/fm/repeaters/nearby`, `/api/dstar/repeaters/nearby`), six rows apiece
  around Cologne, Germany, captured 2026-09-23. They pin the normalisers in
  `src/sources/hamRepeaters.js` and the proxy tests: the FM rows cover CTCSS
  tone, the 1750 Hz tone-burst case and the historic record dates that make
  those rows `unverified`; the D-STAR rows cover multi-module gateways and the
  unknown gateway status that makes them `reported`. Contact fields the proxy
  strips are kept in the fixture on purpose, so a regression that leaks them
  fails a test. Never loaded at runtime.
