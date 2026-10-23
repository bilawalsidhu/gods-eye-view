- Serve the camera catalog while it refreshes. An expired catalog made every
  camera request wait for the slowest pack to reload; it is now answered at
  once while one background refresh runs, so only the first load waits. Estonia's
  slow Tarktee feeds get 30 s instead of 15 s, so the pack no longer drops out
  on about a third of loads (quanticsoul4772, #1234).
