- Add the Data Library. New regional and niche sources no longer join the
  Data Layers panel: **Browse data library** at its foot lists live entries
  (a manifest each in `src/library/entries/`, fetched from the provider, never
  bundled) with their licence, coverage and what this instance needs to serve
  them, and **Add** puts one under a Library heading. Datasets (GeoJSON, CSV,
  ArcGIS), raster tiles and host-layer packs are supported; selections persist
  and travel in share links as `lib=`, separate from the layer tokens; one
  generic `/api/library` proxy serves entries without CORS. Seeded with NASA
  EONET events, EIA and WRI power plants, NWS alerts, NOAA tide stations,
  Smithsonian volcanoes, NASA Black Marble, and the
  opt-in IMF PortWatch and CCTV packs, plus the City of Amsterdam's
  traffic and ANPR camera positions (opt-in; contributed by @Maher-Reven in
  #251). FEMA USA Structures and the
  National Bridge Inventory load what is in view once you zoom in, and
  Addresscloud's EPC ratings stream from Source Cooperative's GeoParquet on
  S3, coloured A–G with live legend counts. Open tile overlays (geology,
  biodiversity, surface water, national aerial photos and maps)
  join GDACS alerts and EPA Superfund and TRI facilities. 57 aerial photo
  layers from the Open Imagery Register (national programmes across Europe,
  NSW, NAIP and US state, county and city services, WMS and ArcGIS export
  included) show their resolution, true-ortho flag, years flown and refresh
  cycle in Browse; aerial photos stay above every other drape, are clipped to
  their coverage, and the providers' blank fill no longer whitens the globe.
  Kartverket's open Norwegian maps (topographic, nautical charts, hillshade,
  terrain relief, sea depths, boundaries and the cadastre) and Mapterhorn's
  global terrain, drawn in the browser as shaded relief with an elevation
  legend, are in the library too. Stat tiles head the dialog. A library layer's row has
  Zoom to layer and Remove icons, and the dialog has Zoom and a confirmed
  Remove all (asturksever, #1604).
