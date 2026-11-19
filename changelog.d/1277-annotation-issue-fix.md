- Drawing a large board of screen annotations no longer stalls the app for
  seconds: marks behind the camera, past the horizon or out of view no longer
  sample the surface height under them, and marks still waiting for the map
  surface to load share a small sampling budget and retry once a second
  (asturksever, #1277).
