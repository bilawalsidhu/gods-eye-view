import { gibsTileUrl } from '../../maps/gibs.js';

const HOST = 'https://gibs.earthdata.nasa.gov';
export const CAPABILITIES_URL = `${HOST}/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml`;
export const PRODUCTS = Object.freeze({
  anomaly: 'GHRSST_L4_MUR25_Sea_Surface_Temperature_Anomalies',
  sst: 'GHRSST_L4_MUR25_Sea_Surface_Temperature',
});
export const NINO34 = Object.freeze([
  Object.freeze([-170, -5]),
  Object.freeze([-120, -5]),
  Object.freeze([-120, 5]),
  Object.freeze([-170, 5]),
  Object.freeze([-170, -5]),
]);

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:]+)\s*=\s*(["'])(.*?)\2/gs)].map(
      ([, name, , value]) => [name, value],
    ),
  );
}

function dateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new RangeError(`Invalid daily date: ${value}`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    throw new RangeError(`Invalid daily date: ${value}`);
  return time;
}

export function parseTimeDimension(value) {
  const dates = new Set();
  for (const token of value.split(',')) {
    const [start, end = start, period] = token.trim().split('/');
    if (period !== undefined && period !== 'P1D')
      throw new RangeError(`Unsupported time period: ${period}`);
    const first = dateTime(start);
    const last = dateTime(end);
    if (last < first || last - first > 366 * 200 * 86400000)
      throw new RangeError('Invalid daily interval');
    for (let time = first; time <= last; time += 86400000)
      dates.add(new Date(time).toISOString().slice(0, 10));
  }
  return [...dates].sort();
}

export function parseCapabilities(xml, layer) {
  const block = [...xml.matchAll(/<Layer\b[^>]*>(.*?)<\/Layer>/gs)].find(
    ([, body]) => body.includes(`<ows:Identifier>${layer}</ows:Identifier>`),
  )?.[1];
  if (!block) throw new Error(`GIBS layer not advertised: ${layer}`);
  const dimension = [
    ...block.matchAll(/<Dimension\b[^>]*>(.*?)<\/Dimension>/gs),
  ].find(([, body]) =>
    /<ows:Identifier>Time<\/ows:Identifier>/.test(body),
  )?.[1];
  if (!dimension) throw new Error('GIBS time dimension missing');
  const values = [...dimension.matchAll(/<Value>(.*?)<\/Value>/gs)].map(
    ([, text]) => text.trim(),
  );
  const colormapUrl = [...block.matchAll(/<ows:Metadata\b[^>]*\/?\s*>/g)]
    .map(([tag]) => attributes(tag)['xlink:href'])
    .find((url) => url?.startsWith(`${HOST}/colormaps/v1.3/`));
  const matrixSet = block.match(/<TileMatrixSet>(.*?)<\/TileMatrixSet>/)?.[1];
  if (!colormapUrl || !/^GoogleMapsCompatible_Level\d+$/.test(matrixSet ?? ''))
    throw new Error('GIBS colormap or Web Mercator matrix missing');
  const dates = parseTimeDimension(values.join(','));
  return { layer, dates, latest: dates.at(-1), colormapUrl, matrixSet };
}

function bound(value) {
  if (value === '-INF') return -Infinity;
  if (value === '+INF' || value === 'INF') return Infinity;
  if (value.trim() === '') throw new Error('Empty colormap bound');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Invalid colormap bound');
  return number;
}

/** Preserve the published quantization interval, never infer a pixel midpoint. */
export function parseColormap(xml) {
  return [...xml.matchAll(/<ColorMapEntry\b[^>]*\/?\s*>/g)].map(([tag]) => {
    const attr = attributes(tag);
    const rgb = (attr.rgb ?? '').split(',').map(Number);
    if (
      rgb.length !== 3 ||
      rgb.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
    )
      throw new Error('Invalid colormap RGB');
    const nodata = attr.nodata === 'true' || attr.transparent === 'true';
    if (nodata) return { rgb, nodata: true };
    const range = attr.value?.match(/^[[(]([^,]+),([^\])]+)[\])]$/);
    if (!range) throw new Error('Missing colormap value interval');
    const low = bound(range[1]);
    const high = bound(range[2]);
    if (!(low < high)) throw new Error('Invalid colormap interval');
    return { rgb, low, high, nodata: false };
  });
}

