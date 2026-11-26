- GNSS Integrity cells no longer streak through photorealistic 3D tiles at
  globe scale: they draw as a flat layer over the tiles and terrain, hidden
  only past the Earth's horizon. Draw sets take a new `clampTo: 'overlay'`
  for this (Sameh Khamis, @samehkhamis, #1933).
