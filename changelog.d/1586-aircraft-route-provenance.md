- Mark undated adsbdb aircraft routes as unverified reference data in flight
  cards, voice context, and MCP queries, and discard delayed route enrichment
  after a tracked aircraft's callsign changes (dvilrgamerz, #1586).
- Reject stale callbacks after callsign reuse (A → B → A) or aircraft
  re-admission, while allowing a fresh lookup for the new association.