export function pixelToValue(entries, [r, g, b, a]) {
  if (a !== 255) return null;
  const entry = entries.find(
    ({ rgb }) => rgb[0] === r && rgb[1] === g && rgb[2] === b,
  );
  if (!entry || entry.nodata) return null;
  const { low, high } = entry;
  return {
    low,
    high,
    kind: low === -Infinity ? 'below' : high === Infinity ? 'above' : 'range',
  };
}

export function anomalyReadout(value) {
  return value;
}

export function buildTileUrl({ layer, date, matrixSet, z, y, x }) {
  dateTime(date);
  const maximum = Number(
    matrixSet?.match(/^GoogleMapsCompatible_Level(\d+)$/)?.[1],
  );
  if (!Object.values(PRODUCTS).includes(layer) || !Number.isInteger(maximum))
    throw new RangeError('Unsupported ocean product or matrix');
  if (
    !Number.isInteger(z) ||
    z < 0 ||
    z > maximum ||
    ![x, y].every((v) => Number.isInteger(v) && v >= 0 && v < 2 ** z)
  )
    throw new RangeError('Invalid Web Mercator tile');
  return gibsTileUrl({ layer, date, maxLevel: maximum }, { z, y, x });
}

export function tileAt(lon, lat, z) {
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    !Number.isInteger(z) ||
    z < 0 ||
    z > 22
  )
    throw new RangeError('Invalid coordinate or zoom');
  const count = 2 ** z;
  const longitude = (((lon + 180) % 360) + 360) % 360;
  const latitude = Math.max(-85.0511287798066, Math.min(85.0511287798066, lat));
  const px = (longitude / 360) * count * 256;
  const sin = Math.sin((latitude * Math.PI) / 180);
  const py = Math.min(
    count * 256 - 1e-8,
    Math.max(
      0,
      (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * count * 256,
    ),
  );
  return {
    x: Math.floor(px / 256),
    y: Math.floor(py / 256),
    pixelX: Math.floor(px % 256),
    pixelY: Math.floor(py % 256),
  };
}

export function createOceanSource(fetchImpl = globalThis.fetch) {
  let metadata;
  let metadataTime = 0;
  const palettes = new Map();
  return {
    async palette(mode) {
      const product = (await this.metadata())[mode];
      if (!product) throw new RangeError('Unsupported ocean product');
      if (!palettes.has(mode)) {
        const response = await fetchImpl(product.colormapUrl);
        if (!response.ok)
          throw new Error(`GIBS palette HTTP ${response.status}`);
        const entries = parseColormap(await response.text());
        if (!entries.some((entry) => !entry.nodata))
          throw new Error('Empty ocean palette');
        palettes.set(mode, entries);
      }
      return palettes.get(mode);
    },
    metadata() {
      if (Date.now() - metadataTime >= 3600000) metadata = undefined;
      metadata ??= (async () => {
        metadataTime = Date.now();
        const response = await fetchImpl(CAPABILITIES_URL);
        if (!response.ok)
          throw new Error(`GIBS capabilities HTTP ${response.status}`);
        const xml = await response.text();
        return Object.fromEntries(
          Object.entries(PRODUCTS).map(([mode, layer]) => [
            mode,
            parseCapabilities(xml, layer),
          ]),
        );
      })().catch((error) => {
        metadata = undefined;
        throw error;
      });
      return metadata;
    },
    async tileUrl(mode, date, tile) {
      const product = (await this.metadata())[mode];
      if (!product || !product.dates.includes(date))
        throw new RangeError('Ocean date not advertised');
      return buildTileUrl({ ...product, date, ...tile });
    },
  };
}
