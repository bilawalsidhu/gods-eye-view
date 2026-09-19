# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.
- `mbta-vehicle-positions.pb` — one real MBTA GTFS-Realtime
  `VehiclePositions.pb` snapshot (406 vehicles), captured 2026-09-18 from
  `cdn.mbta.com/realtime/VehiclePositions.pb` (47,787 bytes). Used by
  `src/data/gtfsRtDecode.test.mjs` and `src/data/gtfsRtProxy.test.mjs` to pin
  protobuf decoding and dev-proxy byte fidelity offline — a point-in-time
  snapshot, never served to the app. © MBTA (open data).
- `metro-mn-vehicle-positions.pb` — one real Metro Transit (Twin Cities)
  GTFS-Realtime `VehiclePositions.pb` snapshot (127 vehicles), captured
  2026-09-19 from
  `svc.metrotransit.org/mtgtfs/vehiclepositions.pb` (11,456 bytes). Same
  purpose and caveat as the MBTA fixture; this was the feed whose corrupted
  proxy relay surfaced the middleware byte-fidelity bug. © Metro Transit
  (open data).
