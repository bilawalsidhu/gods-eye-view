- Add **EV Charging**, a keyless Infrastructure layer of the charging stations
  mapped in OpenStreetMap, read from OpenFreeMap's OpenMapTiles `poi` tiles at
  z14 for the current view (16 tiles at most; a wider view asks to zoom in).
  Lime points open a card with the mapped name, coordinates and the
  OpenStreetMap credit, and **SHOW NEAREST** finds the closest one. Locations
  and names only: the tiles carry no sockets, power or live availability, and
  the layer claims none (daikaginza, #1329).
