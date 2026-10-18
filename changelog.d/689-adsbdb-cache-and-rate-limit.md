- Bound the adsbdb enrichment proxy. `/api/adsbdb` had no request limit and no
  cache eviction, so a caller cycling through the callsign or hex keyspace
  could drive unlimited live requests at the free community API and grow
  `.gev-cache/adsbdb.json` without end — every distinct key, 404s included, was
  remembered forever. The route now admits 360 requests/minute per client
  address (the browser's own drip cannot exceed 300), refusing the rest with
  429 and `Retry-After` before any cache, disk or upstream work. Each cache
  holds at most 20,000 entries, dropping the least-recently-written first, and
  entries past the existing 24-hour TTL are discarded when the file is read
  back. Cached answers and response shapes are unchanged (daikaginza, #689).
