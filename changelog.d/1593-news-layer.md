- Add the News layer (Events ▸ News) and its right-rail NEWS panel: the last
  24 hours of news, narrowed in the panel to the last 12, 6, 3 or 1 hours with
  the hotspot counts read for that window. Markers are coloured by severity
  only, with hotspot beacons, outlines with disputed areas, picture cards for
  major events and a continuous feed whose cards fly the globe to the event.
  An open card plays the post's clip on request. The panel has two sections.
  Conflicts lists the hotspots' news. Local, below 3,000 km, lists every
  report in the area at the view centre, newest first, names and outlines that area on the
  globe, and shows those reports on the map instead while it is chosen; a
  disputed area is named as itself and read from no country's outlets. Set
  `GEV_NEWS_ORIGIN` to a news server and the local server forwards the
  layer's three read routes there. Unset, Core answers them itself:
  Conflicts from the last 24 hours of GDELT 2.0 event exports with no key
  (physical violence only, one report per story at GDELT's place for it,
  titled from GDELT's GKG files for the newest 3 hours), plus Liveuamap's
  mapped items with `LIVEUAMAP_API_KEY`; Local from World News API with
  `WORLDNEWSAPI_KEY`, at most `WORLDNEWSAPI_DAILY_READS` reads a day
  (default 30), each country's news kept for at most 1 hour. The routes
  refuse cross-site and proxied requests. A section says when its key is
  required, refused or out of its daily allowance. The Data attribution popover credits the GDELT
  Project, World News API and, once its items show, Liveuamap
  (Denis Groshev, @ZloyS, #1593).
- Cockpit Regional News holds its list to the last 24 hours, newest first, on
  the server and in the client, and labels its four states apart: fresh
  results with no banner and a `LAST 24 H` footer, earlier results kept after
  a failed refresh near the same place as `CACHED · REFRESH FAILED`, `NO NEWS IN THE LAST 24 H`,
  and `REGIONAL NEWS UNAVAILABLE`. The banner is now really hidden over a
  populated list, and the footer no longer reverts to a static `RECENT` on a
  page change (Denis Groshev, @ZloyS, #1593).
