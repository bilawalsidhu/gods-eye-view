- Stop the OpenSky track-backfill proxy from turning a varied `icao24` into
  unbounded upstream spend. `/api/flights/track` carries an always-on
  30-per-minute per-client limiter (90 global), and a
  `429` from OpenSky `/tracks/all` now starts a cooldown for that credit
  bucket: until OpenSky's retry-after passes, any cached track is served and
  other lookups are answered `429` locally instead of asking for 4 more
  credits. The `/tracks/*` bucket is separate from the `/states/*` one
  `/api/flights` spends, so a flights cooldown does not block backfill. The
  existing 60-second per-key cache bounds memory, not spend. Single-aircraft
  backfill, issued once per selected contact, is unaffected (daikaginza, #685).
