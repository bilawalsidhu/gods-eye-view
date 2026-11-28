- NVG and FLIR redraw 15 times a second instead of 60 when nothing else is
  moving, and their bloom reads about a fifth as many texels per pixel (NVG
  121 → 22, FLIR 81 → 18) for a near-identical picture. Their grain now
  changes 15 times a second (mazy1998,
  #1718).
