/** Fixed upstream request URLs; callers own validation, credentials and transport. */
export function celestrakTleUrl(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');
  return url;
}

export function launchLibraryRecentUrl(end) {
  const start = new Date(end.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  return url;
}

export function cneosFireballsUrl(options = {}) {
  const url = new URL('https://ssd-api.jpl.nasa.gov/fireball.api');
  url.searchParams.set('req-loc', 'true');
  if (options.dateMin)
    url.searchParams.set('date-min', String(options.dateMin));
  if (options.dateMax)
    url.searchParams.set('date-max', String(options.dateMax));
  if (options.energyMin != null)
    url.searchParams.set('energy-min', String(options.energyMin));
  if (options.velMin != null)
    url.searchParams.set('vel-min', String(options.velMin));
  if (options.limit != null)
    url.searchParams.set('limit', String(options.limit));
  if (options.sort) url.searchParams.set('sort', String(options.sort));
  return url;
}
