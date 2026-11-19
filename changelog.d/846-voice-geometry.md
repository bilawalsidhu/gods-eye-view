- Voice can reuse what it outlines. `resolve_area` turns a named place into a
  reusable area, keeping every part and hole, from the same sources as voice
  outlines; a name several countries or states share ("Georgia", "Punjab") is
  asked about unless the view is inside one of them. "Draw an area around
  <landmark>" outlines the mapped area enclosing it, or a 250 m buffer marked
  approximate. `analyst_query` counts inside an area, the area you drew or an
  outline on the map, and `find_imagery` shows the best recent acquisition for
  an area, the view or the spot under the pointer (manjunath22466, #846).
- `osm_query` ("hospitals in Kathmandu") lists places of one kind into a
  session-only OSM Places layer. It is offered only when `OVERPASS_UPSTREAMS`
  is set, and `/api/osm/features` refuses before fetching otherwise; public
  Nominatim is never used for it (manjunath22466, #846).
- Analyst counts that combine flights, military aircraft and local ADS-B are
  named "aircraft". Follow-ups keep the displayed scope and the loaded-data
  caveat until a new scope replaces them (manjunath22466, #846).
