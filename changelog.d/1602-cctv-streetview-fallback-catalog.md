- The CCTV Street View fallback serves only catalog cameras, always at their
  catalog position, and ignores coordinates a request supplies. It has its own
  per-client limit on the Google setting (`GEV_RATELIMIT_GOOGLE_PER_MIN`,
  default 120), so the Google key can no longer be used as an unmetered Street
  View service (asturksever, #1602).
