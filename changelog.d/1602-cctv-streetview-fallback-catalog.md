- The CCTV Street View fallback serves only catalog cameras, at their catalog
  position, heading, field of view and pitch, and ignores coordinates a
  request supplies. It spends from the per-client Google budget
  (`GEV_RATELIMIT_GOOGLE_PER_MIN`, default 120), so the Google key can no
  longer be used as an unmetered Street View service (asturksever, #1602).
