- Overpass data whose element tags contain a failure phrase ("timed out",
  "runtime error", "too many requests" and similar, e.g. a place named "Timed
  Out Escape Rooms") is returned as data instead of being refused and putting
  the endpoint on cooldown; upstream failures are read from the remark (Aditya,
  @Rohilalala, #1097).
