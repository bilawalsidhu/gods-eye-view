- Add an optional, keyed **World News** layer in the Events group: the newest
  place-tagged World News API headlines pinned at the place each headline
  names, aggregated per place and colored by tone, with a click-to-inspect
  readout card (clicking a selected pin steps to its next story) and OPEN
  ARTICLE, LOAD MORE, NEWS IN VIEW, GLOBAL FEED, CLEAR PINS and PREV/NEXT STORY
  chips. NEWS IN VIEW fetches one page for the circle the camera frames (the
  provider caps the radius at 100 km, so a wider view is refused rather than
  clamped; the centre is snapped to a 0.5° grid before it leaves the browser).
  Fetches add pins until CLEAR PINS, refreshes never follow the camera, and
  syndicated copies of one headline at one place collapse into a single story.
  The server-side `/api/world-news` proxy keeps the key server-side, caches for
  30 minutes, deletes anything older than 60 (the provider's caching limit),
  and admits every upstream call against a daily point budget
  (`WORLD_NEWS_DAILY_POINT_BUDGET`, default 40 of the free plan's 50; one page
  a refresh by default, `WORLD_NEWS_PAGES`). Adds the `WORLD_NEWS_API_KEY`
  POWER UP entry, share-link token `6` and the required attribution backlink.
  Voice does not reach the layer yet (`VOICE_OFF_LAYERS`): the Realtime prompt
  is at its 52,000-character cap. Keyless installs read KEY REQUIRED and make
  no upstream request (ddsky, #754).
