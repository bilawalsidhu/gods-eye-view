- Harden the Geofence breach webhooks before they ship: webhook URLs must be
  `https` on a public host (loopback, private and link-local addresses, and
  URLs with embedded credentials are rejected), each POST carries an abort
  timeout so a hanging receiver cannot hold the request open, and the monitor
  diagnostics report only whether a URL is configured instead of the secret
  itself. A breach now needs a record to be seen outside the fence first, so
  drawing a fence over records already inside, enabling a layer, or a record
  returning to its feed no longer fires one breach per record, and the
  monitor pulls no layer data at all until a fence exists. Breach payloads
  report speed as `speedMps` with an explicit `m/s` unit, converting the knot
  readings vessels and local ADS-B report (kevinsalerno, #650).
