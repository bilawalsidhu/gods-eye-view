- Cross-site browser requests can no longer spend the TomTom traffic-tile
  budget through `/api/tomtom/*`. The shared same-site gate runs before status,
  cache, and upstream work; same-origin app requests and non-browser local
  callers remain supported (Sunil56224972, #973).
