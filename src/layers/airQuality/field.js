/**
 * A model field a host supplies: a forecast of the six pollutants and the US
 * AQI on regular grids (such as CAMS: one global grid and a finer one over
 * Europe), read at a place, painted as images and placed in time. Pure and
 * portable: no network, scene or UI imports. Stand-alone Core has no field
 * unless one is configured (`fieldSource.js`).
 *
 * The host's `fieldSource`, passed to `createAirQualityLayer`:
 *
 * - `getManifest({ signal?, atMs? })` → `Promise<Manifest>`: the run to show;
 *   the newest one, or with `atMs` (a timeline time outside the run the layer
 *   holds) the run that covers that time. A source with no field rejects with
 *   `code: 'not_configured'`, and the layer then shows stations only, as it
 *   does without a source.
 * - `getStep(step, { signal?, run? })` → `Promise<{ global: Grids, europe?:
 *   Grids }>`: one forecast step (hours after `run`) of the run `run`, with
 *   `europe` when `europe.steps` lists the step.
 *
 * `Manifest = { source?, run, scale, global: Region, europe?: Region &
 * { rectangle, blendDeg? } }`:
 * - `source`: the model's name as the card shows it (e.g. `'CAMS'`).
 * - `run`: the run's start, an ISO time; steps are hours after it.
 * - `scale`: per field id, what a grid's integers are divided by.
 * - `Region = { width, height, lon0, lat0, step, wrap, steps }`: `width` ×
 *   `height` grid points, the first at (`lon0`, `lat0`) and `step` degrees
 *   apart, rows north first; `wrap` when a row goes round the globe; `steps`
 *   the forecast hours it has, ascending.
 * - `europe.rectangle` (`{west, south, east, north}`, degrees) is the inset's
 *   edge, and `blendDeg` the band inside it over which it blends into the
 *   global field (default `EUROPE_BLEND_DEG`).
 *
 * `Grids = Record<FieldId, Uint16Array>`: each value × `scale[id]`, rounded;
 * `FIELD_MISSING` where there is none. Concentrations in µg/m³, CO in mg/m³,
 * the US AQI as its index.
 */
import { AQI_POLLUTANTS } from './usAqi.js';

/** The grids a step carries: the six pollutants, then the US AQI. */
export const FIELD_IDS = Object.freeze([
  'pm25',
  'pm10',
  'o3',
  'no2',
  'so2',
  'co',
  'aqi',
]);
/** A grid value with no data. */
export const FIELD_MISSING = 65535;
/** The Europe inset blends into the global field over this many degrees. */
export const EUROPE_BLEND_DEG = 3;
/** The most grid points a region may have (a 0.1° world is 6.5 million). */
const MAX_REGION_POINTS = 8_000_000;
const HOUR_MS = 3600_000;

/** The field id of a layer view (`'aqi'`, `'PM2.5'`, ...), or null. */
export const fieldIdOf = (view) =>
  view === 'aqi' ? 'aqi' : (AQI_POLLUTANTS[view] ?? null);

const malformed = () => new Error('Malformed air-quality field');

function readRegion(raw, { inset = false } = {}) {
  if (!raw || typeof raw !== 'object') throw malformed();
  const { width, height, lon0, lat0, step, wrap, steps } = raw;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width * height > MAX_REGION_POINTS ||
    ![lon0, lat0, step].every(Number.isFinite) ||
    step <= 0 ||
    Math.abs(lat0) > 90 ||
    !Array.isArray(steps) ||
    !steps.length ||
    !steps.every(
      (hour, index) =>
        Number.isInteger(hour) &&
        hour >= 0 &&
        hour <= 999 &&
        (index === 0 || hour > steps[index - 1]),
    )
  )
    throw malformed();
  const region = {
    width,
    height,
    lon0,
    lat0,
    step,
    wrap: wrap === true,
    steps: Object.freeze([...steps]),
  };
  if (inset) {
    const rect = raw.rectangle;
    if (
      !rect ||
      !['west', 'south', 'east', 'north'].every((key) =>
        Number.isFinite(rect[key]),
      ) ||
      rect.south >= rect.north ||
      rect.west >= rect.east
    )
      throw malformed();
    region.rectangle = Object.freeze({
      west: rect.west,
      south: rect.south,
      east: rect.east,
      north: rect.north,
    });
    region.blendDeg =
      Number.isFinite(raw.blendDeg) && raw.blendDeg >= 0
        ? raw.blendDeg
        : EUROPE_BLEND_DEG;
  }
  return Object.freeze(region);
}

