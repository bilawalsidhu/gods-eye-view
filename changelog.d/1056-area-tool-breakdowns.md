- `aircraft_in_area` and `vessels_in_area` take `group_by` and `stats`, so an
  MCP client can ask which airlines, countries, aircraft types or ship types
  dominate an area, or the average altitude or speed, over every match instead
  of estimating from the returned rows. Airlines come from the ICAO designator
  in each callsign (SWA1234 counts as SWA), so the breakdown works on feeds
  that report no operator; operator and type are counted only where the feed
  reports them. Ship types count by family, so AIS codes 70 to 79 are all
  cargo; type 0 ("not available") and the reserved codes 100 to 255 count as
  unknown. Altitude and speed stats cover airborne aircraft only, so parked
  aircraft do not pull the means down. Every vessel answer, `find_vessel`
  included, now reads AIS ship-type codes as their family and a destination
  with no letters as unknown (quanticsoul4772, #1056).
