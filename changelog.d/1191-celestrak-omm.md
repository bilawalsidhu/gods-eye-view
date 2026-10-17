- Satellites catalogued since July 2026 now appear. CelesTrak serves catalog
  numbers above 99999 only as OMM, never as TLE, so the CelesTrak proxy now
  fetches OMM JSON; TLE caches written before the switch still load as stale
  fallbacks (Marco Scheffler, @marco-scheffler, #1191).