/**
 * A host's manifest, checked and frozen; throws when it is not one.
 * @param {unknown} raw
 */
export function readFieldManifest(raw) {
  if (!raw || typeof raw !== 'object') throw malformed();
  const runMs = Date.parse(raw.run);
  if (typeof raw.run !== 'string' || !Number.isFinite(runMs)) throw malformed();
  const scale = {};
  for (const id of FIELD_IDS) {
    const value = raw.scale?.[id];
    if (!Number.isFinite(value) || value <= 0) throw malformed();
    scale[id] = value;
  }
  const source =
    typeof raw.source === 'string' && raw.source.trim()
      ? raw.source.trim().slice(0, 80)
      : '';
  return Object.freeze({
    source,
    run: raw.run,
    runMs,
    scale: Object.freeze(scale),
    global: readRegion(raw.global),
    ...(raw.europe ? { europe: readRegion(raw.europe, { inset: true }) } : {}),
  });
}

function readGrids(region, grids) {
  if (!grids || typeof grids !== 'object') throw malformed();
  const out = {};
  for (const id of FIELD_IDS) {
    const values = grids[id];
    if (
      !(values instanceof Uint16Array) ||
      values.length !== region.width * region.height
    )
      throw malformed();
    out[id] = values;
  }
  return Object.freeze(out);
}

/**
 * A step's grids as a host gave them, checked against `manifest`: every
 * field id, each the size of its region. Europe is kept only where the
 * manifest has it for `step`.
 */
export function readFieldStep(manifest, step, data) {
  const global = readGrids(manifest.global, data?.global);
  const europe =
    manifest.europe?.steps.includes(step) && data?.europe
      ? readGrids(manifest.europe, data.europe)
      : null;
  return Object.freeze({ global, ...(europe ? { europe } : {}) });
}

/** Degrees east of `from`, in [0, 360). */
const eastOf = (lon, from) => (((lon - from) % 360) + 360) % 360;

/**
 * One region's value at a place, bilinear between its four nearest grid
 * points; null outside the region or where one of them that counts (has
 * some weight there) has no data.
 */
export function sampleRegion(region, values, scale, lon, lat) {
  if (!region || !values) return null;
  const { width, height, lon0, lat0, step, wrap } = region;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  let gx = eastOf(lon, lon0) / step;
  if (wrap) gx %= width;
  else if (gx > width - 1) return null;
  const gy = (lat0 - lat) / step;
  if (!(gy >= 0 && gy <= height - 1)) return null;
  const x0 = Math.min(width - 1, Math.floor(gx));
  const x1 = wrap ? (x0 + 1) % width : Math.min(width - 1, x0 + 1);
  const y0 = Math.min(height - 1, Math.floor(gy));
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  // A point with no data spoils the value only where it has some weight.
  const corner = (index, weight) => {
    const value = values[index];
    if (value !== FIELD_MISSING) return value;
    return weight > 0 ? null : 0;
  };
  const a = corner(y0 * width + x0, (1 - tx) * (1 - ty));
  const b = corner(y0 * width + x1, tx * (1 - ty));
  const c = corner(y1 * width + x0, (1 - tx) * ty);
  const d = corner(y1 * width + x1, tx * ty);
  if (a === null || b === null || c === null || d === null) return null;
  return (
    ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / scale
  );
}

/**
 * The Europe inset's share at a place: 0 at its edge and outside it, rising
 * smoothly (smoothstep) to 1 at `blendDeg` inside it.
 */
