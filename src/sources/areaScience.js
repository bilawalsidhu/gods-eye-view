import { resolveArea } from '../tools/area.js';

export const SOIL_SOURCE = 'https://www.isric.org/explore/soilgrids';
export const HISTORY_SOURCE =
  'https://www.usgs.gov/landsat-missions/landsat-collection-2';
export const SOIL_DEPTHS = Object.freeze([
  '0-5cm',
  '5-15cm',
  '15-30cm',
  '30-60cm',
  '60-100cm',
  '100-200cm',
]);
const PC = 'https://planetarycomputer.microsoft.com';
function scope(area) {
  if (
    !area ||
    !Number.isFinite(area.lat) ||
    Math.abs(area.lat) > 85 ||
    !Number.isFinite(area.lon) ||
    Math.abs(area.lon) > 180 ||
    !Number.isFinite(area.radius_km) ||
    area.radius_km < 0.1 ||
    area.radius_km > 100
  )
    throw new TypeError(
      'Scientific queries require Earth coordinates within ±85° and a 0.1–100 km radius.',
    );
  return { lat: area.lat, lon: area.lon, radius_km: area.radius_km };
}
async function readResponse(fetchImpl, url, signal, type = 'json') {
  const response = await fetchImpl(url, {
    signal: AbortSignal.any(
      [signal, AbortSignal.timeout(20000)].filter(Boolean),
    ),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('SOURCE_UNAVAILABLE');
  const text = await response.text();
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
    throw new Error('SOURCE_TOO_LARGE');
  signal?.throwIfAborted();
  return type === 'text' ? text : JSON.parse(text);
}
/** A model's g/kg fine-earth texture is a mass percentage, not mineral chemistry. */
export function soilPercentage(value) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1000
  )
    return null;
  return Math.round(value) / 10;
}
export function soilPointUrl(area, property, depth, statistic) {
  const point = scope(area);
  if (
    !['sand', 'silt', 'clay'].includes(property) ||
    !SOIL_DEPTHS.includes(depth) ||
    !['mean', 'Q0.05', 'Q0.95'].includes(statistic)
  )
    throw new TypeError('Unsupported soil property/depth/statistic.');
  const x = (6378137 * point.lon * Math.PI) / 180;
  const y =
    6378137 * Math.log(Math.tan(Math.PI / 4 + (point.lat * Math.PI) / 360));
  const layer = `${property}_${depth}_${statistic}`;
  const url = new URL('https://maps.isric.org/mapserv');
  for (const [key, value] of Object.entries({
    map: `/map/${property}.map`,
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetFeatureInfo',
    STYLES: '',
    FORMAT: 'image/png',
    LAYERS: layer,
    QUERY_LAYERS: layer,
    CRS: 'EPSG:3857',
    BBOX: [x - 100, y - 100, x + 100, y + 100].join(','),
    WIDTH: '101',
    HEIGHT: '101',
    I: '50',
    J: '50',
    INFO_FORMAT: 'application/geo+json',
  }))
    url.searchParams.set(key, value);
  return url.href;
}
/** Fetch one center cell, with independent 5th/95th prediction quantiles per fraction. */
export function createAreaScienceSource({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
} = {}) {
  let nextSoilAt = 0;
  return {
    async soil(area, { depth = '0-5cm', signal } = {}) {
      const point = scope(area);
      if (!SOIL_DEPTHS.includes(depth))
        throw new TypeError('Unsupported depth.');
      const retrievedAtMs = now();
      if (retrievedAtMs < nextSoilAt) throw new Error('SOIL_COOLDOWN');
      nextSoilAt = retrievedAtMs + 60000;
      const rows = [];
      for (const property of ['sand', 'silt', 'clay']) {
        const values = {};
        for (const statistic of ['mean', 'Q0.05', 'Q0.95']) {
          signal?.throwIfAborted();
          try {
            const result = await readResponse(
              fetchImpl,
              soilPointUrl(point, property, depth, statistic),
              signal,
            );
            const feature = result.features?.[0];
            values[statistic] =
              feature?.properties?.unit === 'g/kg'
                ? soilPercentage(feature.properties.pixel_value)
                : null;
          } catch {
            signal?.throwIfAborted();
            values[statistic] = null;
          }
        }
        rows.push({
          fraction: property,
          mean_percent: values.mean,
          lower_percent: values['Q0.05'],
          upper_percent: values['Q0.95'],
        });
      }
      const available = rows.some((row) => row.mean_percent !== null);
      const sum = rows.every((row) => row.mean_percent !== null)
        ? Math.round(
            rows.reduce((total, row) => total + row.mean_percent, 0) * 10,
          ) / 10
        : null;
      return {
        sourceId: 'soil',
        source: 'ISRIC SoilGrids 2.0',
        sourceUrl: SOIL_SOURCE,
        area: point,
        retrievedAtMs,
        status: available ? 'available' : 'unavailable',
        coverage: `Modeled center cell, ~250 m; depth ${depth}. Not an area average, laboratory result or mineral analysis.`,
        observedAt: null,
        confidence: 'unassessed',
        depth,
        rows,
        sum_percent: sum,
        summary: available
          ? `Soil texture model at the area center (${depth}); sand/silt/clay percentages and 90% prediction intervals where available. Independent means are not forced to sum to 100%.`
          : 'Soil prediction unavailable at this point. No composition was inferred.',
        attribution: 'ISRIC – World Soil Information, SoilGrids 2.0, CC BY 4.0',
      };
    },
    async history(
      area,
      {
        startYear = 1990,
        endYear = new Date(now()).getUTCFullYear(),
        stepYears = 5,
        maxCloud = 30,
        signal,
        onProgress = () => {},
      } = {},
    ) {
      const point = scope(area);
      const currentYear = new Date(now()).getUTCFullYear();
      if (
        !Number.isInteger(startYear) ||
        !Number.isInteger(endYear) ||
        startYear < 1982 ||
        endYear > currentYear ||
        startYear > endYear ||
        !Number.isInteger(stepYears) ||
        stepYears < 1 ||
        stepYears > 10 ||
        !Number.isFinite(maxCloud) ||
        maxCloud < 0 ||
        maxCloud > 100
      )
        throw new TypeError(
          'Invalid historical range, cadence or cloud threshold.',
        );
      const years = [];
      for (let year = startYear; year <= endYear; year += stepYears)
        years.push(year);
      if (years.at(-1) !== endYear) years.push(endYear);
      if (years.length > 50)
        throw new TypeError('At most 50 frames per request.');
      const bounds = await resolveArea(point);
      if (bounds.west > bounds.east)
        throw new TypeError(
          'Historical crops crossing the antimeridian are not supported.',
        );
      const bbox = [bounds.west, bounds.south, bounds.east, bounds.north];
      const retrievedAtMs = now();
      const rows = [];
      for (const year of years) {
        signal?.throwIfAborted();
        const end =
          year === currentYear
            ? new Date(now()).toISOString()
            : `${year}-12-31T23:59:59Z`;
        const url = new URL(`${PC}/api/stac/v1/search`);
        for (const [key, value] of Object.entries({
          collections: 'landsat-c2-l2',
          bbox: bbox.join(','),
          datetime: `${year}-01-01T00:00:00Z/${end}`,
          limit: '20',
          sortby: 'eo:cloud_cover',
        }))
          url.searchParams.set(key, value);
        let row = {
          year,
          status: 'unavailable',
          id: null,
          observed_at: null,
          cloud_percent: null,
          platform: null,
        };
        try {
          const data = await readResponse(fetchImpl, url.href, signal);
          if (!Array.isArray(data.features))
            throw new Error('Malformed catalogue.');
          const item = data.features
            .filter(
              (item) =>
                validFrameId(item.id) &&
                typeof item.properties?.['eo:cloud_cover'] === 'number' &&
                item.properties['eo:cloud_cover'] >= 0 &&
                item.properties['eo:cloud_cover'] <= maxCloud &&
                Number.isFinite(Date.parse(item.properties.datetime)) &&
                new Date(item.properties.datetime).getUTCFullYear() === year &&
                Array.isArray(item.bbox) &&
                item.bbox[0] <= bbox[0] &&
                item.bbox[1] <= bbox[1] &&
                item.bbox[2] >= bbox[2] &&
                item.bbox[3] >= bbox[3],
            )
            .sort(
              (a, b) =>
                a.properties['eo:cloud_cover'] - b.properties['eo:cloud_cover'],
            )[0];
          row = item
            ? {
                year,
                status: 'available',
                id: item.id,
                observed_at: item.properties.datetime,
                cloud_percent: item.properties['eo:cloud_cover'],
                platform: String(item.properties.platform ?? 'Landsat').slice(
                  0,
                  80,
                ),
              }
            : { ...row, status: 'missing' };
        } catch {
          signal?.throwIfAborted();
        }
        rows.push(row);
        onProgress(rows.length, years.length);
      }
      return {
        sourceId: 'history',
        source: 'USGS Landsat Collection 2 via Planetary Computer',
        sourceUrl: HISTORY_SOURCE,
        area: point,
        retrievedAtMs,
        status: rows.some((row) => row.status === 'available')
          ? 'available'
          : 'unavailable',
        coverage: `One low-cloud scene among up to 20 candidates per requested year. Scene bounding box encloses the area; per-pixel validity is not assessed. ~30 m optical pixels.`,
        observedAt: null,
        confidence: 'unassessed',
        bbox,
        rows,
        startYear,
        endYear,
        stepYears,
        maxCloud,
        summary: `Historical Landsat sequence: ${rows.filter((row) => row.status === 'available').length}/${rows.length} requested years have a candidate. Dates are acquisitions, not annual composites; missing years remain gaps.`,
        attribution: 'USGS Landsat Collection 2; Microsoft Planetary Computer',
      };
    },
  };
}
function validFrameId(id) {
  return (
    typeof id === 'string' &&
    /^(LT04|LT05|LE07|LC08|LC09)_[A-Z0-9_]{1,110}$/.test(id)
  );
}
/** Construct a fixed-provider crop; never render arbitrary imported URLs. */
export function historicalFrameUrl(frame, bbox) {
  if (
    !validFrameId(frame?.id) ||
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every(Number.isFinite) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3] ||
    Math.abs(bbox[0]) > 180 ||
    Math.abs(bbox[2]) > 180 ||
    Math.abs(bbox[1]) > 85.5 ||
    Math.abs(bbox[3]) > 85.5
  )
    throw new TypeError('Invalid historical crop.');
  const url = new URL(
    `${PC}/api/data/v1/item/bbox/${bbox.join(',')}/512x512.png`,
  );
  url.searchParams.set('collection', 'landsat-c2-l2');
  url.searchParams.set('item', frame.id);
  for (const asset of ['red', 'green', 'blue'])
    url.searchParams.append('assets', asset);
  url.searchParams.set('rescale', '7000,18000');
  return url.href;
}
