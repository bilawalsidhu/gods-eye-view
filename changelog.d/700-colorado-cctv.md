- Add an opt-in Colorado (CDOT / COtrip) CCTV camera pack: about 1,300
  statewide traffic cameras (Colorado DOT, CDOT Cellular, Douglas County), read
  keyless from the GeoJSON feed COtrip's own public map uses. Only still frames
  are registered; the feed's live HLS streams are left for a later change. The
  feed publishes no licence or terms, so the pack is off unless
  `CCTV_COLORADO_ENABLED=1`; once on, the nearest 300 to Denver and Colorado
  Springs load and `CCTV_COLORADO_MAX_SOURCES` changes that (SairamBhargav,
  #700).
