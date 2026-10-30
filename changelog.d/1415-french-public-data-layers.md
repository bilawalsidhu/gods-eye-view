- Add four French public-data layers: VIGICRUES flood warnings and
  flood-warning zones, ENTSO-E European grid load, Copernicus EMS emergency
  activations, and the IGN Géoplateforme raster basemap. Each one fetches
  through a server-side proxy, so the browser never names an upstream URL,
  and each source's licence and attribution are recorded in
  DATA_SOURCES.md (Fuulks, #1415).
- Fold the French public data into the pre-existing rows instead of adding
  new ones: the Layers panel keeps one Transit row and one Bike Share row.
  The Transit row now draws the live GTFS-RT fleet AND the SNCF passenger-
  station network (2 792 stations, a static catalogue and not live train
  positions), and says so in its source line (GTFS-RT · SNCF). The Bike
  Share row gains Paris and the Vélib' network as one more GBFS city entry
  (1 519 stations with live bike, e-bike and free-dock availability), read
  through the same generic proxy every other city uses. The station
  catalogue is static, so it loads with the layer rather than following the
  fleet's camera-driven altitude gate (Fuulks, #1415).
- Draw the SNCF passenger stations as POINT PINS in a Cesium
  PointPrimitiveCollection instead of 2 792 translucent ground ellipses that
  covered the map, and colour them by the station class the catalogue
  supports: a principal station (the catalogue gives it a public short code)
  keeps its rail-segment colour, a local station (no short code) is drawn in
  the same segment colour muted. The Transit legend now counts those classes
  from the same pure classifier the map colours from, so the two cannot drift
  apart (Fuulks, #1415).
- Read the SNCF station fields from the record body as well as from the
  top level, so the proxy keeps every name, short code, UIC and
  coordinate whichever shape the catalogue answers in. Reading only the
  top level resolved them all to null against the record-body shape, and
  the row fell back to the station id - a station with no name on the map
  (Fuulks, #1415).
- Keep a station that belongs to more than one rail segment in its own
  colour. The catalogue publishes segment_drg as a semicolon-separated
  list, so ten stations - Paris Gare du Nord, Paris Gare de Lyon, Paris
  Austerlitz, Paris Montparnasse, Avignon TGV and CDG 2 TGV among them -
  were falling through to the neutral grey. A station in several networks
  now takes its first, primary segment (Fuulks, #1415).
- Give the French public-data rows the same visual grammar as the
  pre-existing layers, using only the three patterns the Layers panel
  already has: VIGICRUES becomes a legend of vigilance bands with live
  counts, the IGN row keeps its place and gains chips that switch the
  raster basemap, the Transit row gains chips that switch between the
  live fleet and the station network plus a legend of the rail segments,
  the Bike Share row shows the availability ramp every city in it is
  drawn in (Velib' included), and Copernicus EMS and ENTSO-E hand off to
  a rail card. The Transit row also splits its count into the two
  populations it draws, so a fleet of vehicles is never counted as
  stations (Fuulks, #1415).
- Every layer row now names the DATASET in its source line, never the
  operator: the operator and the licence stay in DATA_SOURCES.md and the
  in-app credits (Fuulks, #1415).
- A healthy layer row reads as three short segments — state, source, age —
  and the detail segment is reserved for a feed that is degraded, partial,
  stale or erroring (Fuulks, #1415).
- Follow the operator's same-origin redirect on the VIGICRUES station catalogue instead of treating the 302 as a failure; the route answers 200 and the warning-zone route, which carries the row's legend counts, is unaffected (Fuulks, #1415).
