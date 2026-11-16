- Ghost Maps markers can no longer vanish. A marker now always has an image:
  where the symbol cannot be drawn, a plain disc in the product's colour takes
  its place, and where there is no canvas at all, a built-in disc does. The
  failure is reported once per kind of event instead of once per placemark,
  and it is cached, so a broken environment does not retry for each of the
  20 000 placemarks a product can hold. The colour a KML style carries can no
  longer hide a marker either: the black an ArcGIS export writes into its
  styles is a placeholder, not a colour to draw, and a colour too faint to see
  is lifted to a floor. The layer no longer decodes the image each KMZ packs
  beside a placemark, and the dead plumbing that resolved it is gone
  (Fuulks, #1486).
