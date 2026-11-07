- Add Minnesota DOT (MnDOT) traffic cameras to CCTV, read at runtime from
  MnDOT's public IRIS camera list, with on-demand stills and attribution.
  Cameras load nearest Minneapolis–St Paul first. No API key is required. The
  pack is off by default until MnDOT's reuse terms are confirmed; set
  `CCTV_MNDOT_ENABLED=1` to load it (MattBenesch, #1437).
