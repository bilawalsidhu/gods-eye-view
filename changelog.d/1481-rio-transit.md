- Add Rio de Janeiro to the Transit layer: municipal buses and the Mobi-Rio BRT
  from SMTR's keyless GTFS-Realtime feeds (CC BY 4.0), the layer's first Latin
  American region. A feed that publishes speed in km/h declares
  `speedUnit: 'kmh'` and the proxy converts it to m/s. Rio's internal route
  keys are joined to SMTR's published GTFS `routes.txt`, so a card reads
  "Route SN731" rather than "Route O0731AAN0A" (IMBrandao, #1481).
