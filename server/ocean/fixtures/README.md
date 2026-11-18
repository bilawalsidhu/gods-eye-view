# Fixtures

- `hfr-ucsdhfrw2-monterey.csv0` — 60 rows of real IOOS HF-radar 2 km total
  vectors over Monterey Bay (36.597–36.687 N, 122.094–121.906 W) at the single
  hour 2026-08-31T22:00:00Z, captured 2026-09-01 from
  `coastwatch.pfeg.noaa.gov/erddap/griddap/ucsdHfrW2.csv0?water_u[...],water_v[...],hdop[...]`
  (3,323 bytes). Headerless CSV, columns `time,latitude,longitude,water_u,
  water_v,hdop`. Deliberately includes 8 all-`NaN` fill rows so the QC gate's
  rejection path is exercised on real data rather than a hand-written stub.
  Used ONLY by `server/ocean/hfradar.test.mjs` to pin `.csv0` parsing and
  the QC gates offline — a point-in-time snapshot, not a bundled data layer,
  and never served to the app. NOAA/IOOS data, U.S. Government work, under the
  ERDDAP disclaimer licence (free use and redistribution, not for legal use,
  no warranty).
