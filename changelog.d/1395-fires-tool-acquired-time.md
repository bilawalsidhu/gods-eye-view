- Report a fire detection's acquisition time as a UTC timestamp in
  `get_active_fires`. The tool joined FIRMS's unpadded date and time, so a
  00:45 UTC detection read "2026-01-01 45"; it now reads
  `2026-01-01T00:45:00.000Z`. Missing or invalid dates and times remain
  unknown rather than rolling into another calendar day
  (Rudy Celekli, @rudycelekli, #1395).
