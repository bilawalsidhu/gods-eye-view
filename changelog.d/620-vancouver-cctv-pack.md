- Add Vancouver's public traffic cameras to the CCTV mesh: 834 directional
  stills across 219 City intersections, served from trafficcams.vancouver.ca
  against the City's open-data camera list. Headings come from the city's
  N/E/S/W designations and frames refresh on the source's 5-minute cycle. The
  image terms are unconfirmed, so the pack is opt-in: it loads only with
  `CCTV_VANCOUVER_ENABLED=1`, and `CCTV_VANCOUVER_MAX_SOURCES` sets the cap
  (600 by default, nearest downtown first). Vancouver also becomes a curated
  location with five fly-to POIs (Koderkup, #620).
