- Add a River levels layer with per-gauge level alerts for people in risk
  zones beside a river: select a gauge, pick one of its official levels
  (watch, warning, flood, above record high, or the drought levels) in the
  Weather panel, and the app says so once a fresh reading reaches it, with a
  page toast and, if allowed, a system notification. Alerts stay in the
  browser, are checked every 10 minutes while the app is open with the layer
  on, and complement, never replace, official warnings. The keyless
  `/api/river-levels` proxy merges PEGELONLINE (every German federal-waterway
  gauge), Taiwan's Water Resources Agency, the Water Survey of Canada (ECCC)
  and Rijkswaterstaat in the Netherlands; each gauge is coloured only from
  its own published references, rivers are drawn in their gauge's colour from
  the OpenStreetMap waterways in the OpenFreeMap tiles, and gauges up close
  get columns marked with their references. Off by default; share-link token
  `9` (IMBrandao, #1565).
