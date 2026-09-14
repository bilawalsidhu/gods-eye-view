# Test fixtures

- `ndbc-latest-obs-sample.txt` — a truncated capture of NOAA NDBC's bulk
  latest-observations feed, captured 2026-08-28 from
  `www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt`: both header lines, the
  first 80 station rows, plus every `46xxx` (Pacific) row so the sparse
  wave-only Catalina buoys (46221/46222/46253) and `MM` missing-value gaps are
  represented (184 data rows). Used ONLY by `src/data/ndbcText.test.mjs` to pin
  fixed-column parsing offline — it is a point-in-time snapshot, not a bundled
  data layer, and is never served to the app. NOAA/NDBC data, U.S. public
  domain.
- `etopo-sample.json` — a small real ETOPO1 bathymetry slice (4×4 nodes off
  Monterey, all sea floor), captured 2026-08-29 from
  `coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json?altitude[(36.0):2:(36.1)][(-122.1):2:(-122.0)]`
  (919 bytes). Used ONLY by `src/data/oceanProxy.test.mjs` to pin the ERDDAP
  table-JSON normalizer offline — it is a point-in-time snapshot, not a
  bundled data layer, and is never served to the app. NOAA data, U.S. public
  domain.
- `hfr-ucsdhfrw2-monterey.csv0` — 60 rows of real IOOS HF-radar 2 km total
  vectors over Monterey Bay (36.597–36.687 N, 122.094–121.906 W) at the single
  hour 2026-08-31T22:00:00Z, captured 2026-09-01 from
  `coastwatch.pfeg.noaa.gov/erddap/griddap/ucsdHfrW2.csv0?water_u[...],water_v[...],hdop[...]`
  (3,323 bytes). Headerless CSV, columns `time,latitude,longitude,water_u,
  water_v,hdop`. Deliberately includes 8 all-`NaN` fill rows so the QC gate's
  rejection path is exercised on real data rather than a hand-written stub.
  Used ONLY by `src/server/ocean/hfradar.test.mjs` to pin `.csv0` parsing and
  the QC gates offline — a point-in-time snapshot, not a bundled data layer,
  and never served to the app. NOAA/IOOS data, U.S. Government work, under the
  ERDDAP disclaimer licence (free use and redistribution, not for legal use,
  no warranty).
- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used by offline decode/source tests and the explicit `qa-traffic --fixtures`
  browser mode — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never loaded by ordinary application startup. © TomTom.
