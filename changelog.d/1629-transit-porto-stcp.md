- Add Porto to the Transit layer: STCP's buses from the Porto Digital Urban
  Platform (CC0, via dados.gov.pt). It is
  the first transit feed that is not GTFS-Realtime: a registry entry can now
  declare `format: 'ngsi-v2'`, and the proxy decodes a FIWARE NGSI v2 broker's
  JSON `Vehicle` entities into the same vehicle records, under the same
  registered-URL, redirect, size, entity-count and string-length rules; an
  unknown format is refused (IMBrandao, #1629).
- Reject calendar-invalid zoned NGSI observation times instead of silently
  rolling them to a different day. The shared missing-time fallback then
  applies to these STCP vehicles (IMBrandao, #1629).
