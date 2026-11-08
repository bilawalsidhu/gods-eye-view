- Add Porto to the Transit layer: STCP's buses from the Porto Digital Urban
  Platform (CC0, via dados.gov.pt), Portugal's first city on the layer. It is
  the first transit feed that is not GTFS-Realtime: a registry entry can now
  declare `format: 'ngsi-v2'`, and the proxy decodes a FIWARE NGSI v2 broker's
  JSON `Vehicle` entities into the same vehicle records, under the same
  registered-URL, redirect, size, entity-count and string-length rules; an
  unknown format is refused (IMBrandao, #1629).
