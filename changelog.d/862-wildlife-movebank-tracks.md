- Add a Wildlife layer (Movement group): keyless animal tracks from seven
  curated public Movebank studies (storks, gulls, spoonbills) whose published
  datasets are CC0. Each animal shows its latest GPS fix as a glyph pointing
  where it was heading, coloured by species, with a fading track of recent
  fixes; choosing one names species, study, owner, dataset licence and the time
  of its last fix. `/api/wildlife` reads the studies one at a time, caches them
  for an hour and fails closed on revocation: an empty answer twice, or a 401,
  403, 404 or 410 once, drops the study, and no copy older than six hours is
  served, or kept on the globe while the proxy is unreachable
  (leopechnicki, #862).
