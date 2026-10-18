- Aim the CCTV Street View fallback at the registered camera pose and meter it
  per client. `/api/cctv/frame/:id` no longer honours `lat`/`lon` from the query
  string, no longer falls back for an unregistered camera id, rejects an
  off-globe or absent pose before the request is made, and admits at most 240
  lookups per minute per client (720 across all clients). Frames for registered
  cameras are unchanged; a refused lookup serves the existing synthetic card.
  The dev server also refuses to serve `.gev-logs/` and `.gev-cache/`, which
  hold the voice debug transcript and provider caches (daikaginza, #666).
