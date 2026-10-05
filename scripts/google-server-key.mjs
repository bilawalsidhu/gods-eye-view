/** Resolve server credentials after applying environment overrides per key. */
export function resolveGoogleServerKey(environment = {}, defaults = {}) {
  const value = (name) => String(environment[name] ?? defaults[name] ?? '').trim();
  return value('GOOGLE_MAPS_SERVER_API_KEY') || value('GOOGLE_MAPS_API_KEY');
}
