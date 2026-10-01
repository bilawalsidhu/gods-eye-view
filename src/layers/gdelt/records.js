const LOCATION_COORDS = {
  // United States & Cities
  'united states': [38.8951, -77.0364],
  us: [38.8951, -77.0364],
  usa: [38.8951, -77.0364],
  america: [38.8951, -77.0364],
  washington: [38.8951, -77.0364],
  'new york': [40.7128, -74.006],
  seattle: [47.6062, -122.3321],
  california: [36.7783, -119.4179],
  texas: [31.9686, -99.9018],
  florida: [27.6648, -81.5158],
  chicago: [41.8781, -87.6298],

  // United Kingdom
  'united kingdom': [51.5074, -0.1278],
  uk: [51.5074, -0.1278],
  britain: [51.5074, -0.1278],
  london: [51.5074, -0.1278],

  // Australia
  australia: [-33.8688, 151.2093],
  aussie: [-33.8688, 151.2093],
  sydney: [-33.8688, 151.2093],
  melbourne: [-37.8136, 144.9631],
  canberra: [-35.2809, 149.13],

  // Europe & Middle East
  ukraine: [50.4501, 30.5234],
  kyiv: [50.4501, 30.5234],
  russia: [55.7558, 37.6173],
  moscow: [55.7558, 37.6173],
  israel: [31.7683, 35.2137],
  jerusalem: [31.7683, 35.2137],
  gaza: [31.5017, 34.4668],
  lebanon: [33.8938, 35.5018],
  beirut: [33.8938, 35.5018],
  iran: [35.6892, 51.389],
  tehran: [35.6892, 51.389],
  france: [48.8566, 2.3522],
  paris: [48.8566, 2.3522],
  germany: [52.52, 13.405],
  berlin: [52.52, 13.405],
  poland: [52.2297, 21.0122],
  turkey: [39.9334, 32.8597],
  syria: [33.5138, 36.2765],
  yemen: [15.3694, 44.191],

  // Asia & Americas
  china: [39.9042, 116.4074],
  beijing: [39.9042, 116.4074],
  taiwan: [25.033, 121.5654],
  japan: [35.6762, 139.6503],
  tokyo: [35.6762, 139.6503],
  india: [28.6139, 77.209],
  delhi: [28.6139, 77.209],
  pakistan: [33.6844, 73.0479],
  canada: [45.4215, -75.6972],
  brazil: [-15.7975, -47.8919],
  philippines: [14.5995, 120.9842],
  'south korea': [37.5665, 126.978],
  seoul: [37.5665, 126.978],
  'north korea': [39.0392, 125.7625],
};

function extractLocationCoord(country, headline, domain) {
  const text =
    `${String(country || '')} ${String(headline || '')} ${String(domain || '')}`.toLowerCase();

  // 1. Check domain TLD hints
  if (domain) {
    const d = domain.toLowerCase();
    if (d.endsWith('.au')) return LOCATION_COORDS['australia'];
    if (d.endsWith('.uk')) return LOCATION_COORDS['united kingdom'];
    if (d.endsWith('.ca')) return LOCATION_COORDS['canada'];
    if (d.endsWith('.de')) return LOCATION_COORDS['germany'];
    if (d.endsWith('.jp')) return LOCATION_COORDS['japan'];
    if (d.endsWith('.fr')) return LOCATION_COORDS['france'];
    if (d.endsWith('.in')) return LOCATION_COORDS['india'];
  }

  // 2. Check keyword/city/country matches in text
  for (const [name, coords] of Object.entries(LOCATION_COORDS)) {
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    if (regex.test(text)) return coords;
  }

  // No identifiable location — do not guess!
  return null;
}

export function normalizeGdeltSnapshot(payload) {
  const rows = [];
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  if (!articles.length) return rows;

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const name = String(art.title || 'Unverified News Headline').trim();
    const domain = art.domain || 'Public Media';

    const coord = extractLocationCoord(art.sourcecountry, name, domain);

    // Skip headlines that have zero geographic evidence
    if (!coord) continue;

    // Radial jitter so multiple articles at the same location don't overlap completely
    const angle = (i * 137.5 * Math.PI) / 180;
    const radius = 0.4 + (i % 4) * 0.3;
    const lat = coord[0] + Math.sin(angle) * radius;
    const lon = coord[1] + Math.cos(angle) * radius;

    const url = art.url || '';
    const stableId = `gdelt-${i}-${domain.replace(/[^a-z0-9]/gi, '_')}`;

    rows.push({
      stableId,
      lat,
      lon,
      name,
      url,
      domain,
      verified: false,
      time: art.seendate || new Date().toISOString(),
    });
  }

  return rows;
}
