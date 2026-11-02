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
- Preserve main's proxy-compatible keyless same-site admission for all CCTV
  routes. HLS media and initialization files use active session/lease tokens,
  without direct-socket ownership or per-peer quotas from the unmerged #1267.
  Cover forwarded playback, cross-site denial, expiry, disconnects, pending
  downloads and exact-limit HD caches (radianx, #1165).
