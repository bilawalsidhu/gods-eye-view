- Add **River discharge outlook**, a keyless Weather layer that colours 187
  points on major rivers worldwide by the GloFAS 7-day discharge forecast from
  the Open-Meteo Flood API, set against each point's own 2012–2022 GloFAS
  reanalysis flow: below the 90th percentile, above the 90th, above the 99th.
  Points sit on the largest-flow GloFAS cell near a Natural Earth river
  centreline and their percentiles are bundled, built offline by
  `scripts/build-river-discharge-points.mjs`; `/api/river-discharge` reads only
  those points, one weighted call each, cached for three hours. A card names
  the river and gives the peak and its day, today's flow, the ensemble spread
  and the percentiles. It is a modelled outlook, not observed flooding or an
  official warning, and the free Open-Meteo API is non-commercial
  (daikaginza, #PR).
