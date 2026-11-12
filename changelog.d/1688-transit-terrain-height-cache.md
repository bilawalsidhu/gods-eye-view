- Fix the page freezing for seconds at a time with Transit on over a terrain
  globe, most visibly while zooming over a large fleet. Every reread asked the
  terrain for the height of every trail fix of every vehicle in view; heights
  are now kept per point, read again only while the camera moves or tiles
  load, and read within a time budget that puts vehicle positions first
  (mazy1998, #1688).
