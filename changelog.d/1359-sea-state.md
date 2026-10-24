- Add a keyless **Sea state** weather layer: global significant wave height
  from the ECMWF IFS wave model (open data, CC BY 4.0), resampled server-side
  from 0.25° to a 0.5° float32 grid with land masked, and shaded in WMO code
  table 3700 bands (smooth to phenomenal; calm water and land stay clear). The
  new `/api/sea-state` route refreshes hourly, falls back one cycle while the
  newest run is not yet posted, and serves the last field for up to 24 h with
  `X-Data-Stale` before answering `502 sea_state_unavailable`. On Google 3D
  Tiles the field draws on a raised shell like the observed weather layers
  (daikaginza, #1359).
