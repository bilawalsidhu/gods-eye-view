- With nothing picked, Context names the place in view and the time there
  ("10:14 local, 16:14 UTC"); zoomed in with layers on, the weather there
  (temperature and conditions, wind, cloud, visibility and rain, from the same
  reading as the local time); then a radius slider (25 to 1,000 km, default
  250 km; it only filters what is loaded), a count per layer that is on with
  its feed state, and one Nearby section: a group per layer, nearest first.
  Fires and quakes list there as ordinary layers. News keeps its report list
  in the News panel, and Context shows the News layer's map status when it is
  on. At globe view, tiles show the provider's loaded count and breakdown or
  the layer's state, with up to three items nearest the centre that clear
  Earth's horizon. Search shows up to 12 matches per layer. Moving items
  such as satellites are read again every 10 to 60 seconds while Context is
  open on its view, and
  a costly layer is not read again for each step of a camera still moving.
  With nothing on, Context still starts closed and, opened, shows what layers
  would show (worldwide, last known, from what the server already caches) and
  points to Data Layers. The nothing-on tiles show last-known totals and
  ask no live service: their counts come only from what the
  providers already cache, never from a metered feed, or from a layer's own
  count while it is on when that count is of the whole world (Live Flights),
  never an area's. Last-known counts show their age when known. Each map
  layer that is on has a tile at every zoom: items show their count or why there are none
  (bikeshare: zoom in); fields (wind, GNSS integrity, recent imagery, air
  quality) show their value at the centre, or say when coverage is why there
  is none (air quality: no station within 50 km; recent imagery: outside the chosen area),
  and their state at globe view; map overlays (radar, lightning, satellite
  clouds, sea marks, ski pistes) say they are on the map and how fresh they
  are. Space Missions shows one tile, counting its list; Directions, a tool,
  gets none. A layer turned on shows in Context at once, reading … until its
  count is in. The local time can stay while the view pans nearby. Weather
  updates once the camera settles, and a failed read clears the observation.
  Weather and worldwide count requests pause while the Inspector is hidden,
  including when the browser tab is in the background. Returning to the same
  weather cell keeps its reading and resumes its refresh or retry clock.
  The weather tile also shows the reading's age once it is over half an hour old.
  Rail, traffic, submarine cables and their landing points, wildlife
  sightings, the Bhote Koshi locator and the tracked contact now list their
  items in Context, in search and in a card's nearby lists. The Bhote Koshi
  reconstruction keeps its dedicated panel. Wind, GNSS
  integrity, recent imagery and air quality give a value at a point. A cable
  is listed and counted once, using sample points along all its lines; a
  road is one traffic row for both directions, with the worse flow; and a
  GeoJSON layer lists and counts each feature once, however many parts it is
  drawn in (dam crests drawn as lines included). Train speeds read in km/h.
  Context suggests up to three layers by simple rules (the globe: satellites,
  flights and vessels; zoomed in: Street View; with layers on, what goes with
  them, under the Nearby lists), only where a layer declares coverage, and
  skips a layer that has reported its key missing; Open shows Data Layers with
  them picked out and switches nothing on. Suggested filters belong to the
  current app, and Show all layers restores the full list. The camera's height strip shows
  only with nothing on, as a full-width strip under the facts with a curve of
  where the camera has been. Context reads only the weather for the spot, not
  the full regional brief (manjunath22466, #9999).
