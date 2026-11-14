- Stop screen annotations sampling surface height for marks that are hidden,
  behind the camera or over the horizon. Visible marks still waiting for
  terrain share 32 samples per projection pass and retry once a second, so a
  large board no longer stalls the frame (asturksever, #1277).
