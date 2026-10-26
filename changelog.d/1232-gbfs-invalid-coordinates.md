- Skip bike-share stations with missing, blank or invalid coordinates instead
  of placing them at coerced zero coordinates or accepting out-of-range values.
  Explicit zero coordinates and numeric strings remain supported (Bortlesboat, #1232).
