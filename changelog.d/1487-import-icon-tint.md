- An imported KML or KMZ no longer draws its icons black. Cesium tints a
  placemark's icon with the colour its KML style carries, and the black an
  ArcGIS export writes into its styles is a placeholder that means "use the
  product's own colour", not a request for a black marker: a KMZ that packs
  its own coloured PNG was drawn as a black smudge, and on the dark globe it
  could not be seen at all. The placeholder now tints nothing, so the artwork
  a file packs shows as it was drawn and a marker with no artwork of its own
  keeps the colour the loader gives it. A colour that does say something
  still tints as the file asks, with its alpha lifted to a floor so a colour
  too faint to see cannot hide a marker. The Ghost Maps layer obeys the same
  rules, which now live in one place (Fuulks, #1487).
