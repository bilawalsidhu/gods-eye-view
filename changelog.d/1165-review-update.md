- Recover live CCTV HLS windows that still advertise expired older segments:
  skip older 404s once and mark the gap, while recent-segment and access errors
  still fail. Raise the bounded segment allowance from 4 to 12 MiB for public
  1080p cameras. Cold starts and upstream restarts fetch only the newest two
  segments, avoiding downloads immediately evicted from the 24 MiB cache.
  The two-session limit and strict newest-segment failures stay in place.
  (radianx, #1165).
