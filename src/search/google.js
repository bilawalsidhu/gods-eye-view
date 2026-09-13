/** Normalize a Google forward-geocode result without leaking its address shape. */
export function normalizeGooglePlace(result) {
  const lat = result?.geometry?.location?.lat;
  const lng = result?.geometry?.location?.lng;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    return null;
  const types = Array.isArray(result.types) ? result.types : [];
  const resultTypes = new Set(types.map((type) => String(type).toLowerCase()));
  const components = Array.isArray(result.address_components)
    ? result.address_components
    : [];
  // Address-only landmark results must retain the requested landmark identity.
  const canonical = components.find(
    (component) =>
      Array.isArray(component.types) &&
      component.types.some(
        (type) =>
          type !== 'political' && resultTypes.has(String(type).toLowerCase()),
      ),
  );
  return {
    lat,
    lng,
    name: canonical?.long_name || '',
    label: result.formatted_address || '',
    types,
    viewport: result.geometry.bounds || result.geometry.viewport || null,
  };
}

/** Construct Google geocoding with caller-owned transport and key selection. */
export function createGoogleGeocoder({ request }) {
  return {
    async geocode(query, { bias = null, signal } = {}) {
      signal?.throwIfAborted();
      try {
        const response = await request(query, { bias, signal });
        signal?.throwIfAborted();
        // An unconfigured provider did not contribute a negative verdict.
        if (!response) return { place: null, answered: true };
        if (response.ok === false) return { place: null, answered: false };
        const data = await response.json();
        signal?.throwIfAborted();
        if (
          data?.status === 'ZERO_RESULTS' &&
          Array.isArray(data.results) &&
          data.results.length === 0
        )
          return { place: null, answered: true };
        const place =
          data?.status === 'OK'
            ? normalizeGooglePlace(data.results?.[0])
            : null;
        return { place, answered: Boolean(place) };
      } catch {
        signal?.throwIfAborted();
        return { place: null, answered: false };
      }
    },
  };
}
