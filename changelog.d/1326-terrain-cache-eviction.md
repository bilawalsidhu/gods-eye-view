- Evict terrain-height cache entries in fetch-time order without repeatedly
  sorting the full cache, while keeping refreshed points newest and ordering
  restored entries by their fetch time (daikaginza, #1326).
