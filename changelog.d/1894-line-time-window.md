- A line can show only the part of it within a span of the scene clock
  (`LineAgeFade.showMs`, capability `lineTimeWindow`): the renderer cuts it by
  time on the GPU as the clock moves, so a moving trail can be sent once as
  its whole track; the Cesium renderer draws it, draped or not (samehkhamis,
  #1894).
