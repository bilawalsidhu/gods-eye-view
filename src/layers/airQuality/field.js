/**
 * A model field a host supplies: a forecast of the six pollutants and the US
 * AQI on regular grids (such as CAMS: one global grid and a finer one over
 * Europe), read at a place, painted as images and placed in time. Pure and
 * portable: no network, scene or UI imports. The stand-alone app has no field
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
 *   `europe` when `europe.steps` lists the step. A run the host no longer has
 *   rejects with `code: 'run_changed'`, and the layer asks for a run again.
 *
 * `Manifest = { source?, sourceShort?, run, scale, global: Region, europe?:
 * Region & { rectangle, blendDeg? } }`:
 * - `source`: the model's name; `sourceShort` a short form of it (e.g.
 *   `'CAMS'`). The card's time line names the model by `sourceShort`, else
 *   `source`.
 * - `run`: ISO start time (`T` or a space before the time), read as UTC when
 *   it omits a zone. Steps are hours after it.
 * - `scale`: per field id, what a grid's integers are divided by.
 * - `Region = { width, height, lon0, lat0, step, wrap, steps }`: `width` ×
 *   `height` grid points, the first at (`lon0`, `lat0`) and `step` degrees
 *   apart, rows north first. A full-turn row requires `wrap: true`. Insets cannot
 *   wrap. `steps` lists the forecast hours in ascending order.
 * - `europe.rectangle` gives the outer cell edges, half a step beyond the first
 *   and last grid points. `blendDeg` is the blending band inside those edges.
 *
 * `Grids = Record<FieldId, Uint16Array>`: each value × `scale[id]`, rounded;
 * `FIELD_MISSING` where there is none. Concentrations in µg/m³, CO in mg/m³,
 * the US AQI as its index.
 * Values represent forecast hours and use the station scales for hourly values.
 * Each step hands over new arrays. Sources must leave their contents intact.
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
/**
 * The field's strength by camera height: full (this share of each pixel's
 * own opacity) from `FIELD_FULL_M` up, fading on a log scale to nothing at
 * `FIELD_NONE_M`; below that the map shows stations only.
 */
export const FIELD_FADE = Object.freeze({
  maxAlpha: 0.85,
  fullM: 600_000,
  noneM: 60_000,
});
/** Maximum number of grid points across a step's regions. */
const MAX_REGION_POINTS = 8_000_000;
const HOUR_MS = 3600_000;
/** Grid cells within this of a grid point read as on it. */
const SNAP = 1e-9;

/** The field id of a layer view (`'aqi'`, `'PM2.5'`, ...), or null. */
export const fieldIdOf = (view) =>
  view === 'aqi' ? 'aqi' : (AQI_POLLUTANTS[view] ?? null);

