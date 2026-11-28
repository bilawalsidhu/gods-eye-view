- Give every `flyToBounds` sphere an ECEF centre, as the renderer contract
  types it: a drawn mark's Fly to, an installation's focus, a launch's site
  focus and roster preview, and street level's photo framing passed lon, lat
  and height, which only the Cesium camera port converts, so a camera that
  reads the contract's type flew to a NaN eye and the globe stopped drawing.
  Cesium flies to the same places as before (asturksever, #1948).
