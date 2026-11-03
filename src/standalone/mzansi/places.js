// Small, manually curated reference set. These are map anchors, not live feeds,
// service availability or a comprehensive directory. Coordinates are approximate.
export const DURBAN = Object.freeze({ longitude: 31.0218, latitude: -29.8587 });
export const PLACES = Object.freeze(
  [
    {
      id: 'durban-icc',
      name: 'Durban ICC',
      category: 'Venues',
      latitude: -29.8527608,
      longitude: 31.0298468,
      description: 'International convention centre on Bram Fischer Road.',
      source: 'Durban ICC · Maps & Directions',
      sourceUrl: 'https://icc.co.za/contact/map/',
      reviewed: '2026-11-03',
    },
    {
      id: 'durban-exhibition-centre',
      name: 'Durban Exhibition Centre',
      category: 'Venues',
      latitude: -29.854005,
      longitude: 31.027972,
      description: 'Exhibition venue on Walnut Road in central Durban.',
      source: 'Durban ICC · Maps & Directions',
      sourceUrl: 'https://icc.co.za/contact/map/',
      reviewed: '2026-11-03',
    },
    {
      id: 'king-shaka',
      name: 'King Shaka International Airport',
      category: 'Transport',
      latitude: -29.61,
      longitude: 31.116944,
      description:
        'Airport map anchor north of Durban. Check the operator for travel information.',
      source: 'King Shaka airport guide · Map & GPS',
      sourceUrl: 'https://kingshakainternational.co.za/contact-us/map-gps/',
      reviewed: '2026-11-03',
    },
  ].map(Object.freeze),
);

export function distanceKm(a, b) {
  const rad = (n) => (n * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function findPlaces({
  query = '',
  category = 'All',
  centre = DURBAN,
  radius = 50,
  savedOnly = false,
  saved = [],
} = {}) {
  const q = query.trim().toLowerCase();
  return PLACES.map((place) => ({
    ...place,
    distance: distanceKm(centre, place),
  }))
    .filter(
      (place) =>
        (!q ||
          `${place.name} ${place.description}`.toLowerCase().includes(q)) &&
        (category === 'All' || place.category === category) &&
        (!savedOnly || saved.includes(place.id)) &&
        place.distance <= radius,
    )
    .sort((a, b) => a.distance - b.distance);
}

export const SAVED_KEY = 'mzansiview:saved-places:v1';
export function readSaved(storage) {
  try {
    const value = JSON.parse(storage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(value)
      ? [...new Set(value.filter((id) => PLACES.some((p) => p.id === id)))]
      : [];
  } catch {
    return [];
  }
}
export function writeSaved(storage, ids) {
  try {
    storage.setItem(SAVED_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}
