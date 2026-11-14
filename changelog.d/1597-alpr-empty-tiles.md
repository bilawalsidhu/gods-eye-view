- Mapped ALPR Cameras no longer reports "Vector tiles unavailable (HTTP 404)"
  over Portland and other views north of 41°N: the extract server answers 404
  for tiles with no cameras, and the Canada extract reaches down to 42.3°N, so
  those empty tiles took the layer down. The tile reader has an opt-in
  `emptyStatuses` option and the ALPR source treats 404 as an empty tile;
  traffic and basemap tiles are unchanged (theseriouspdx, #1597).
