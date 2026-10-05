function placeContextPriority(types) {
  const typeSet = new Set(types);
  if (typeSet.has('historical_landmark') || typeSet.has('monument')) return 100;
  if (typeSet.has('tourist_attraction') || typeSet.has('museum')) return 90;
  if (typeSet.has('premise') || typeSet.has('street_address')) return 75;
  if (typeSet.has('point_of_interest')) return 60;
  if (typeSet.has('public_bathroom')) return 10;
  return 40;
}

function approximateDistanceM(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every(Number.isFinite))
    return Number.MAX_SAFE_INTEGER;
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos((latA * Math.PI) / 180);
  return Math.round(
    Math.hypot((latB - latA) * latitudeScale, (lonB - lonA) * longitudeScale),
  );
}

export function projectNearbyPlaces(data, latitude, longitude) {
  const seenPlaces = new Set();
  const places = Array.isArray(data.places)
    ? data.places
        .map((place) => {
          const placeLatitude = place.location?.latitude ?? null;
          const placeLongitude = place.location?.longitude ?? null;
          const types = Array.isArray(place.types)
            ? place.types.slice(0, 8)
            : [];
          return {
            id: place.id || null,
            name: place.displayName?.text || null,
            address:
              place.shortFormattedAddress || place.formattedAddress || null,
            latitude: placeLatitude,
            longitude: placeLongitude,
            distanceM: approximateDistanceM(
              latitude,
              longitude,
              placeLatitude,
              placeLongitude,
            ),
            primaryType:
              place.primaryTypeDisplayName?.text || place.primaryType || null,
            types,
            contextPriority: placeContextPriority(types),
          };
        })
        .filter((place) => {
          const key = `${place.name}:${place.address || ''}`.toLowerCase();
          if (!place.name || seenPlaces.has(key)) return false;
          seenPlaces.add(key);
          return true;
        })
        .sort(
          (a, b) =>
            b.contextPriority - a.contextPriority || a.distanceM - b.distanceM,
        )
        .map(({ contextPriority, ...place }) => place)
        .slice(0, 20)
    : [];
  return places;
}

export function projectTextSearchPlaces(data, latitude, longitude) {
  const places = Array.isArray(data.places)
    ? data.places
        .map((place) => {
          const placeLatitude = place.location?.latitude ?? null;
          const placeLongitude = place.location?.longitude ?? null;
          const types = Array.isArray(place.types)
            ? place.types.slice(0, 8)
            : [];
          // Places returns a lat/lng bounding box (low/high corners) framing the
          // place — no polygon, but enough to SIZE a fallback grounds disc to the
          // real feature instead of a blind constant. Normalize to plain numbers.
          const vp = place.viewport;
          const viewport =
            Number.isFinite(vp?.low?.latitude) &&
            Number.isFinite(vp?.low?.longitude) &&
            Number.isFinite(vp?.high?.latitude) &&
            Number.isFinite(vp?.high?.longitude)
              ? {
                  low: {
                    latitude: vp.low.latitude,
                    longitude: vp.low.longitude,
                  },
                  high: {
                    latitude: vp.high.latitude,
                    longitude: vp.high.longitude,
                  },
                }
              : null;
          return {
            id: place.id || null,
            name: place.displayName?.text || null,
            address: place.formattedAddress || null,
            latitude: placeLatitude,
            longitude: placeLongitude,
            distanceM: approximateDistanceM(
              latitude,
              longitude,
              placeLatitude,
              placeLongitude,
            ),
            primaryType: place.primaryType || null,
            types,
            viewport,
          };
        })
        .filter((place) => place.name)
    : [];
  return places;
}

export function normalizeRouteProfile(raw) {
  return raw === 'car' || raw === 'driving'
    ? 'car'
    : raw === 'bike' || raw === 'cycling' || raw === 'bicycle'
      ? 'bike'
      : raw === 'foot' || raw === 'walking' || raw === 'walk'
        ? 'foot'
        : null;
}

export function projectRouteResult(route, profile) {
  return {
    ok: true,
    profile,
    distanceM: Math.round(route.distance),
    durationS: Math.round(route.duration),
    geometry: route.geometry.coordinates,
  };
}
