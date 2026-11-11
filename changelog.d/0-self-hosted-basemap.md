- Let an operator serve the keyless basemap from their own tile server:
  `GEV_BASEMAP_URL` takes an https XYZ template that replaces Esri World
  Imagery, with `GEV_BASEMAP_ATTRIBUTION` for its credit. The map tile reads
  "Basemap", keeps the `esri-imagery` share-link id, and never falls back to
  OSM; an invalid value stops the server at startup. Unset, Esri stays the
  default (daika, #PR).
