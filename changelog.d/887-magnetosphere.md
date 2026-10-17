- Add a Magnetosphere layer: Earth's magnetic field drawn as 3D field-line
  filaments, with a magnetopause that responds to the live solar wind. The
  internal field comes from a vendored public-domain IGRF-14 table and is traced
  in the browser in short slices so the globe keeps drawing. The external field
  is Tsyganenko T96 when the feed carries dynamic pressure, Dst and the IMF By
  and Bz, T89c when only Kp is available, and the internal field alone
  otherwise, rather than a guessed storm state; the lines are re-traced as the
  Sun moves, so the tail keeps pointing away from it. The layer reports which
  model drew the lines and when one is run outside its fitted range. Only the
  solar wind, Kp and Dst are fetched, through a shared `/api/magnetosphere`
  proxy with timeouts and backoff, and the boundary is flagged when it is driven
  inside geosynchronous orbit (KnottyDyes, #887).
