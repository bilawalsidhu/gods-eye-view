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
- Click a station pin on the Transit row to open its card: the station name, short code, UIC code, rail segment, commune INSEE code and position, with the pin ringed while it is selected. Escape or a click on empty space closes it, and it shares the one selected-card slot with vehicles. Station names are now drawn for the stations nearest the view centre (and only below 400 km), instead of the first 48 by id; the Vehicles view no longer reports hidden stations (Fuulks, #1415).
- The ENTSO-E proxy now asks the Transparency Platform the way its API expects (document and process type, bidding-zone EIC code, `yyyyMMddHHmm` periods), reads `quantity` and `price.amount` points from Periods of any resolution into hourly values, defaults the day to today and the zone to France, and caches each answer so a second tab does not spend the token. Unknown routes on the French open-data proxies answer 404, and the keyless proxies refuse cross-site browser requests (Fuulks, #1415).
- Ghost Maps draws each event as a small cyber-cyan symbol chosen by its type (missile, drone, aircraft, naval, strike, clash, fire, casualty, unrest, checkpoint, displacement, facility, or a generic report diamond; the kind is read from the placemark's Type row, name, folder and icon name) instead of decoding the image every KMZ placemark packs for itself. Every placemark of a kind shares one texture, which removes a blob URL and a GPU texture per icon from large exports. Its row icon is now a single-colour glyph like the other rows, in every theme, and the Cyber theme gets a glyph for Ghost Maps and the four French and European layers instead of the generic diamond (Fuulks, #1415).
- The European Grid layer now draws one pin per country (France, Germany, Spain, Italy, Great Britain, Belgium, the Netherlands, Portugal, Austria, Switzerland, Poland), coloured by that country's current load against its own day's peak, instead of a chain of hourly points over the Atlantic. Clicking a pin opens a card with the current reading, the day's curve and its low and peak, and points the row's hour list at that country. Flood Warnings and Copernicus EMS get the same click card: a sensor, a warning zone or an activation opens its name, river or hazard, level or status and dates. Escape or a click on empty globe closes it (Fuulks, #1415).
- Transit station colours no longer list segments D to F, which the catalogue never publishes, and the Bike Share description no longer names Paris and Vélib' as if they were the whole row (Fuulks, #1415).
- Ghost Maps shows small cyan dots instead of event symbols while the camera is more than 1,200 km from a marker, and switches to the symbols as you zoom in, so a dense region no longer smears into one blob from orbit (Fuulks, #1415).
- Ghost Maps markers are no longer ground-clamped, so zooming in no longer makes them disappear while terrain or 3D-tile heights load (Fuulks, #1415).
- The data platform's first phase: an optional PostGIS service (compose profile `platform`), numbered SQL migrations with a checksummed runner (`npm run platform:migrate`), a same-site health route, nightly backup and restore-test scripts, and the ontology schema with a `person` type held to a stated basis and retention, plus `objects_as_of` to replay a past moment as it was known then. Without `GEV_DATABASE_URL` nothing changes. Roadmap and operations notes are in docs/platform (Fuulks, #1415).
- The POWER UP panel has a DATA PLATFORM row for the platform database password and connection URL (Fuulks, #1415).
- The Copernicus EMS proxy reads each upstream page through the capped JSON reader (4,000,000 bytes, enforced while it streams) instead of buffering it whole, and answers an oversized page with a 502 `RESPONSE_TOO_LARGE` (Fuulks, #1415; reported by @kvnloo).
