- Traffic flow says when it comes from stale cached tiles. Past the daily
  TomTom budget, or while TomTom fails, the proxy serves its last copy of a
  tile however old it is; `get_traffic_flow` now returns `stale` and
  `oldest_tile_at` and says traffic may be out of date instead of presenting
  it as live (quanticsoul4772, #1239).
