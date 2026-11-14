- Add Rail in the Movement group, off by default: live trains from 30 keyless
  operator feeds in the United States, Canada, Australia, Ireland, Finland,
  Spain, Norway, Malaysia, Japan and France, from commuter and long-distance
  rail to the streetcars and trams of Seattle, Cincinnati, Toyama, Bordeaux
  and Montpellier. A new `/api/rail` proxy fetches registered feeds only,
  needs no key and drops buses from mixed feeds. Every train shown is live:
  29 feeds publish GPS positions and Irish Rail its station reports, and 28
  of them show with no setup. No train is placed or moved from a timetable;
  a feed whose live positions fail shows as unavailable. Packs are an opt-in
  extra: `node scripts/build-rail-paths.mjs --feed <id>` (or `--all`) builds
  a feed's path and schedule packs into `.cache/rail-paths/`, which add the
  operator's own route lines, stop names, the next stop and trip-update
  delays to its live trains; Renfe long and medium distance and KTMB, whose
  vehicles name no route, appear once their pack is built. Nothing is
  downloaded when the app starts, and lines are only ever the operator's own
  shapes. Trains are coloured by category (urban, local, regional, national,
  international), each with a chip and legend entry shared via token `02`,
  glide between reports with Transit's delayed playback, are drawn once when
  several feeds carry them, and open a card on click. A selected train that
  is moving is followed by the camera, as an aircraft is, and any other is
  flown to once; the selected train and its line stay on the map from orbit.
  No train is placed in Ukraine. Feeds that publish no licence are used on
  the basis each one's entry records, and their credit never presents that
  as a licence (Denis Groshev, @ZloyS, #1675).
