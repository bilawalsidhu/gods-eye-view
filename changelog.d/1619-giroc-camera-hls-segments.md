- Add an optional Giroc / Webcam Romania CCTV source pack with corrected
  coordinates, live HLS, a snapshot fallback and provider attribution. Allow
  HLS segments up to 8 MiB so high-resolution cameras whose segments exceed
  4 MiB can play, while retaining the 24 MiB per-session cache and existing
  origin and session limits (NeoXrated23, #1619).
