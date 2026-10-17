- Add a keyless SA Road Events layer (Movement group, off by default) showing
  Traffic SA roadworks, incidents, road closures and detours across South
  Australia. Incident-class events (incidents, collisions, flooding, emergency
  waterworks) and closures show by default; both roadworks kinds (24 h and
  long-term, about 1,400 today) sit behind row chips that show how many are
  hidden. Markers and ground-clamped lines are coloured by kind, and clicking
  one shows its road, direction, lanes closed, speed limit and Adelaide-time
  start and end. The row shows the feed's last-updated time.
  `/api/sa-road-events` reads Traffic SA's split services as three independent
  groups: roadworks from the maps.sa.gov.au MapServer (with its identical
  mirror as the only fallback), incidents and closures/detours from the geohub
  MapServer. The old closures layer has not updated since May 2026 and is never
  read. Each group pages past the 1,000-record cap, is replaced only when every
  page arrives, and keeps its own last-good snapshot, served as stale for up to
  six hours; a group with nothing trustworthy is reported as unavailable and
  the row says so rather than looking quiet. Data: Traffic SA, Department for
  Infrastructure and Transport, Government of South Australia (CC BY 4.0)
  (bennypixel, #1090).
