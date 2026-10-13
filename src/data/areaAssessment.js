/** Transparent preference scores, not wealth labels or safety certifications. */
export const AREA_METRICS = Object.freeze({
  air: { label: 'Air quality', color: '#5bd6cb' },
  housing: { label: 'Housing prices', color: '#e9ba73' },
  services: { label: 'Service access', color: '#7faaff' },
  seismic: { label: 'Seismic hazard', color: '#c6a0ef' },
});

export const SERVICE_CATEGORIES = Object.freeze({
  health: 'Health',
  education: 'Schools',
  food: 'Groceries',
  transit: 'Public transport',
});

export function finiteValue(value) {
  return value == null || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

export function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

/** Housing is a personal price preference against an editable budget in source units. */
export function areaMetricScore(id, observation, budget) {
  if (observation?.status !== 'available') return null;
  if (id === 'air') {
    const aqi = finiteValue(observation.aqi);
    return aqi == null || aqi < 0 ? null : clampScore(100 - aqi / 3);
  }
  if (id === 'housing') {
    const price = finiteValue(observation.value),
      ceiling = finiteValue(budget);
    return price == null || price <= 0 || ceiling == null || ceiling <= 0
      ? null
      : 100 * (ceiling / (ceiling + price));
  }
  if (id === 'seismic') {
    const pga = finiteValue(observation.pga);
    return pga == null || pga < 0 ? null : clampScore(100 * (1 - pga / 0.6));
  }
  if (id === 'services') {
    const distances = Object.keys(SERVICE_CATEGORIES).map((key) =>
      finiteValue(observation.nearest?.[key]?.distanceM),
    );
    // Missing mapped categories are unknown, never evidence of a bad neighborhood.
    if (
      distances.some((d) => d == null || d < 0) ||
      observation.complete === false
    )
      return null;
    return (
      distances.reduce((sum, d) => sum + clampScore(100 * (1 - d / 3000)), 0) /
      distances.length
    );
  }
  return null;
}

/** Conservative selected-weight mean: missing observations contribute zero, with coverage reported separately. */
export function weightedAreaIndex(observations, selection, budgets = {}) {
  let numerator = 0,
    availableWeight = 0,
    selectedWeight = 0;
  const used = [],
    missing = [];
  for (const id of Object.keys(AREA_METRICS)) {
    const choice = selection[id];
    const weight = finiteValue(choice?.weight);
    if (!choice?.selected || weight == null || weight <= 0) continue;
    selectedWeight += weight;
    const score = areaMetricScore(
      id,
      observations[id],
      budgets[observations[id]?.unit],
    );
    if (score == null) {
      missing.push(id);
      continue;
    }
    numerator += score * weight;
    availableWeight += weight;
    used.push({ id, score, weight });
  }
  return {
    score: selectedWeight ? numerator / selectedWeight : null,
    coverage: selectedWeight ? availableWeight / selectedWeight : 0,
    used,
    missing,
    selectedWeight,
  };
}

/** Great-circle distance to mapped POIs; this is not a routed walking time. */
export function pointDistanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad,
    dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** Keep each nearest category and a bounded list for the map. */
export function summarizeServices(elements, point) {
  const nearest = {},
    pois = [],
    seen = new Set();
  for (const element of elements) {
    const lat = finiteValue(element.lat ?? element.center?.lat),
      lon = finiteValue(element.lon ?? element.center?.lon);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      continue;
    const tags = element.tags || {};
    const category = ['hospital', 'clinic', 'doctors', 'pharmacy'].includes(
      tags.amenity,
    )
      ? 'health'
      : ['school', 'kindergarten', 'college', 'university'].includes(
            tags.amenity,
          )
        ? 'education'
        : ['supermarket', 'convenience', 'greengrocer'].includes(tags.shop)
          ? 'food'
          : tags.highway === 'bus_stop' ||
              ['station', 'halt', 'tram_stop'].includes(tags.railway) ||
              tags.public_transport === 'platform'
            ? 'transit'
            : null;
    if (!category) continue;
    const key = `${element.type}/${element.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const poi = {
      lat,
      lon,
      category,
      name: String(tags.name || SERVICE_CATEGORIES[category]).slice(0, 120),
      distanceM: pointDistanceM(point, { lat, lon }),
    };
    if (poi.distanceM > 3000) continue;
    if (!nearest[category] || poi.distanceM < nearest[category].distanceM)
      nearest[category] = poi;
    pois.push(poi);
  }
  pois.sort((a, b) => a.distanceM - b.distanceM);
  return { nearest, pois: pois.slice(0, 250), mappedCount: pois.length };
}

/** Shared result palette: low red, medium amber, high green; unavailable gray. */
export function areaScoreColor(value) {
  const score = finiteValue(value);
  if (score == null) return '#94a3b8';
  const palette = [
    [248, 113, 113],
    [250, 204, 21],
    [74, 222, 128],
  ];
  const position = clampScore(score) / 50;
  const segment = Math.min(1, Math.floor(position)),
    fraction = position - segment;
  return (
    '#' +
    palette[segment]
      .map((v, i) =>
        Math.round(v + (palette[segment + 1][i] - v) * fraction)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Nine bounded samples: chosen point, four close and four outer candidates. */
export function nearbyAreaPoints(origin, radiusM) {
  const points = [{ ...origin }],
    rad = Math.PI / 180;
  for (const [distance, offset] of [
    [radiusM / 3, 0],
    [radiusM, 45],
  ]) {
    for (let bearing = offset; bearing < offset + 360; bearing += 90) {
      const angle = bearing * rad,
        delta = distance / 6371008.8;
      const lat1 = origin.lat * rad,
        lon1 = origin.lon * rad;
      const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(delta) +
          Math.cos(lat1) * Math.sin(delta) * Math.cos(angle),
      );
      const lon2 =
        lon1 +
        Math.atan2(
          Math.sin(angle) * Math.sin(delta) * Math.cos(lat1),
          Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
        );
      points.push({ lat: lat2 / rad, lon: ((lon2 / rad + 540) % 360) - 180 });
    }
  }
  return points;
}

/** Reuse observed POIs, measuring from each candidate rather than from the chosen origin. */
export function servicesAtCandidate(observation, point) {
  if (observation?.status !== 'available') return observation;
  const nearest = {};
  for (const poi of observation.pois || []) {
    const distanceM = pointDistanceM(point, poi);
    if (
      distanceM <= 3000 &&
      (!nearest[poi.category] || distanceM < nearest[poi.category].distanceM)
    )
      nearest[poi.category] = { ...poi, distanceM };
  }
  return {
    ...observation,
    nearest,
    pois: [],
    sample: true,
    resolution:
      'Nearest observed POIs within 3 km of this candidate, from a shared search sample',
    warning:
      'Nearby comparison reuses a bounded POI sample around the chosen point. It is not exhaustive; unmapped categories remain unscored. Distances are measured from each candidate.',
  };
}

/** Only compare equal/full selected coverage; prefer nearest within the explicit score tolerance. */
export function rankNearbyAreas(
  candidates,
  origin,
  selection,
  budgets,
  tolerance = 2,
) {
  const eligible = candidates
    .map((candidate) => ({
      ...candidate,
      index: weightedAreaIndex(candidate.observations, selection, budgets),
      distanceM: pointDistanceM(origin, candidate.point),
    }))
    .filter(
      (candidate) =>
        candidate.index.score != null && candidate.index.coverage === 1,
    );
  if (!eligible.length) return { best: null, eligible: [], topScore: null };
  const topScore = Math.max(
    ...eligible.map((candidate) => candidate.index.score),
  );
  const nearBest = eligible.filter(
    (candidate) => candidate.index.score >= topScore - Math.max(0, tolerance),
  );
  nearBest.sort((a, b) =>
    Math.abs(a.distanceM - b.distanceM) > 1
      ? a.distanceM - b.distanceM
      : b.index.score - a.index.score,
  );
  return { best: nearBest[0], eligible, topScore };
}
