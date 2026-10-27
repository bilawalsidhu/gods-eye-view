- Render at 30 frames a second while only slow live feeds (flights, vessels,
  satellites, launches, traffic, transit, military awareness, wind) animate a
  parked view; any camera motion or other animation restores the full rate.
  Wind's GPU flow now holds the render governor instead of pumping its own
  renders (nu-stats, #1422).
