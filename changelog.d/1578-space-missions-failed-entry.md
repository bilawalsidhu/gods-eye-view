- Space Missions no longer locks the workspace when its mission index fails to
  load. A 429, timeout or bad payload on `/api/launches` now rolls the entry
  back to the previous layers and camera view instead of leaving an empty,
  isolating mode, and the roster reads `30-DAY MISSION INDEX UNAVAILABLE`
  rather than loading forever (German, @gekh, #1578).
