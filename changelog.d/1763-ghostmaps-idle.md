- S2 GhostMaps stops polling GitHub once no browser has the layer open and
  no request has come for `GHOSTMAPS_IDLE_MS` (10 minutes by default; `0`
  keeps polling until the server stops); the next request starts it again
  (gradyhnichols, #1763).
