- Add four public cameras in Paraguay to the existing CCTV layer: Encarnación's
  Sambódromo / Costanera municipal player, Atacado Connect's rotating bridge
  view in Ciudad del Este, and two Grupo Ibarra feeds in Presidente Franco.
  Encarnación retains the original RTSP.me player, which unloads when hidden
  or deselected and has no frame proxy, coverage or calibration. The other
  three use native HLS. Enable them independently after checking operator terms with
  `CCTV_ENCARNACION_ENABLED=1` or `CCTV_ALTO_PARANA_ENABLED=1`.
  All locations are approximate; operator attribution is retained. The relay
  accepts bounded 1 MiB DVR playlists and 12 MiB HD segments while retaining
  its 24 MiB per-session cache.
  (radianx, #1161).
