- Keep missing CCTV numbers unknown instead of reading them as zero. `Number`
  turns null, blank strings and booleans into 0 or 1, and the camera source
  list sends an unknown number as JSON null, so a source-pack camera that left
  out its pose reached the browser as zeros clamped to each field's floor —
  facing north, pitch −2°, FOV 20°, range 120 m, mount 6 m and ground 0 m —
  instead of the defaults (id-hash heading, −17°, 74°, 700 m, 24 m and the
  city's ground); a null or blank position placed the camera at 0,0. The
  server's `toFiniteNumber` and the browser's `safeNumber` now treat absent,
  blank and boolean values as missing. The same conversion also stops a
  Tallinn row with a null heading reading as a confident north-facing camera,
  a Caltrans camera with a blank elevation losing its 150 m ground prior, and
  a TfL or Catalonia camera with a null or blank coordinate being kept at 0,0
  or on the zero meridian (omerbberk, #1172).
