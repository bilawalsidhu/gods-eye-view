# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.

- `wigle-network-search.json` — a stand-in WiGLE `network/search` response used
  by `src/data/wigleProxy.test.mjs` so the proxy can be tested without spending
  a query against the live API (the per-account daily allowance is small, and
  CI has no WiGLE account).

  **Provenance: synthetic, written to WiGLE's documented `results[]` shape —
  NOT a capture, and deliberately containing no real observed network.** Real
  WiGLE rows are other people's crowdsourced sightings and are covered by the
  WiGLE licence; committing any would be redistribution of their data, which
  DATA_SOURCES.md explains this project does not do. The rows exercise what the
  normalizer has to handle: a current network, an aged one, one with a blank
  `ssid` and blank `channel` (`Number('')` is `0`, so blank must read as
  missing), and an untriangulated `0,0` row that must be dropped rather than
  plotted in the Gulf of Guinea.

