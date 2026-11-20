- The CCTV Street View fallback answers only for cameras the server lists, at
  their catalog position; a request sets only the view. Bundled seed cameras
  get the placeholder. A per-IP limit on `GEV_RATELIMIT_GOOGLE_PER_MIN`
  (default 120) keeps the Google key from serving as an unmetered Street View
  service (asturksever, #1602).
