- Serve CCTV cameras that have no public picture as location-only instead of
  an endless placeholder. The proxy learns it from real answers: two failed
  frames mark a camera for 24 h (a 5xx, 408, 429, timeout or network error is
  only a 10-minute retry window, then the feed is tried again). Optional
  snapshot failures never hide live HLS, MP4, WebM or MJPEG feeds. A TxDOT
  district is location-only only after two consecutive all-fail probes of
  three sampled cameras (Byrd-IT, #1314).
