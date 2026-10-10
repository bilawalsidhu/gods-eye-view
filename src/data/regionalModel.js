const MAX_ARTICLES = 5;

function cleanText(value, maxLength = 180) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** Normalize a Nominatim reverse-geocode response into cockpit-sized place context. */
export function normalizeRegionalPlace(payload) {
  const address = payload?.address || {};
  const locality = cleanText(
    address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.hamlet ||
      address.county,
    90,
  );
  const region = cleanText(
    address.state || address.region || address.county,
    90,
  );
  const country = cleanText(address.country, 90);
  const label =
    [locality, region]
      .filter(
        (value, index, values) => value && values.indexOf(value) === index,
      )
      .join(', ') ||
    country ||
    cleanText(payload?.display_name, 120);
  if (!label) return null;
  return {
    label,
    locality: locality || null,
    region: region || null,
    country: country || null,
    countryCode: cleanText(address.country_code, 4).toUpperCase() || null,
  };
}

/** Normalize and deduplicate GDELT ArticleList output without trusting article HTML. */
export function normalizeRegionalArticles(payload, limit = MAX_ARTICLES) {
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  const seen = new Set();
  const articles = [];
  for (const row of rows) {
    const url = safeHttpUrl(row?.url || row?.url_mobile);
    const title = cleanText(row?.title, 180);
    if (!url || !title) continue;
    const signature = `${title.toLowerCase()}|${new URL(url).hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const rawDate = cleanText(row?.seendate, 32);
    const compactDate = /^(\d{8})T(\d{6})Z$/.exec(rawDate);
    const publishedAt = compactDate
      ? `${compactDate[1].slice(0, 4)}-${compactDate[1].slice(4, 6)}-${compactDate[1].slice(6, 8)}T${compactDate[2].slice(0, 2)}:${compactDate[2].slice(2, 4)}:${compactDate[2].slice(4, 6)}Z`
      : Number.isNaN(Date.parse(rawDate))
        ? null
        : new Date(rawDate).toISOString();
    articles.push({
      title,
      url,
      domain: cleanText(
        row?.domain || new URL(url).hostname.replace(/^www\./, ''),
        80,
      ),
      publishedAt,
      sourceCountry: cleanText(row?.sourcecountry, 60) || null,
    });
    if (articles.length >= Math.max(1, Math.min(MAX_ARTICLES, limit))) break;
  }
  return articles;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/** Normalize Open-Meteo current conditions into a small source-stamped record. */
export function normalizeRegionalWeather(payload) {
  const current = payload?.current;
  if (!current || !Number.isFinite(Number(current.temperature_2m))) return null;
  // Open-Meteo reports zone-naive timestamps ("2026-08-17T00:15") that are UTC,
  // but JS parses zoneless date-times as LOCAL — pin them to UTC explicitly.
  const observedRaw =
    typeof current.time === 'string' &&
    !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(current.time)
      ? `${current.time}Z`
      : current.time;
  return {
    observedAt: Number.isNaN(Date.parse(observedRaw))
      ? null
      : new Date(observedRaw).toISOString(),
    temperatureC: numberOrNull(current.temperature_2m),
    apparentTemperatureC: numberOrNull(current.apparent_temperature),
    precipitationMm: numberOrNull(current.precipitation),
    cloudCoverPct: numberOrNull(current.cloud_cover),
    windKph: numberOrNull(current.wind_speed_10m),
    windDirectionDeg: numberOrNull(current.wind_direction_10m),
    visibilityM: numberOrNull(current.visibility),
    weatherCode: numberOrNull(current.weather_code),
    source: 'open-meteo',
  };
}

/**
 * Approximate SAR footprint for preferring Hong Kong Observatory current
 * weather over the global Open-Meteo default in cockpit Local Info.
 */
export function isNearHongKong(point) {
  const lat = Number(point?.latitude);
  const lon = Number(point?.longitude);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 22.12 &&
    lat <= 22.58 &&
    lon >= 113.82 &&
    lon <= 114.45
  );
}

/** Map HKO weather icon numbers to WMO codes so cockpit labels stay shared. */
export function hkoIconToWmo(icon) {
  const code = Number(icon);
  if (!Number.isFinite(code)) return null;
  if (code === 50 || (code >= 70 && code <= 75) || code === 77) return 0;
  if (code === 51 || code === 52) return 2;
  if (code === 53 || code === 54) return 80;
  if (code === 60 || code === 76) return 3;
  if (code === 61) return 3;
  if (code === 62) return 61;
  if (code === 63) return 63;
  if (code === 64) return 65;
  if (code === 65) return 95;
  if (code === 83 || code === 84) return 45;
  if (code === 80) return 0;
  return null;
}

/** Named HKO temperature stations used to pick the reading nearest the aircraft. */
const HKO_TEMP_STATIONS = [
  { place: "King's Park", lat: 22.3119, lon: 114.1728 },
  { place: 'Hong Kong Observatory', lat: 22.302, lon: 114.1743 },
  { place: 'Wong Chuk Hang', lat: 22.2478, lon: 114.1736 },
  { place: 'Ta Kwu Ling', lat: 22.5286, lon: 114.1567 },
  { place: 'Lau Fau Shan', lat: 22.4689, lon: 113.9836 },
  { place: 'Tai Po', lat: 22.4497, lon: 114.1689 },
  { place: 'Sha Tin', lat: 22.4025, lon: 114.2069 },
  { place: 'Tuen Mun', lat: 22.3911, lon: 113.9769 },
  { place: 'Tseung Kwan O', lat: 22.3157, lon: 114.2594 },
  { place: 'Sai Kung', lat: 22.3817, lon: 114.2719 },
  { place: 'Cheung Chau', lat: 22.2011, lon: 114.0267 },
  { place: 'Chek Lap Kok', lat: 22.3094, lon: 113.9219 },
  { place: 'Tsing Yi', lat: 22.3442, lon: 114.11 },
  { place: 'Shek Kong', lat: 22.4364, lon: 114.0847 },
  { place: 'Tsuen Wan Ho Koon', lat: 22.3836, lon: 114.1078 },
  { place: 'Tsuen Wan Shing Mun Valley', lat: 22.3758, lon: 114.1264 },
  { place: 'Hong Kong Park', lat: 22.2775, lon: 114.1619 },
  { place: 'Shau Kei Wan', lat: 22.2819, lon: 114.2289 },
  { place: 'Kowloon City', lat: 22.3322, lon: 114.1911 },
  { place: 'Happy Valley', lat: 22.2706, lon: 114.1836 },
  { place: 'Wong Tai Sin', lat: 22.3394, lon: 114.1942 },
  { place: 'Stanley', lat: 22.2183, lon: 114.2133 },
  { place: 'Kwun Tong', lat: 22.3186, lon: 114.2261 },
  { place: 'Sham Shui Po', lat: 22.33, lon: 114.1569 },
  { place: 'Kai Tak Runway Park', lat: 22.3047, lon: 114.2169 },
  { place: 'Yuen Long Park', lat: 22.4456, lon: 114.0186 },
  { place: 'Tai Mei Tuk', lat: 22.4753, lon: 114.2375 },
];

/** District rainfall places from the HKO current-weather report. */
const HKO_RAINFALL_DISTRICTS = [
  { place: 'Central & Western District', lat: 22.2819, lon: 114.158 },
  { place: 'Eastern District', lat: 22.2842, lon: 114.2242 },
  { place: 'Kwai Tsing', lat: 22.3549, lon: 114.126 },
  { place: 'Islands District', lat: 22.2611, lon: 113.9461 },
  { place: 'North District', lat: 22.4947, lon: 114.1381 },
  { place: 'Sai Kung', lat: 22.3817, lon: 114.2719 },
  { place: 'Sha Tin', lat: 22.3827, lon: 114.19 },
  { place: 'Southern District', lat: 22.2475, lon: 114.1589 },
  { place: 'Tai Po', lat: 22.4503, lon: 114.1688 },
  { place: 'Tsuen Wan', lat: 22.3701, lon: 114.114 },
  { place: 'Tuen Mun', lat: 22.391, lon: 113.977 },
  { place: 'Wan Chai', lat: 22.276, lon: 114.172 },
  { place: 'Yuen Long', lat: 22.4445, lon: 114.022 },
  { place: 'Yau Tsim Mong', lat: 22.2976, lon: 114.1722 },
  { place: 'Sham Shui Po', lat: 22.33, lon: 114.1569 },
  { place: 'Kowloon City', lat: 22.3322, lon: 114.1911 },
  { place: 'Wong Tai Sin', lat: 22.3394, lon: 114.1942 },
  { place: 'Kwun Tong', lat: 22.3186, lon: 114.2261 },
];

function nearestNamedReading(rows, stations, point) {
  const byPlace = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const place = String(row?.place || '').trim();
    const value = Number(row?.value ?? row?.max);
    if (!place || !Number.isFinite(value)) continue;
    byPlace.set(place, value);
  }
  if (!byPlace.size) return null;
  let best = null;
  for (const station of stations) {
    const value = byPlace.get(station.place);
    if (!Number.isFinite(value)) continue;
    const distanceM = regionalDistanceM(point, {
      latitude: station.lat,
      longitude: station.lon,
    });
    if (!best || distanceM < best.distanceM) {
      best = { value, distanceM, place: station.place };
    }
  }
  if (best) return best.value;
  return byPlace.values().next().value;
}

/**
 * Normalize an HKO `rhrread` current-weather payload into the shared cockpit
 * weather shape. Wind, cloud cover and visibility are not in this endpoint and
 * stay null; cockpit atmospheric effects keep using Open-Meteo separately.
 */
export function normalizeHkoWeather(payload, point) {
  const temperatureC = nearestNamedReading(
    payload?.temperature?.data,
    HKO_TEMP_STATIONS,
    point,
  );
  if (!Number.isFinite(temperatureC)) return null;
  const precipitationMm = nearestNamedReading(
    payload?.rainfall?.data,
    HKO_RAINFALL_DISTRICTS,
    point,
  );
  const icon = Array.isArray(payload?.icon) ? payload.icon[0] : payload?.icon;
  const observedRaw =
    payload?.temperature?.recordTime ||
    payload?.updateTime ||
    payload?.iconUpdateTime;
  return {
    observedAt: Number.isNaN(Date.parse(observedRaw))
      ? null
      : new Date(observedRaw).toISOString(),
    temperatureC,
    apparentTemperatureC: null,
    precipitationMm: Number.isFinite(precipitationMm) ? precipitationMm : null,
    cloudCoverPct: null,
    windKph: null,
    windDirectionDeg: null,
    visibilityM: null,
    weatherCode: hkoIconToWmo(icon),
    source: 'hko',
  };
}

/** Translate the WMO weather code used by Open-Meteo into concise cockpit copy. */
export function weatherCodeLabel(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return 'CONDITIONS UNKNOWN';
  if (value === 0) return 'CLEAR';
  if ([1, 2].includes(value)) return 'PARTLY CLOUDY';
  if (value === 3) return 'OVERCAST';
  if ([45, 48].includes(value)) return 'FOG';
  if (value >= 51 && value <= 57) return 'DRIZZLE';
  if (value >= 61 && value <= 67) return 'RAIN';
  if (value >= 71 && value <= 77) return 'SNOW';
  if (value >= 80 && value <= 82) return 'RAIN SHOWERS';
  if (value >= 85 && value <= 86) return 'SNOW SHOWERS';
  if (value >= 95) return 'THUNDERSTORM';
  return 'MIXED CONDITIONS';
}

/** Great-circle distance used to avoid refetching a regional brief every animation frame. */
export function regionalDistanceM(from, to) {
  if (
    ![from?.latitude, from?.longitude, to?.latitude, to?.longitude].every(
      Number.isFinite,
    )
  ) {
    return Infinity;
  }
  const phi1 = (from.latitude * Math.PI) / 180;
  const phi2 = (to.latitude * Math.PI) / 180;
  const deltaPhi = ((to.latitude - from.latitude) * Math.PI) / 180;
  const deltaLambda = ((to.longitude - from.longitude) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
