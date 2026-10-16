- Recover live CCTV HLS windows that still advertise expired older segments:
  skip older 404s once and mark the gap, while recent-segment and access errors
  still fail. Raise the bounded segment allowance from 4 to 12 MiB for public
  1080p cameras; the 24 MiB retained cache and two-session limits stay in place.
  (radianx, #1165).
