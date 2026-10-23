- Bound what a caller can grow through `/api/terrain/heights`. Every distinct
  5-decimal point was a permanent in-memory entry, a permanent line in an
  uncapped `.gev-cache/terrain-heights.json`, and a live upstream call, with
  nothing limiting the rate. The point cache now holds at most 50,000 entries
  and evicts oldest-first, a cache file above
  24 MB is not read back, and the route is limited to 90 requests/minute per
  client (270 global). Evicting a point costs one refetch, never a wrong
  answer, since terrain does not move. Ordinary use is unaffected: a full
  `test:track` run drives 10 requests, peaking at 8/min (daikaginza, #686).
