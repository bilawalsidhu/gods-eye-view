- `get_traffic_flow` flags stale cached TomTom tiles and reports the oldest
  tile fetch time (`stale`, `oldest_tile_at`), with pending freshness metadata
  released on failed or cancelled tile reads (quanticsoul4772, #1239).