export function europeWeight(region, lon, lat) {
  if (!region?.rectangle) return 0;
  const { west, east, south, north } = region.rectangle;
  const fromWest = eastOf(lon, west);
  const inside = Math.min(
    fromWest,
    east - west - fromWest,
    lat - south,
    north - lat,
  );
  if (!(inside > 0)) return 0;
  const band = region.blendDeg ?? EUROPE_BLEND_DEG;
  if (!(band > 0) || inside >= band) return 1;
  const w = inside / band;
  return w * w * (3 - 2 * w);
}

/**
 * The field's value of `id` at a place, as the map shows it: the global
 * field, and inside the Europe inset the inset's, blended into the global
 * one near its edge (`global + (europe − global) · w`, `europeWeight`).
 * @returns {number | null}
 */
export function sampleField(manifest, grids, id, lon, lat) {
  if (!manifest || !grids) return null;
  const scale = manifest.scale[id];
  const wide = sampleRegion(
    manifest.global,
    grids.global?.[id],
    scale,
    lon,
    lat,
  );
  const fine = grids.europe
    ? sampleRegion(manifest.europe, grids.europe[id], scale, lon, lat)
    : null;
  if (fine === null) return wide;
  if (wide === null) return fine;
  return wide + (fine - wide) * europeWeight(manifest.europe, lon, lat);
}

/**
 * Where a value sits on a scale of five `limits` (six bands): the band's
 * index plus the share of the way through it, 0 … 6. The open top band is
 * taken to be as wide as the one below it.
 */
export function scalePosition(limits, value) {
  if (!(value > 0)) return 0;
  let low = 0;
  for (let i = 0; i < limits.length; i++) {
    if (value <= limits[i]) return i + (value - low) / (limits[i] - low);
    low = limits[i];
  }
  const span = low - limits[limits.length - 2];
  return Math.min(limits.length + 1, limits.length + (value - low) / span);
}

/** A field's opacity at scale position `p`: clean air stays mostly clear. */
export const fieldOpacity = (p) => Math.min(0.82, 0.05 + 0.26 * p);

const rgbCache = new WeakMap();
const rgbOf = (bands) => {
  let rgb = rgbCache.get(bands);
  if (!rgb) {
    rgb = bands.map(({ color }) =>
      color
        .replace('#', '')
        .match(/\w\w/g)
        .map((pair) => parseInt(pair, 16)),
    );
    rgbCache.set(bands, rgb);
  }
  return rgb;
};

/**
 * A value's colour on a scale, `[r, g, b, alpha]` (0–255, alpha 0–1): each
 * band's own colour sits at the middle of the band, so the field and a
 * station dot of that value agree there, and runs into its neighbours'
 * between two middles.
 */
export function fieldColor(bands, limits, value) {
  const p = scalePosition(limits, value);
  const rgb = rgbOf(bands);
  const q = Math.min(rgb.length - 1, Math.max(0, p - 0.5));
  const i = Math.min(rgb.length - 2, Math.floor(q));
  const f = q - i;
  return [
    ...[0, 1, 2].map((channel) =>
      Math.round(rgb[i][channel] + (rgb[i + 1][channel] - rgb[i][channel]) * f),
    ),
    fieldOpacity(p),
  ];
}

/** The rectangle a region's grid points cover, each the middle of its cell. */
function regionRectangle(region) {
  if (region.rectangle) return region.rectangle;
  const half = region.step / 2;
  return {
    west: region.lon0 - half,
    east: region.lon0 + (region.width - 0.5) * region.step,
    north: Math.min(90, region.lat0 + half),
    south: Math.max(-90, region.lat0 - (region.height - 0.5) * region.step),
  };
}

/** One image's pixels: `valueAt(x, y)` painted, `alphaAt` adjusting opacity. */
function paintImage(width, height, valueAt, colorOf, alphaAt = null) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = valueAt(x, y);
      if (value === null) continue;
      const [r, g, b, alpha] = colorOf(value);
      const offset = (y * width + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = Math.round(
        255 * (alphaAt ? alphaAt(x, y, alpha) : alpha),
      );
    }
  return rgba;
}

