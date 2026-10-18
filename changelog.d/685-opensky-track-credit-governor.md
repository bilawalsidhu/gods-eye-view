- Stop the track-backfill proxies from spending the OpenSky credit budget the
  main flights proxy is protecting. `/api/flights/track` and
  `/api/military/track` now carry an always-on 30-per-minute per-client limiter
  (90 global), and `/api/flights/track` honours the 429 cooldown that
  `/api/flights` already sets: while the account is out of budget it serves any
  cached track and otherwise answers `429` with the remaining cooldown rather
  than spending 4 more credits. The existing 60-second per-key cache bounds
  memory, not spend — a caller varying `icao24` produced a fresh upstream call
  every time. Single-aircraft backfill, which is issued once per selected
  contact, is unaffected (daikaginza, #685).