const MAX_CREDIT_CHARS = 2000;
/** An ISO run time: the date, `T` or a space, the time, and maybe a zone. */
const ISO_RUN =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([Zz]|[+-]\d{2}:?\d{2})?$/;
/** A run's epoch ms, read as UTC without a zone; NaN for any other string. */
function runTime(run) {
  const iso = ISO_RUN.exec(run);
  if (!iso) return NaN;
  const zone = (iso[3] ?? 'Z')
    .toUpperCase()
    .replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  return Date.parse(`${iso[1]}T${iso[2]}${zone}`);
}
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
    // A float32 step may carry the last row past the pole, by less than the
    // whole-turn slack below.
    lat0 - (height - 1) * step < -90 - Math.min(step / 2, 0.36) ||
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
  const wraps = wrap === true;
  const span = width * step;
  // A row within half a step (and 0.1 % of a turn) of 360° is a whole turn:
  // a float32 step misses 360° by a few hundredths of a step.
  const slack = Math.min(step / 2, 0.36);
  if (!wraps && span > 360 - slack) throw malformed();
  // A wrapping region is one whole row of the globe, and its world image
  // stays within the point budget; an inset never wraps.
  if (
    wraps &&
    (inset ||
      Math.abs(span - 360) >= slack ||
      width * Math.round(180 / step) > MAX_REGION_POINTS)
  )
    throw malformed();
  const region = {
    width,
    height,
    lon0,
    lat0,
    step,
    wrap: wraps,
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
  const runMs = typeof raw.run === 'string' ? runTime(raw.run) : NaN;
  if (typeof raw.run !== 'string' || !Number.isFinite(runMs)) throw malformed();
  const scale = {};
  for (const id of FIELD_IDS) {
    const value = raw.scale?.[id];
    if (!Number.isFinite(value) || value <= 0) throw malformed();
    scale[id] = value;
  }
  const text = (value, length) =>
    typeof value === 'string' && value.trim()
      ? value.trim().slice(0, length)
      : '';
  const credit = typeof raw.credit === 'string' ? raw.credit.trim() : '';
  if (credit.length > MAX_CREDIT_CHARS) throw malformed();
  const global = readRegion(raw.global);
  const europe = raw.europe ? readRegion(raw.europe, { inset: true }) : null;
  if (
    global.width * global.height + (europe ? europe.width * europe.height : 0) >
    MAX_REGION_POINTS
  )
    throw malformed();
  return Object.freeze({
    source: text(raw.source, 80),
    sourceShort: text(raw.sourceShort, 24),
    credit,
    run: raw.run,
    runMs,
    scale: Object.freeze(scale),
    global,
    ...(europe ? { europe } : {}),
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

const layouts = new WeakMap();
const regionLayout = (region) =>
  region && [
    region.width,
    region.height,
    region.lon0,
    region.lat0,
    region.step,
    region.wrap,
    region.rectangle ?? null,
    region.blendDeg ?? null,
  ];
/**
 * What a step's grids are read with besides their values: the scales and
 * each region's geometry. Grids loaded under one layout are not read under
 * another.
 */
export function fieldLayout(manifest) {
  let layout = layouts.get(manifest);
  if (layout === undefined) {
    layout = JSON.stringify([
      manifest.scale,
      regionLayout(manifest.global),
      regionLayout(manifest.europe),
    ]);
    layouts.set(manifest, layout);
  }
  return layout;
}

const fingerprints = new WeakMap();
/** A grid's values in a few characters (FNV-1a), kept per array; '' for none. */
export function gridFingerprint(values) {
  if (!values) return '';
  let fingerprint = fingerprints.get(values);
  if (fingerprint === undefined) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < values.length; i++)
      hash = Math.imul(hash ^ values[i], 0x01000193);
    fingerprint = `${values.length}.${(hash >>> 0).toString(36)}`;
    fingerprints.set(values, fingerprint);
  }
  return fingerprint;
}

/** Degrees east of `from`, in [0, 360). */
const eastOf = (lon, from) => (((lon - from) % 360) + 360) % 360;

/** Fold the outer half-cells onto their edge points, or snap round-off at a boundary. */
function boundedCoordinate(g, last, halfCells) {
  if (halfCells)
    return g > -0.5 && g < last + 0.5 ? Math.max(0, Math.min(last, g)) : null;
  if (g < 0) return g > -SNAP ? 0 : null;
  if (g > last) return g < last + SNAP ? last : null;
  return g;
}

function columnOf(region, lon) {
  const { width, lon0, step, wrap } = region;
  let gx = eastOf(lon, lon0) / step;
  if (wrap) gx %= width;
  else {
    if (gx > 360 / step - 0.5) gx -= 360 / step;
    gx = boundedCoordinate(gx, width - 1, !region.rectangle);
    if (gx === null) return null;
  }
  const first = Math.min(width - 1, Math.floor(gx));
  const next = wrap ? (first + 1) % width : Math.min(width - 1, first + 1);
  return { first, next, fraction: gx - first };
}

function rowOf(region, lat) {
  const last = region.height - 1;
  const gy = boundedCoordinate(
    (region.lat0 - lat) / region.step,
    last,
    !region.wrap && !region.rectangle,
  );
  if (gy === null) return null;
  const first = Math.min(last, Math.floor(gy));
  return { first, next: Math.min(last, first + 1), fraction: gy - first };
}

function corner(value, weight) {
  if (value !== FIELD_MISSING) return value;
  return weight > 0 ? null : 0;
}

function blend(values, width, x0, x1, tx, y0, y1, ty, scale) {
  const a = corner(values[y0 * width + x0], (1 - tx) * (1 - ty));
  const b = corner(values[y0 * width + x1], tx * (1 - ty));
  const c = corner(values[y1 * width + x0], (1 - tx) * ty);
  const d = corner(values[y1 * width + x1], tx * ty);
  if (a === null || b === null || c === null || d === null) return null;
  return (
    ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / scale
  );
}

/** Bilinear value, or null outside the grid or where a weighted corner is missing. */
export function sampleRegion(region, values, scale, lon, lat) {
  if (!region || !values || !Number.isFinite(lon) || !Number.isFinite(lat))
    return null;
  const x = columnOf(region, lon);
  const y = rowOf(region, lat);
  if (!x || !y) return null;
  return blend(
    values,
    region.width,
    x.first,
    x.next,
    x.fraction,
    y.first,
    y.next,
    y.fraction,
    scale,
  );
}

function insideLon(region, lon) {
  const { west, east } = region.rectangle;
  const fromWest = eastOf(lon, west);
  return Math.min(fromWest, east - west - fromWest);
}

function insideLat(region, lat) {
  const { south, north } = region.rectangle;
  return Math.min(lat - south, north - lat);
}

function weightOf(region, inside) {
  if (!(inside > 0)) return 0;
  const band = region.blendDeg ?? EUROPE_BLEND_DEG;
  if (!(band > 0) || inside >= band) return 1;
  const w = inside / band;
  return w * w * (3 - 2 * w);
}

/** The inset's share rises smoothly from its edge to one blend band inside. */
export function europeWeight(region, lon, lat) {
  if (!region?.rectangle) return 0;
  return weightOf(
    region,
    Math.min(insideLon(region, lon), insideLat(region, lat)),
  );
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

const tableCache = new WeakMap();
const TABLE_SIZE = 4096;

function colorTable(bands, limits) {
  let tables = tableCache.get(bands);
  if (!tables) {
    tables = new WeakMap();
    tableCache.set(bands, tables);
  }
  if (tables.has(limits)) return tables.get(limits);
  const rgb = bands.map(({ color }) =>
    color
      .replace('#', '')
      .match(/\w\w/g)
      .map((pair) => parseInt(pair, 16)),
  );
  const top = 2 * limits.at(-1) - limits.at(-2);
  // Supported clients are little-endian: four RGBA bytes form one packed pixel.
  const packed = new Uint32Array(TABLE_SIZE + 1);
  const rgba = new Uint8ClampedArray(packed.buffer);
  for (let i = 0; i <= TABLE_SIZE; i++)
    writeColor(rgba, i * 4, rgb, limits, (i * top) / TABLE_SIZE);
  const table = { packed, perUnit: TABLE_SIZE / top };
  tables.set(limits, table);
  return table;
}

/**
 * Write a value's colour on a scale into `rgba` at `offset` (0–255 each):
 * each band's own colour sits at the middle of the band, so the field and a
 * station dot of that value agree there, and runs into its neighbours'
 * between two middles. Opacity is given by `fieldOpacity`.
 */
function writeColor(rgba, offset, rgb, limits, value) {
  const p = scalePosition(limits, value);
  const q = Math.min(rgb.length - 1, Math.max(0, p - 0.5));
  const i = Math.min(rgb.length - 2, Math.floor(q));
  const f = q - i;
  const low = rgb[i];
  const high = rgb[i + 1];
  rgba[offset] = Math.round(low[0] + (high[0] - low[0]) * f);
  rgba[offset + 1] = Math.round(low[1] + (high[1] - low[1]) * f);
  rgba[offset + 2] = Math.round(low[2] + (high[2] - low[2]) * f);
  rgba[offset + 3] = Math.round(255 * fieldOpacity(p));
}

/**
 * The share of each pixel's opacity the field is drawn with for a camera
 * `heightM` above the ellipsoid (`FIELD_FADE`); full where the height is
 * not known.
 */
export function fieldStrength(heightM) {
  const { maxAlpha, fullM, noneM } = FIELD_FADE;
  if (!Number.isFinite(heightM) || heightM >= fullM) return maxAlpha;
  if (heightM <= noneM) return 0;
  return (maxAlpha * Math.log(heightM / noneM)) / Math.log(fullM / noneM);
}

/** A longitude edge in [-180, 180]: 180 itself stays 180, a crossing keeps west east of east. */
const lonEdge = (lon) =>
  lon > 180 || lon < -180 ? ((((lon + 180) % 360) + 360) % 360) - 180 : lon;
/** The rows of a region drawn: those whose cells lie between the poles. */
function imageRows({ lat0, step, height }) {
  const first = Math.max(0, Math.ceil((lat0 + step / 2 - 90) / step - SNAP));
  const last = Math.min(
    height - 1,
    Math.floor((lat0 - step / 2 + 90) / step + SNAP),
  );
  return { first, count: last - first + 1 };
}
/** The rectangle a region's grid points cover, each the middle of its cell. */
function regionRectangle(region) {
  if (region.rectangle) {
    const r = region.rectangle;
    return { ...r, west: lonEdge(r.west), east: lonEdge(r.east) };
  }
  const half = region.step / 2;
  const { first, count } = imageRows(region);
  const west = region.lon0 - half,
    east = region.lon0 + (region.width - 0.5) * region.step;
  return {
    west: lonEdge(west),
    east: lonEdge(east),
    north: Math.min(90, region.lat0 - first * region.step + half),
    south: Math.max(
      -90,
      region.lat0 - (first + count - 1) * region.step - half,
    ),
  };
}

/** Precompute one axis of a region sampled on the output image's grid. */
function axisTerms(region, coordinates, termsOf) {
  const first = new Int32Array(coordinates.length);
  const next = new Int32Array(coordinates.length);
  const fraction = new Float64Array(coordinates.length);
  const valid = new Uint8Array(coordinates.length);
  for (let i = 0; i < coordinates.length; i++) {
    const terms = termsOf(region, coordinates[i]);
    if (terms) {
      first[i] = terms.first;
      next[i] = terms.next;
      fraction[i] = terms.fraction;
      valid[i] = 1;
    }
  }
  return { first, next, fraction, valid };
}

function gridSampler(region, values, scale, lons, lats) {
  if (!values) return () => null;
  const col = axisTerms(region, lons, columnOf);
  const row = axisTerms(region, lats, rowOf);
  return (x, y) => {
    if (!col.valid[x] || !row.valid[y]) return null;
    return blend(
      values,
      region.width,
      col.first[x],
      col.next[x],
      col.fraction[x],
      row.first[y],
      row.next[y],
      row.fraction[y],
      scale,
    );
  };
}

/**
 * The field of `id` as images to drape, the global one first:
 * `[{ name, rectangle, width, height, rgba }]`, `rgba` row by row from the
 * north-west. A wrapping global region is resampled onto the whole world
 * from 180° W; any other region is one pixel per grid point.
 *
 * Where the Europe inset is drawn, both images carry the value the tiles
 * read there (`sampleField`: the global value blended into the inset's over
 * `blendDeg`), so the map's colour is the tiles' value everywhere. Over the
 * blend band they cross-fade rather than meet at an edge: the inset's
 * opacity is its share `w` of its own, the global image's under it
 * `(1 − w) / (1 − s · w · a)` of its own (`a`). Drawn at the field's full
 * strength `s` (`FIELD_FADE.maxAlpha`, the strength from 600 km up) that
 * makes the pair exactly as opaque as one image of that value; the images
 * are painted once a step, not as the camera fades them, so below 600 km
 * the band is up to 14 % (at 0.44 strength) more opaque than one image. The
 * inset is clear at its edge and the global image clear where `w` is 1, so
 * neither has an edge to show.
 * Colours come from a 4096-interval lookup table, within one per channel of the band formula.
 * Wrapped images sample pixel centres. A single-cell peak can appear diluted.
 * Beside missing data, texture filtering fades the map over one cell.
 * @param {{bands: Array<{color: string}>, limits: number[]}} scale
 */
export function paintField(manifest, grids, id, { bands, limits }) {
  const scale = manifest.scale[id];
  const table = colorTable(bands, limits);
  const global = manifest.global;
  const europe = grids.europe ? manifest.europe : null;
  const wide = grids.global[id];
  const local = grids.europe?.[id];

  function paintRegion(region, inset) {
    const wrapped = region.wrap;
    const width = region.width;
    const rows = wrapped || inset ? null : imageRows(region);
    const height = wrapped
      ? Math.round(180 / region.step)
      : (rows?.count ?? region.height);
    if (height <= 0) return null;
    const firstRow = rows?.first ?? 0;
    const samplesGrid = wrapped || europe !== null;
    const lons =
      samplesGrid &&
      Float64Array.from({ length: width }, (_, x) =>
        wrapped
          ? -180 + ((x + 0.5) / width) * 360
          : region.lon0 + x * region.step,
      );
    const lats =
      samplesGrid &&
      Float64Array.from({ length: height }, (_, y) =>
        wrapped
          ? 90 - ((y + 0.5) / height) * 180
          : region.lat0 - (y + firstRow) * region.step,
      );
    const coarseAt =
      samplesGrid && gridSampler(global, wide, scale, lons, lats);
    const fineAt =
      europe && !inset && gridSampler(europe, local, scale, lons, lats);
    const lonDistance = europe && lons.map((lon) => insideLon(europe, lon));
    const latDistance = europe && lats.map((lat) => insideLat(europe, lat));
    const rgba = new Uint8ClampedArray(width * height * 4);
    const pixels = new Uint32Array(rgba.buffer);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const w = europe
          ? weightOf(europe, Math.min(lonDistance[x], latDistance[y]))
          : 0;
        if (inset ? w <= 0 : w >= 1) continue;
        let value;
        if (inset) {
          const raw = local[index];
          value = raw === FIELD_MISSING ? null : raw / scale;
          if (value === null || w < 1) {
            const coarse = coarseAt(x, y);
            if (value === null) value = coarse;
            else if (coarse !== null) value = coarse + (value - coarse) * w;
          }
        } else {
          if (wrapped) value = coarseAt(x, y);
          else {
            const raw = wide[index + firstRow * width];
            value = raw === FIELD_MISSING ? null : raw / scale;
          }
          if (europe && (value === null || w > 0)) {
            if (!wrapped) value = coarseAt(x, y);
            const fine = fineAt(x, y);
            if (fine !== null)
              value = value === null ? fine : value + (fine - value) * w;
          }
        }
        if (value === null) continue;
        const j = Math.min(
          TABLE_SIZE,
          Math.max(0, Math.round(value * table.perUnit)),
        );
        let color = table.packed[j];
        if (w > 0 && w < 1) {
          const alpha = fieldOpacity(scalePosition(limits, value));
          const share = inset
            ? w
            : (1 - w) / (1 - FIELD_FADE.maxAlpha * w * alpha);
          color = (color & 0xffffff) | (Math.round(255 * alpha * share) << 24);
        }
        pixels[index] = color;
      }
    }
    return {
      name: inset ? 'europe' : 'global',
      rectangle: wrapped
        ? { west: -180, south: -90, east: 180, north: 90 }
        : regionRectangle(region),
      width,
      height,
      rgba,
    };
  }

  const images = [];
  const world = paintRegion(global, false);
  if (world) images.push(world);
  if (europe) images.push(paintRegion(europe, true));
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
