- Add Minnesota DOT (MnDOT) traffic cameras to CCTV, read at runtime from
  MnDOT's public IRIS camera list, with on-demand stills and attribution.
  Cameras load nearest Minneapolis–St Paul first. No API key is required; set
  `CCTV_MNDOT_ENABLED=0` to skip it (MattBenesch, #1437).
