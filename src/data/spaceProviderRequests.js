/** Fixed upstream request URLs; callers own validation, credentials and transport. */
export function celestrakTleUrl(group) {
  // Self-contained on purpose: src/proxyErrorResponses.test.mjs evaluates this
  // function in isolation, so it cannot lean on module-level constants.
  // Internal groups CelesTrak has no GROUP for are fetched by satellite name.
  const nameQueries = { iceye: 'ICEYE' };
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  if (Object.hasOwn(nameQueries, group))
    url.searchParams.set('NAME', nameQueries[group]);
  else url.searchParams.set('GROUP', group);
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
