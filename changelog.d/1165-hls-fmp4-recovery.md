- Recover live CCTV HLS windows that still advertise expired older segments:
  skip older 404s once and mark the gap, while recent-segment and access errors
  still fail. Raise the bounded segment allowance from 4 to 12 MiB for public
  1080p cameras. Cold starts and upstream restarts fetch only the newest two
  segments, avoiding downloads immediately evicted from the 24 MiB cache.
  Integrate whole-file fMP4 and session/lease-protected init routes from #1145,
  with independent 256 KiB init caps inside the unchanged 24 MiB session budget.
  Composite media/init identities prevent false restarts after startup trims
  and expired 404s; init errors and redirect/origin failures cannot be skipped.
  The two-session limit and strict newest-segment failures stay in place.
  (radianx, #1165).
- Reconcile asturksever's socket-owned HLS admission from #1267 with the
  fMP4/HD relay, protecting init files and media without increasing either
  lease or memory budgets. Cover shared-peer recovery, expiry, disconnects,
  pending downloads and exact-limit HD caches (radianx, #1165; asturksever, #1267).
