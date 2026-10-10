# Airports (Norway)

OpenStreetMap-derived Norwegian airports bundled for the Airports layer.

- Source: OpenStreetMap contributors, Geofabrik extract **norway-261005**
  (OSM data 2026-10-05), MD5 `1d2cfdeb98980fce11b8891d0f9146c0`
- License: Open Database License (ODbL) 1.0
- Runtime file: `airports.geojsonl` (229 features)
- Rebuild: `python scripts/build-airports-norway.py --cache <dir> [--verify]`
  (requires `osmium-tool`)

**Aerodromes (89).** Every `aeroway=aerodrome` inside Geofabrik's Norway
boundary (Svalbard and Jan Mayen included) with a Norwegian ICAO location
indicator (`EN..`), excluding disused and abandoned ones. Only `name`,
`name:en`, `icao`, `iata`, `operator`, `aerodrome:type`, `ele` and `wikidata`
are kept. An aerodrome mapped as an area keeps its outline; one mapped as a
node stays a point.

**Runways (136).** Each aerodrome's `aeroway=runway` ways, drawn as surfaces
from the centreline and its `width` tag (30 m when untagged). They carry
`role: "runway"` and the aerodrome's ICAO code, and have no card of their own.

**New Bodø Airport (4).** OpenStreetMap maps it as construction: the site
(`w714425964`, `construction=airport`), the runway (`w1019473337`,
`construction=runway`) and the terminal (`w539307318`). Its card sits at the
middle of the new runway, clear of today's airport; the site, runway and
terminal are drawn parts with a `role`. The OSM runway has no
width, so it is drawn 45 m wide, the ICAO code-4 width of today's Bodø
runway. The card's project facts come from Avinor's published project brief
(January 2026): a 2,750 m runway about 900 m south-west of today's, a
24,000 m² terminal, and trial operation from the second half of 2029. These
features carry `stroke: "#ffb000"` and `status: "under construction"`, and the
build fails if OSM stops mapping any of them as construction.
