- FIRMS fire ages round to whole hours before choosing a unit, so an age of
  47.5–48 hours reads "2d", as exactly 48 hours does, not "48h". Detections
  are filtered to the trailing 24 hours, so this shows mostly in the
  `STALE · cached {age}` stats line after about two days without a successful
  refresh (@quanticsoul4772, #1531).
