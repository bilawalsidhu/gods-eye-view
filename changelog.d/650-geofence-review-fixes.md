- Harden the Geofence breach webhooks before they ship: webhook URLs must be
  `https` on a public host (loopback, private and link-local addresses, and
  URLs with embedded credentials are rejected), each POST carries an abort
  timeout so a hanging receiver cannot hold the request open, and the monitor
  diagnostics report only whether a URL is configured instead of the secret
  itself. Drawing a fence over records that are already inside no longer fires
  one breach per record — the fence seeds them as a silent baseline — and the
  monitor pulls no layer data at all until a fence exists. Breach payloads
  report speed as `speedMps` with an explicit `m/s` unit, converting the knot
  readings vessels and local ADS-B report (keology, #650).
