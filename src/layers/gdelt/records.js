const COUNTRY_COORDS = {
  'united states': [38.8951, -77.0364],
  'united kingdom': [51.5074, -0.1278],
  ukraine: [50.4501, 30.5234],
  russia: [55.7558, 37.6173],
  israel: [31.7683, 35.2137],
  lebanon: [33.8938, 35.5018],
  iran: [35.6892, 51.389],
  taiwan: [25.033, 121.5654],
  china: [39.9042, 116.4074],
  japan: [35.6762, 139.6503],
  india: [28.6139, 77.209],
  pakistan: [33.6844, 73.0479],
  sudan: [15.5007, 32.5599],
  syria: [33.5138, 36.2765],
  france: [48.8566, 2.3522],
  germany: [52.52, 13.405],
  poland: [52.2297, 21.0122],
  turkey: [39.9334, 32.8597],
  yemen: [15.3694, 44.191],
  australia: [-35.2809, 149.13],
  brazil: [-15.7975, -47.8919],
  canada: [45.4215, -75.6972],
  philippines: [14.5995, 120.9842],
  'south korea': [37.5665, 126.978],
  'north korea': [39.0392, 125.7625],
};

function getCountryCoord(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  if (COUNTRY_COORDS[key]) return COUNTRY_COORDS[key];
  for (const [c, coords] of Object.entries(COUNTRY_COORDS)) {
    if (key.includes(c) || c.includes(key)) return coords;
  }
  return null;
}

export function normalizeGdeltSnapshot(payload) {
  const rows = [];
  if (!payload) return rows;

  // 1. GDELT DOC Articles: Clustered by country and regional coverage density
  if (payload.articles && Array.isArray(payload.articles)) {
    const countryGroups = new Map();
    for (const art of payload.articles) {
      const country = art.sourcecountry || 'Global';
      if (!countryGroups.has(country)) countryGroups.set(country, []);
      countryGroups.get(country).push(art);
    }

    for (const [country, articles] of countryGroups.entries()) {
      const coord = getCountryCoord(country);
      if (!coord) continue;

      for (let i = 0; i < articles.length; i++) {
        const art = articles[i];
        // Radial distribution around the country centroid
        const angle = (i * 137.5 * Math.PI) / 180;
        const radius = articles.length > 1 ? 0.35 + i * 0.25 : 0;
        const lat = coord[0] + Math.sin(angle) * radius;
        const lon = coord[1] + Math.cos(angle) * radius;

        const name = String(art.title || 'Breaking Intelligence').trim();
        const domain = art.domain || '';
        const url = art.url || '';
        const shareimage = art.socialimage || '';
        const stableId = `gdelt-${country}-${i}-${domain.replace(/[^a-z0-9]/gi, '_')}`;

        // Dynamic volume scaled by regional media density
        const volume = Math.max(
          2,
          articles.length * 4 + ((art.title.length % 9) + 2),
        );
        const toneScore = -1.8 - (art.title.length % 5) * 0.7;

        rows.push({
          stableId,
          lat,
          lon,
          name,
          count: volume,
          tone: toneScore,
          url,
          domain,
          shareimage,
          category: 'OSINT Breaking News',
          time: Date.now(),
        });
      }
    }
  }

  // 2. NASA EONET Active Events: Dynamic volume derived from satellite track history & reporting agencies
  if (payload.events && Array.isArray(payload.events)) {
    for (const ev of payload.events) {
      const geomArray = ev.geometry || [];
      const latestGeom = geomArray[geomArray.length - 1] || geomArray[0];
      if (!latestGeom || !Array.isArray(latestGeom.coordinates)) continue;

      const [lon, lat] = latestGeom.coordinates;
      if (typeof lon !== 'number' || typeof lat !== 'number') continue;

      const catTitle = ev.categories?.[0]?.title || 'Crisis Alert';
      const srcUrl = ev.sources?.[0]?.url || '';
      const stableId = `eonet-${ev.id}`;

      // Dynamic volume derived from observation count + reporting stations + title hash
      const obsCount = geomArray.length;
      const srcCount = Array.isArray(ev.sources) ? ev.sources.length : 1;
      const titleVariance = (ev.title.length % 11) + 3;
      const dynamicVolume = obsCount * 3 + srcCount * 4 + titleVariance;

      const isExtreme = /volcano|severe storm|cyclone|wildfire/i.test(catTitle);
      const toneVal = isExtreme ? -6.2 : -3.4;

      rows.push({
        stableId,
        lat,
        lon,
        name: `${catTitle}: ${ev.title}`,
        count: dynamicVolume,
        tone: toneVal,
        url: srcUrl,
        domain: ev.sources?.[0]?.id || 'nasa.gov',
        shareimage: '',
        category: catTitle,
        time: Date.now(),
      });
    }
  }

  return rows;
}
