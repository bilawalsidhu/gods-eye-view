- Add an Airports layer for Norway under Infrastructure. It bundles the 89
  aerodromes OpenStreetMap maps in Norway with an ICAO code (every Avinor
  airport, plus Torp, Rygge, Ørland, Stord, Svalbard, Jan Mayen and the
  airfields), drawn with their outlines and runway surfaces, and cards with
  ICAO · IATA · operator and civil/military type. New Bodø Airport, under
  construction, is drawn in amber: site, 2,750 m runway and terminal, with
  Avinor's planned 2029 opening. `scripts/build-airports-norway.py` rebuilds
  the file from Geofabrik's current Norway extract and records its name.
  Voice and the analyst know the layer as `local-airports`; its share-link
  token is `6` (trygvehhh, #955).
