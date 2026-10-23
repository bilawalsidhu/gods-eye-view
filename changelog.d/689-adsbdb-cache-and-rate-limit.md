- Bound the adsbdb enrichment proxy. `/api/adsbdb` had no request limit and no
  cache eviction, so a caller cycling through the callsign or hex keyspace
  could drive unlimited live requests at the free community API and grow
  `.gev-cache/adsbdb.json` without end — every distinct key, 404s included, was
  remembered forever. The route now admits 720 requests/minute per client
  address (`GEV_RATELIMIT_ADSBDB_PER_MIN`; one tab's two enrichment queues top
  out at 600), refusing the rest with 429 and `Retry-After` before any cache,
  disk or upstream work. A refused lookup is asked for again once the refusal
  has passed instead of leaving that aircraft without metadata for the
  session. Each cache holds at most 20,000 entries, dropping the
  least-recently-written first, and entries past the existing 24-hour TTL are
  discarded when the file is read back. Cached answers and response shapes are
  unchanged (daikaginza, #689).