/**
 * The field of `id` as images to drape, the global one first:
 * `[{ name, rectangle, width, height, rgba }]`, `rgba` row by row from the
 * north-west. A wrapping global region is resampled onto the whole world
 * from 180° W; any other region is one pixel per grid point.
 *
 * Where the Europe inset is drawn the two images cross-fade over its blend
 * band rather than stack: the inset's opacity is multiplied by its share
 * `w` and the global image's under it by `(1 − w) / (1 − w · a)` (`a` that
 * pixel's own opacity), which makes the pair as opaque as one image.
 * @param {{bands: Array<{color: string}>, limits: number[]}} scale
 */
export function paintField(manifest, grids, id, { bands, limits }) {
  const scale = manifest.scale[id];
  const colorOf = (value) => fieldColor(bands, limits, value);
  const global = manifest.global;
  const europe = grids.europe ? manifest.europe : null;
  const wrapped = global.wrap;
  const width = global.width;
  const height = wrapped ? Math.round(180 / global.step) : global.height;
  const rectangle = wrapped
    ? { west: -180, south: -90, east: 180, north: 90 }
    : regionRectangle(global);
  const lonAt = wrapped
    ? (x) => -180 + ((x + 0.5) / width) * 360
    : (x) => global.lon0 + x * global.step;
  const latAt = wrapped
    ? (y) => 90 - ((y + 0.5) / height) * 180
    : (y) => global.lat0 - y * global.step;
  const images = [
    {
      name: 'global',
      rectangle,
      width,
      height,
      rgba: paintImage(
        width,
        height,
        (x, y) =>
          wrapped
            ? sampleRegion(global, grids.global[id], scale, lonAt(x), latAt(y))
            : grids.global[id][y * width + x] === FIELD_MISSING
              ? null
              : grids.global[id][y * width + x] / scale,
        colorOf,
        europe &&
          ((x, y, alpha) => {
            const w = europeWeight(europe, lonAt(x), latAt(y));
            return w > 0 ? ((1 - w) * alpha) / (1 - w * alpha) : alpha;
          }),
      ),
    },
  ];
  if (europe) {
    const values = grids.europe[id];
    const at = (x, y) => [
      europe.lon0 + x * europe.step,
      europe.lat0 - y * europe.step,
    ];
    images.push({
      name: 'europe',
      rectangle: regionRectangle(europe),
      width: europe.width,
      height: europe.height,
      rgba: paintImage(
        europe.width,
        europe.height,
        (x, y) => {
          const raw = values[y * europe.width + x];
          if (raw === FIELD_MISSING) return null;
          const fine = raw / scale;
          const [lon, lat] = at(x, y);
          const w = europeWeight(europe, lon, lat);
          if (w >= 1) return fine;
          const wide = sampleRegion(global, grids.global[id], scale, lon, lat);
          return wide === null ? fine : wide + (fine - wide) * w;
        },
        colorOf,
        (x, y, alpha) => alpha * europeWeight(europe, ...at(x, y)),
      ),
    });
  }
  return images;
}

/** The time of a forecast step, epoch ms. */
export const fieldStepTime = (manifest, step) =>
  manifest.runMs + step * HOUR_MS;

/** The span of time the field covers: its first step to its last. */
export function fieldCoverage(manifest) {
  const { steps } = manifest.global;
  return {
    start: fieldStepTime(manifest, steps[0]),
    end: fieldStepTime(manifest, steps.at(-1)),
  };
}

/**
 * The step nearest `ms`, or null when `ms` lies more than half a step
 * outside the field's span.
 */
export function fieldStepAt(manifest, ms) {
  if (!manifest || !Number.isFinite(ms)) return null;
  const { steps } = manifest.global;
  const hours = (ms - manifest.runMs) / HOUR_MS;
  const first = steps[0];
  const last = steps.at(-1);
  const before = steps.length > 1 ? steps[1] - first : 3;
  const after = steps.length > 1 ? last - steps.at(-2) : 3;
  if (hours < first - before / 2 || hours > last + after / 2) return null;
  let best = first;
  for (const step of steps)
    if (Math.abs(step - hours) < Math.abs(best - hours)) best = step;
  return best;
}
