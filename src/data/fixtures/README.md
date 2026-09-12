# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.

- `rayhunter-qmdl-manifest.json` and `rayhunter-analysis-report.ndjson` —
  stand-in responses for the two Rayhunter device endpoints
  (`/api/qmdl-manifest` and `/api/analysis-report/<name>`), used by
  `src/data/rayhunterProxy.test.mjs` and `src/data/rayhunterTap.test.mjs` so
  the tap can be tested without a device — CI has no Rayhunter to talk to.

  **Provenance: these are synthetic, written to the API shape in
  EFForg/rayhunter (route table plus the `analyzer`/`diag` modules), NOT
  captured from a device.** They are labelled that way deliberately so nobody
  reads them as recorded ground truth. They exercise the cases the parser has
  to survive: a leading metadata line with no `events` array, `null` entries in
  the per-analyzer `events` array, an `Informational` event that must be
  filtered out, one event of each real severity, and a trailing malformed line
  that must be skipped rather than aborting the parse. Replacing them with a
  real capture from hardware would be strictly better; the tests would not need
  to change.

