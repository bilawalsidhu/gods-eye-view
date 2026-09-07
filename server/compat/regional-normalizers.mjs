function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeRegionalPlace(payload) {
  const address = payload?.address && typeof payload.address === 'object' ? payload.address : {};
  const locality = address.city || address.town || address.village || address.municipality || address.county || null;
  const region = address.state || address.region || null;
  const country = address.country || null;
  if (!locality && !region && !country && !payload?.display_name) return null;
  return {
    displayName: payload.display_name || [locality, region, country].filter(Boolean).join(', '),
    locality,
    region,
    country,
    countryCode: String(address.country_code || '').toUpperCase() || null,
  };
}

export function normalizeRegionalWeather(payload) {
  const current = payload?.current;
  if (!current || typeof current !== 'object') return null;
  const weatherCode = finite(current.weather_code);
  if (weatherCode === null) return null;
  return {
    observedAt: current.time || null,
    temperatureC: finite(current.temperature_2m),
    apparentTemperatureC: finite(current.apparent_temperature),
    precipitationMm: finite(current.precipitation),
    weatherCode,
    cloudCoverPct: finite(current.cloud_cover),
    windSpeedKmh: finite(current.wind_speed_10m),
    windDirectionDeg: finite(current.wind_direction_10m),
    visibilityM: finite(current.visibility),
  };
}

export function normalizeRegionalArticles(payload, limit = 5) {
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  const seen = new Set();
  const articles = [];
  for (const row of rows) {
    const title = String(row?.title || '').trim();
    let url;
    try {
      url = new URL(String(row?.url || ''));
    } catch {
      continue;
    }
    if (!title || !['http:', 'https:'].includes(url.protocol)) continue;
    const signature = `${title.toLowerCase()}|${url.hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const parsedDate = Date.parse(row?.seendate || row?.publishedAt || '');
    articles.push({
      title,
      url: url.href,
      domain: row?.domain || url.hostname.replace(/^www\./, ''),
      publishedAt: Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString(),
      sourceCountry: row?.sourcecountry || null,
    });
    if (articles.length >= limit) break;
  }
  return articles;
}
