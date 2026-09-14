/**
 * @file Global base tier of the animated surface-current field: NOAA CoastWatch
 * blended near-real-time geostrophic currents, ERDDAP griddap dataset
 * `noaacwBLENDEDNRTcurrentsDaily`. Keyless, global, and the only rung of the
 * current ladder that covers an arbitrary view rectangle, so its contract is to
 * return an honest grid for any box on Earth or to fail loudly — never to
 * return an empty grid that a renderer would draw as "still ocean".
 *
 * DATASET GEOMETRY (read 2026-09-01 from the dataset's own `.das`/`.dds`;
 * re-read them before changing any number here):
 *   time      Float64[3376]  seconds since 1970-01-01T00:00:00Z, daily steps
 *   latitude  Float32[720]   −89.875 … 89.875, ascending, 0.25 deg
 *   longitude Float32[1440] −179.875 … 179.875, ascending, 0.25 deg
 *   u_current, v_current  Float64[time][latitude][longitude], m/s,
 *                         standard_name surface_geostrophic_{eastward,northward}
 *                         _sea_water_velocity, _FillValue −214748.3648,
 *                         valid range u ∈ [−4.7954, 4.994], v ∈ [−4.8696, 4.755]
 * Cell CENTERS sit at −89.875 + 0.25·i and −179.875 + 0.25·j, i.e. every axis
 * value is an exact multiple of 1/8 and therefore exactly representable in
 * binary floating point; all index↔coordinate arithmetic below is exact.
 * Latency, two readings of `time[(last)]` on 2026-09-01: 2026-08-29T00:00:00Z
 * earlier in the day, 2026-08-30T00:00:00Z later (age 2.31 d) — the axis
 * advances by a step mid-day, so nothing may assume "today minus three".
 * `testOutOfDate` in the dataset metadata is "now-2days", so CoastWatch itself
 * expects a two-day lag; treat ageMs > ~5 days as a stale-source signal.
 *
 * URL GRAMMAR (ERDDAP griddap):
 *   <server>/griddap/<id>.<ext>?<var>[(t0):<s>:(t1)][(lat0):<s>:(lat1)][(lon0):<s>:(lon1)],<var2>[...]
 * with `[` and `]` percent-encoded as %5B/%5D (ERDDAP tolerates literal colons,
 * parentheses, commas and minus signs in the query, and its own example URLs
 * use them raw). We always emit EXACT grid-center coordinates rather than the
 * caller's raw box edges: ERDDAP snaps a `(value)` constraint to the NEAREST
 * axis point, so passing e.g. `(0)` on this grid can land on either 0.125 or
 * −0.125 (verified live: `[(0):4:(2)]` returned 0.125, 1.125, 2.125). Emitting
 * centers makes the returned shape a deterministic function of the request,
 * which is what lets `chooseStride` promise dimensions up front.
 *
 * WIRE FORMAT: `.csv0` — headerless CSV, one row per grid cell, columns
 * `time,latitude,longitude,u_current,v_current` in the order the variables were
 * named in the query, rows in row-major order (latitude outer, longitude inner,
 * both ascending). The fill value is rendered as the literal token `NaN`, so
 * land and ice arrive as `…,NaN,NaN` rather than as absent rows. `.csv0` is
 * used instead of `.json` because the orchestrator measured a 30x60 deg
 * stride-1 `.json` subset at 2.1 MB, over the 2 MiB cap the Vite proxy applies
 * to ocean endpoints (`OCEAN_MAX_RESPONSE_BYTES` in `vite.config.js`).
 *
 * CELL BUDGET: the field is drawn on a screen, so fetching 0.25 deg cells for a
 * whole-globe view is pointless as well as too large. `chooseStride` picks the
 * smallest ERDDAP stride whose stitched grid fits a caller's cell budget.
 * Measured row costs in `.csv0` (2026-09-01): 58.2 bytes/row over a 15x30 deg
 * Gulf Stream box (7381 rows, 429,777 bytes, 94.0% finite) and 59.1 bytes/row
 * counting only finite rows — land rows (`NaN,NaN`) are shorter, so 59.2
 * bytes/row is the worst case. The default budget of 20,000 cells is therefore
 * ~1.18 MB and the hard ceiling of 30,000 cells ~1.77 MB, both under 2 MiB.
 * Cross-checked against a second, land-heavy box (25-45 N, 82-62 W, stride 1,
 * 2026-08-30 step: 6561 rows, 359,530 B, 71.3% finite, 54.80 B/row overall).
 * Solving the two boxes as a 2x2 system in (bytes per finite row, bytes per
 * land row) gives 59.13 and 44.04 B — the finite-row figure reproduces the
 * 59.1 B/row measured directly, so the budget is sized on the right number.
 *
 * DATELINE: a view rectangle may cross ±180, and this dataset's longitude axis
 * stops at ±179.875, so a crossing box is fetched as TWO requests and stitched
 * rather than refused. Naive splitting would restart the stride phase at each
 * segment's own first index and leave a non-uniform column spacing at the seam;
 * instead both segments are placed on ONE arithmetic progression of axis
 * indices. With west start index w0, stride s and N = 1440 columns:
 *     nW  = floor((N − 1 − w0)/s) + 1        (west columns, up to the axis end)
 *     e0  = w0 + s·nW − N                     (east start, continues the phase)
 *     nE  = floor((e1 − e0)/s) + 1  if e0 ≤ e1, else 0
 * e0 ∈ [0, s) always, so the seam gap is exactly s·0.25 deg like every other
 * gap. Verified live at s = 4 with a 170 E → −170 E box: the two requests
 * returned 11 and 10 columns ending at 179.875 and −170.125, matching the
 * formula exactly. `stitchGlobalCurrents` then unwraps the eastern longitudes
 * by +360 so the stitched axis stays strictly ascending (170 … 190) — callers
 * sampling the field must wrap sample longitudes into that frame, not assume
 * every axis value lies in [−180, 180).
 *
 * SERVED, NOT REQUESTED: every quantity this module reports about the data is
 * read back out of the response. The valid time comes from the stamp in the
 * body, because ERDDAP snaps a `(t)` constraint to its NEAREST time step, so a
 * request for a stamp off the daily axis silently returns a neighbouring day.
 * Measured live 2026-09-01: requesting `2026-08-30T12:00:00Z` returned rows
 * stamped `2026-08-30T00:00:00Z` — reporting the request instead would have
 * put a 12-hour error into an age the UI shows the user. The resolution
 * likewise comes from the spacing of the axis that came back, not from
 * the stride that was asked for; and the axes themselves are the coordinates in
 * the body, sorted. Requested values are kept alongside (`requestedTimeIso`,
 * `stride`) so a caller can see the two disagree, but they never stand in for a
 * measurement. A response that will not support such a reading — no single
 * parseable stamp, a non-uniform axis — is an error, not a field.
 *
 * VECTORS ARE ATOMIC: a cell is either a full (u, v) pair or nothing. If either
 * component is missing or out of envelope, both are written NaN, because a
 * one-component vector has no direction and a streakline integrator stepping
 * through it would draw a confident due-east flow out of a data void. The
 * reported `finite` count is therefore exactly the number of usable vectors.
 * This is defensive, not a repair of anything observed: over a 20x20 deg
 * US-east-coast box at stride 1 (6561 rows, 2026-08-30 step, fetched
 * 2026-09-01) 4677 rows had both components finite, 1884 had neither, and none
 * had exactly one — u and v are masked together upstream.
 *
 * USER-AGENT, learned the hard way on 2026-09-01: coastwatch.noaa.gov answers
 * `403 Forbidden` (an Apache HTML error page, not an ERDDAP `Error {…}` block)
 * to Node's default undici User-Agent. `curl`'s UA, a browser UA and a
 * descriptive project UA all get `200`. Every request this module makes
 * therefore sends `GLOBAL_CURRENTS_USER_AGENT`; dropping that header turns the
 * whole tier into a silent 403 that looks exactly like an outage.
 *
 * This module is pure ESM with no dependencies and no Cesium/DOM access: the
 * Node-side proxy handler and the offline test suite import the same code, and
 * every network call goes through an injected `fetchImpl`. It is server-side by
 * design — a browser would strip the User-Agent header and be blocked by CORS.
 *
 * Sources:
 * - Dataset metadata (title, license, `_FillValue`, valid ranges, axis extents,
 *   `testOutOfDate`) read from
 *   https://coastwatch.noaa.gov/erddap/griddap/noaacwBLENDEDNRTcurrentsDaily.das
 *   and the matching `.dds`, both fetched 2026-09-01.
 * - ERDDAP griddap query syntax:
 *   https://coastwatch.noaa.gov/erddap/griddap/documentation.html
 * - Underlying altimetry: RADS (Radar Altimetry Database System); the mean
 *   dynamic topography used for the geostrophic derivation is MDT CNES/CLS 2013
 *   (stated in the `u_current`/`v_current` `comment` attribute).
 *
 * @module server/ocean/globalCurrents
 */

/**
 * Frozen description of the upstream dataset. Every field is transcribed from
 * the dataset's own ERDDAP metadata on 2026-09-01, not from documentation
 * about it.
 *
 * `license` quotes the `NC_GLOBAL.license` global attribute verbatim, with the
 * attribute's hard line wraps collapsed to single spaces and nothing else
 * changed. `label` quotes `NC_GLOBAL.title`, fixing only the degree sign: the
 * served `.das` emits a raw 0xB0 byte inside a UTF-8 stream, so the title
 * arrives as "0.25�" in any conforming decoder.
 *
 * @const {Readonly<Object>}
 */
export const GLOBAL_CURRENTS_DATASET = Object.freeze({
  /** ERDDAP base URL (no trailing slash, no `/griddap` suffix). */
  server: 'https://coastwatch.noaa.gov/erddap',
  /** griddap datasetID. */
  id: 'noaacwBLENDEDNRTcurrentsDaily',
  /** Eastward component variable, m/s. */
  uVar: 'u_current',
  /** Northward component variable, m/s. */
  vVar: 'v_current',
  /** Native grid spacing in degrees, both axes (`geospatial_lat_resolution`). */
  resolutionDeg: 0.25,
  /** `NC_GLOBAL.title`, degree sign repaired. */
  label:
    'Sea Surface Currents (Geostrophic), Altimetry (S-3A/B,CryoSat2,Jason-2/3,SARAL), '
    + 'Near Real-Time, Global 0.25°, 2017-present, Daily',
  /** `NC_GLOBAL.license`, verbatim, line wraps collapsed to spaces. */
  license:
    'Data courtesy of NOAA; Sentinel data courtesy of Copernicus Program; '
    + 'Generated using AVISO+ products. The data may be used and redistributed for free '
    + 'but is not intended for legal use, since it may contain inaccuracies. '
    + 'Neither the data Contributor, ERD, NOAA, nor the United States Government, nor any '
    + 'of their employees or contractors, makes any warranty, express or implied, '
    + 'including warranties of merchantability and fitness for a particular purpose, '
    + 'or assumes any legal liability for the accuracy, completeness, or usefulness, '
    + 'of this information.',
  /** `NC_GLOBAL.institution` — the string to put on a map credit. */
  attribution: 'NOAA NESDIS CoastWatch',
  /** Human-facing dataset page. */
  infoUrl: 'https://coastwatch.noaa.gov/erddap/info/noaacwBLENDEDNRTcurrentsDaily/index.html',
  /** `_FillValue`/`missing_value` of both components; served as `NaN` in `.csv0`. */
  fillValue: -214748.3648,
  /**
   * Speed magnitude, m/s, beyond which a component is treated as corrupt and
   * mapped to NaN. Chosen as a symmetric envelope over the dataset's own
   * declared valid ranges (u ∈ [−4.7954, 4.994], v ∈ [−4.8696, 4.755]).
   * Deliberately NOT the reference project's `MAX_CURRENT_MS = 2.4`
   * (`domain.ts`): that gate is tuned for HF-radar totals, whose outliers are
   * radial-inversion artifacts, and applying it here would clip real
   * western-boundary-current signal. Two measurements of how close the 2.4 gate
   * sits to real data: the orchestrator measured max |v| = 2.025 m/s in a Gulf
   * Stream box on 2026-08-28, and a 25-45 N, 82-62 W box at stride 1 on the
   * 2026-08-30 step (6561 rows, 4677 with data) peaked at max |(u,v)| = 2.165
   * m/s — 90% of the way to a gate meant to catch instrument artifacts.
   */
  maxSpeedMs: 5,
});

/**
 * Axis geometry, split out because the index arithmetic uses it constantly.
 * `value(i) = origin + i * step`, ascending, i ∈ [0, count).
 * @const {Readonly<Object>}
 */
export const GLOBAL_CURRENTS_AXES = Object.freeze({
  latOrigin: -89.875,
  latStep: 0.25,
  latCount: 720,
  lonOrigin: -179.875,
  lonStep: 0.25,
  lonCount: 1440,
});

/**
 * Default cell budget: ~1.18 MB of `.csv0` at the measured 59.2 bytes/row
 * worst case, comfortably under the proxy's 2 MiB ocean cap.
 * @const {number}
 */
export const DEFAULT_TARGET_CELLS = 20000;

/**
 * Hard ceiling on any caller-supplied budget: ~1.77 MB at 59.2 bytes/row.
 * A caller asking for more is clamped rather than refused, because a
 * too-coarse field still renders honestly while a 2 MiB truncation does not.
 * @const {number}
 */
export const MAX_TARGET_CELLS = 30000;

/**
 * Response size the module refuses to parse, matching `OCEAN_MAX_RESPONSE_BYTES`
 * in `vite.config.js` so this module fails with a useful message instead of
 * letting the proxy truncate a body mid-row.
 * @const {number}
 */
export const RESPONSE_BYTE_CAP = 2 * 1024 * 1024;

/**
 * Descriptive User-Agent, following the repo's `gods-eye-view-*-proxy/1.0`
 * convention (see the CelesTrak and Overpass proxies in `vite.config.js`).
 * NOT cosmetic: coastwatch.noaa.gov returns 403 to Node's default undici
 * User-Agent, verified 2026-09-01, so this header is what makes the tier work.
 * @const {string}
 */
export const GLOBAL_CURRENTS_USER_AGENT =
  'gods-eye-view-ocean-currents-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** Default per-request network timeout, ms. */
const DEFAULT_TIMEOUT_MS = 20000;

/** `.csv0` column layout produced by this module's URL builder. */
const COL_TIME = 0;
const COL_LAT = 1;
const COL_LON = 2;
const COL_U = 3;
const COL_V = 4;
const COL_COUNT = 5;

/** Coordinate comparison tolerance, degrees. One millionth of a 0.25 deg cell. */
const COORD_EPS = 2.5e-7;

/**
 * Render an epoch time as the second-precision ISO stamp ERDDAP accepts and
 * emits (`YYYY-MM-DDTHH:MM:SSZ`). Sub-second precision is dropped because this
 * dataset's axis is daily and ERDDAP rejects nothing else about the form.
 * @param {number} ms - Milliseconds since the epoch; must be a finite, in-range time.
 * @returns {string} ISO 8601 stamp with a literal trailing `Z` and no fraction.
 */
function isoStamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Normalize a longitude into [-180, 180).
 * @param {number} lon - Degrees, any range.
 * @returns {number} Equivalent longitude in [-180, 180), or NaN if `lon` is not finite.
 */
export function wrapLon180(lon) {
  if (!Number.isFinite(lon)) return NaN;
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/** @param {number} x @param {number} lo @param {number} hi @returns {number} */
function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/**
 * Axis coordinate for an integer index. Exact for this grid (every value is a
 * multiple of 1/8).
 * @param {number} index - Integer axis index.
 * @param {number} origin - Coordinate of index 0.
 * @param {number} step - Axis spacing, degrees.
 * @returns {number} Degrees.
 */
function axisValue(index, origin, step) {
  return origin + index * step;
}

/**
 * Format an axis coordinate for an ERDDAP constraint. Fixed 3-decimal notation
 * because every cell center on this grid ends in .125/.375/.625/.875 and
 * because `toFixed` can never emit exponential notation, which ERDDAP rejects.
 * @param {number} deg - Degrees.
 * @returns {string}
 */
function formatCoord(deg) {
  return deg.toFixed(3);
}

/**
 * Lowest axis index whose cell covers `deg`, and highest ditto — deliberately
 * OUTWARD (floor/ceil) rather than ERDDAP's nearest-point snapping, so the
 * fetched grid always covers the caller's rectangle. Nearest-snapping can drop
 * the edge cell of a viewport and leave an unforced strip where streaklines
 * visibly die.
 * @param {number} deg - Requested edge, degrees.
 * @param {number} origin - Axis origin.
 * @param {number} step - Axis spacing.
 * @param {number} count - Axis length.
 * @param {boolean} upper - True for the upper edge (ceil), false for lower (floor).
 * @returns {number} Integer index in [0, count).
 */
function coveringIndex(deg, origin, step, count, upper) {
  const raw = (deg - origin) / step;
  const idx = upper ? Math.ceil(raw) : Math.floor(raw);
  // `+ 0` normalizes the -0 that Math.ceil returns for raw ∈ (-1, 0] — reachable
  // at lon = -180, where raw = -0.5. An index of -0 is arithmetically harmless
  // but leaks into returned range objects, where `Object.is` and
  // `assert.deepStrictEqual` distinguish it from 0.
  return clamp(idx, 0, count - 1) + 0;
}

/**
 * Split a view rectangle into ERDDAP-fetchable longitude index ranges,
 * resolving the ±180 seam. Never returns a range that crosses the seam.
 *
 * A box is read as spanning EASTWARD from `lonMin` to `lonMax`; a raw span of
 * 360 deg or more is the whole globe, and wrapped bounds with `lonMax` west of
 * `lonMin` are a dateline crossing.
 *
 * Both edges snap outward, so a box spanning more than 359.5 deg but less than
 * 360 double-covers up to two columns: the same meridian is returned at each
 * end of the range (measured: a 359.9 deg box yields 1442 columns of a
 * 1440-column axis). That is over-coverage, not corruption — the duplicates sit
 * at opposite ends of the unwrapped axis, which stays strictly ascending and
 * evenly spaced — and it is preferred to shrinking a view that asked for it.
 *
 * @param {{lonMin: number, lonMax: number}} box - View rectangle, degrees.
 * @returns {?{crossesDateline: boolean, ranges: Array<{start: number, end: number}>}}
 *   Inclusive axis index ranges (1 or 2, west-to-east in travel order), or null
 *   if either bound is non-finite. Refuses nothing else: every finite box on
 *   Earth resolves.
 */
export function longitudeIndexRanges(box) {
  const lonMin = Number(box?.lonMin);
  const lonMax = Number(box?.lonMax);
  if (!Number.isFinite(lonMin) || !Number.isFinite(lonMax)) return null;
  const { lonOrigin, lonStep, lonCount } = GLOBAL_CURRENTS_AXES;

  if (lonMax - lonMin >= 360) {
    return { crossesDateline: false, ranges: [{ start: 0, end: lonCount - 1 }] };
  }
  const west = wrapLon180(lonMin);
  const east = wrapLon180(lonMax);
  const startIdx = coveringIndex(west, lonOrigin, lonStep, lonCount, false);
  const endIdx = coveringIndex(east, lonOrigin, lonStep, lonCount, true);
  if (east >= west) {
    return { crossesDateline: false, ranges: [{ start: startIdx, end: endIdx }] };
  }
  return {
    crossesDateline: true,
    ranges: [
      { start: startIdx, end: lonCount - 1 },
      { start: 0, end: endIdx },
    ],
  };
}

/**
 * Column counts for one stride, honouring cross-seam phase continuity.
 * @param {Array<{start: number, end: number}>} ranges - From `longitudeIndexRanges`.
 * @param {number} stride - Positive integer.
 * @returns {Array<{start: number, end: number, count: number}>} Per-segment
 *   plans; a trailing segment may have count 0 when the stride steps past it.
 */
function planLongitudeSegments(ranges, stride) {
  const { lonCount } = GLOBAL_CURRENTS_AXES;
  const out = [];
  const first = ranges[0];
  const nWest = Math.floor((first.end - first.start) / stride) + 1;
  out.push({ start: first.start, end: first.start + (nWest - 1) * stride, count: nWest });
  if (ranges.length === 1) return out;
  // Continue the single arithmetic progression across the seam: the next index
  // after the last western one is first.start + stride*nWest, minus one full
  // revolution of the axis. Because nWest is the first count that steps past
  // lonCount-1, this lands in [0, stride) — never negative, never past the end.
  const eastStart = first.start + stride * nWest - lonCount;
  const second = ranges[1];
  if (eastStart > second.end) {
    out.push({ start: eastStart, end: eastStart, count: 0 });
    return out;
  }
  const nEast = Math.floor((second.end - eastStart) / stride) + 1;
  out.push({ start: eastStart, end: eastStart + (nEast - 1) * stride, count: nEast });
  return out;
}

/**
 * Pick the finest ERDDAP stride whose fetched grid fits a cell budget, and
 * report the grid it produces.
 *
 * The cell count is non-increasing in the stride, so the smallest stride that
 * fits is also the one that "lands nearest under the budget". Latitude bounds
 * are clamped to the axis (a ±90 request is legal and yields all 720 rows);
 * longitude is resolved through `longitudeIndexRanges`, so a dateline-crossing
 * box comes back as two segments on one stride phase. Segment bounds are exact
 * grid-center coordinates, ready to hand to `buildGlobalCurrentsUrl`.
 *
 * Refuses (returns null) a box with non-finite bounds, `latMin > latMax`, or a
 * budget that is not a finite number ≥ 1. It never refuses for being too small:
 * a budget below the coarsest possible grid still yields a 1–2 cell plan, on the
 * principle that one honest vector beats a blank ocean.
 *
 * The returned `crossesDateline` describes what will actually be FETCHED, not
 * what was asked: at a stride coarse enough to step clean over a thin eastern
 * overhang, that segment carries no sampled column, is dropped, and the plan
 * comes back with one segment and `crossesDateline: false`. The grid is then
 * narrower than the request — honest data over a smaller rectangle, rather than
 * a column at the wrong phase.
 *
 * @param {{latMin: number, latMax: number, lonMin: number, lonMax: number}} box
 *   View rectangle, degrees. `lonMin`/`lonMax` may cross ±180.
 * @param {number} [targetCells=DEFAULT_TARGET_CELLS] - Cell budget; clamped to
 *   [1, MAX_TARGET_CELLS].
 * @returns {?{stride: number, cellSizeDeg: number, nLat: number, nLon: number,
 *   cells: number, crossesDateline: boolean, targetCells: number,
 *   segments: Array<{latMin: number, latMax: number, lonMin: number,
 *   lonMax: number, nLat: number, nLon: number}>}}
 */
export function chooseStride(box, targetCells = DEFAULT_TARGET_CELLS) {
  const latMin = Number(box?.latMin);
  const latMax = Number(box?.latMax);
  if (!Number.isFinite(latMin) || !Number.isFinite(latMax) || latMin > latMax) return null;
  if (!Number.isFinite(targetCells) || targetCells < 1) return null;
  const lon = longitudeIndexRanges(box);
  if (!lon) return null;

  const budget = Math.min(Math.floor(targetCells), MAX_TARGET_CELLS);
  const { latOrigin, latStep, latCount, lonOrigin, lonStep, lonCount } = GLOBAL_CURRENTS_AXES;
  const latStart = coveringIndex(latMin, latOrigin, latStep, latCount, false);
  const latEnd = coveringIndex(latMax, latOrigin, latStep, latCount, true);
  const latSpan = latEnd - latStart;

  // cells(s) = nLat(s)·nLon(s) is non-increasing in s, so scanning upward and
  // stopping at the first fit returns the finest grid within budget. Both
  // factors are floor-of-a-quotient counts: nLat(s) = floor(latSpan/s) + 1 and,
  // because the two dateline segments are ONE progression cut at the axis end,
  // nLon(s) = floor((span − 1)/s) + 1 with span the total number of axis
  // columns in the wrapped range. That identity was checked exhaustively
  // against `planLongitudeSegments` over 329 (box, stride) pairs, including the
  // case where the progression steps clean over the eastern segment.
  // The cap guarantees termination: at stride = max(latSpan, lonCount) the plan
  // is one row by at most two columns.
  const maxStride = Math.max(1, latSpan, lonCount);
  let stride = maxStride;
  let plan = null;
  for (let s = 1; s <= maxStride; s += 1) {
    const nLat = Math.floor(latSpan / s) + 1;
    const segs = planLongitudeSegments(lon.ranges, s);
    const nLon = segs.reduce((sum, seg) => sum + seg.count, 0);
    if (nLat * nLon <= budget) {
      stride = s;
      plan = segs;
      break;
    }
    if (s === maxStride) {
      stride = s;
      plan = segs;
    }
  }

  const nLat = Math.floor(latSpan / stride) + 1;
  const segments = [];
  for (const seg of plan) {
    if (seg.count === 0) continue;
    segments.push({
      latMin: axisValue(latStart, latOrigin, latStep),
      latMax: axisValue(latStart + (nLat - 1) * stride, latOrigin, latStep),
      lonMin: axisValue(seg.start, lonOrigin, lonStep),
      lonMax: axisValue(seg.end, lonOrigin, lonStep),
      nLat,
      nLon: seg.count,
    });
  }
  const nLon = segments.reduce((sum, seg) => sum + seg.nLon, 0);
  return {
    stride,
    cellSizeDeg: stride * lonStep,
    nLat,
    nLon,
    cells: nLat * nLon,
    crossesDateline: segments.length > 1,
    targetCells: budget,
    segments,
  };
}

/** Extensions ERDDAP griddap serves that this module is willing to name. */
const ALLOWED_EXTS = new Set(['csv0', 'csv', 'csvp', 'json', 'nc', 'htmlTable']);

/**
 * Build the griddap URL for ONE non-crossing segment. Pure.
 *
 * Emits `u_current` before `v_current`, which is the column order
 * `parseGlobalCurrentsCsv0` assumes; the two functions are a matched pair and a
 * hand-rolled URL with the variables reversed will parse into silently swapped
 * components.
 *
 * Refuses, by throwing, anything that would produce a URL whose response shape
 * is not predictable: a non-finite bound, `latMin > latMax`, a longitude range
 * that crosses ±180 (split it with `chooseStride` first), a stride that is not a
 * positive integer, an unparseable time, or an extension outside the allowlist.
 * Throwing rather than returning null is deliberate: these inputs come from
 * `chooseStride`, so reaching them is a programming error, not bad user data.
 *
 * @param {Object} options
 * @param {{latMin: number, latMax: number, lonMin: number, lonMax: number}} options.box
 *   Segment bounds in degrees, ideally exact grid centers from `chooseStride`.
 * @param {string} options.timeIso - Time constraint; any string `Date.parse`
 *   accepts, re-emitted as `YYYY-MM-DDTHH:MM:SSZ`.
 * @param {number} [options.stride=1] - ERDDAP stride, applied to both spatial axes.
 * @param {string} [options.ext='csv0'] - Response format.
 * @returns {string} Fully encoded URL.
 */
export function buildGlobalCurrentsUrl({ box, timeIso, stride = 1, ext = 'csv0' } = {}) {
  const latMin = Number(box?.latMin);
  const latMax = Number(box?.latMax);
  const lonMin = Number(box?.lonMin);
  const lonMax = Number(box?.lonMax);
  for (const [name, value] of [['latMin', latMin], ['latMax', latMax], ['lonMin', lonMin], ['lonMax', lonMax]]) {
    if (!Number.isFinite(value)) throw new Error(`globalCurrents: ${name} must be finite, got ${box?.[name]}`);
  }
  if (latMin > latMax) throw new Error(`globalCurrents: latMin ${latMin} > latMax ${latMax}`);
  if (lonMin > lonMax) {
    throw new Error(
      `globalCurrents: lonMin ${lonMin} > lonMax ${lonMax} — a dateline-crossing box must be split `
      + 'into two segments by chooseStride() before building a URL',
    );
  }
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(`globalCurrents: stride must be a positive integer, got ${stride}`);
  }
  if (!ALLOWED_EXTS.has(ext)) throw new Error(`globalCurrents: unsupported ext "${ext}"`);
  const t = Date.parse(timeIso);
  if (!Number.isFinite(t)) throw new Error(`globalCurrents: unparseable timeIso "${timeIso}"`);
  const stamp = isoStamp(t);

  const { id, server, uVar, vVar } = GLOBAL_CURRENTS_DATASET;
  // Time is always a single step, so its stride is fixed at 1.
  const dims = `[(${stamp}):1:(${stamp})]`
    + `[(${formatCoord(latMin)}):${stride}:(${formatCoord(latMax)})]`
    + `[(${formatCoord(lonMin)}):${stride}:(${formatCoord(lonMax)})]`;
  const query = `${uVar}${dims},${vVar}${dims}`;
  // Only the brackets need escaping; ERDDAP's own documented examples use raw
  // colons, parentheses and commas, and escaping them breaks the constraint parser.
  return `${server}/griddap/${id}.${ext}?${query.replace(/\[/g, '%5B').replace(/\]/g, '%5D')}`;
}

/**
 * Parse a `.csv0` COORDINATE field strictly. Never substitutes a number for a
 * missing token: `Number('')` and `Number(' ')` are both 0, so parsing a blank
 * latitude/longitude with `Number` alone would silently place the row at the
 * equator or the prime meridian instead of rejecting the body. Callers treat
 * the NaN this returns as "reject the whole response".
 * @param {string|undefined} token - Raw CSV field.
 * @returns {number} Degrees, or NaN if the token is absent, blank, or not a
 *   finite number.
 */
function parseCoord(token) {
  if (typeof token !== 'string') return NaN;
  const s = token.trim();
  if (s === '') return NaN;
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
}

/**
 * Parse one numeric `.csv0` field, mapping every flavour of "no data" to NaN.
 * @param {string|undefined} token
 * @returns {number}
 */
function parseValue(token) {
  if (token == null) return NaN;
  const s = token.trim();
  if (s === '' || s === 'NaN' || s === 'null') return NaN;
  const x = Number(s);
  if (!Number.isFinite(x)) return NaN;
  // Catches both the raw _FillValue (−214748.3648) and any corrupt spike.
  if (Math.abs(x) > GLOBAL_CURRENTS_DATASET.maxSpeedMs) return NaN;
  return x;
}

/**
 * Parse a headerless griddap `.csv0` body into a dense row-major grid.
 *
 * The axes are RECONSTRUCTED from the coordinates actually returned — the
 * distinct latitude and longitude values in the body, sorted ascending — never
 * from what was requested, because ERDDAP snaps constraints to its own axis and
 * may return a range wider or narrower than asked. Rows are placed by looking
 * their coordinates up in those reconstructed axes, so the result is correct
 * even if the server ever changes its emission order.
 *
 * Returns null — never a partially-filled grid — on any shape drift: an empty
 * or non-string body, an ERDDAP error payload, a row with fewer than five
 * columns, a blank or non-numeric coordinate, a row count that is not exactly
 * nLat × nLon, or two rows claiming the same cell. A caller must treat null as
 * a failed fetch, never as ocean with no current in it.
 *
 * Component values outside ±`GLOBAL_CURRENTS_DATASET.maxSpeedMs` become NaN;
 * this is what turns the `_FillValue` into a hole if ERDDAP ever stops
 * rendering it as the token `NaN`. Components are kept in step: a cell whose u
 * or v is missing has BOTH written as NaN, because a one-component vector has
 * no direction and must not be drawn as an axis-aligned one.
 *
 * @param {string} text - Response body, columns `time,lat,lon,u,v`.
 * @returns {?{lats: Float64Array, lons: Float64Array, u: Float32Array,
 *   v: Float32Array, finite: number, total: number, timeIso: ?string}}
 *   `u[i * lons.length + j]` is the eastward component at `lats[i]`, `lons[j]`.
 *   `finite` counts cells where BOTH components are finite; `timeIso` is the
 *   single time stamp present, or null if the body mixes several.
 */
export function parseGlobalCurrentsCsv0(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim();
  if (body === '') return null;
  // ERDDAP reports failures as an `Error { code=...; message=...; }` block with
  // a non-2xx status, and misconfigured proxies can hand back HTML.
  if (body.startsWith('Error') || body.startsWith('<')) return null;

  const lines = body.split(/\r?\n/);
  const rows = [];
  const latSet = new Set();
  const lonSet = new Set();
  const times = new Set();
  for (const line of lines) {
    if (line.trim() === '') continue;
    const parts = line.split(',');
    if (parts.length < COL_COUNT) return null;
    const lat = parseCoord(parts[COL_LAT]);
    const lon = parseCoord(parts[COL_LON]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    latSet.add(lat);
    lonSet.add(lon);
    times.add(parts[COL_TIME].trim());
    rows.push({ lat, lon, u: parseValue(parts[COL_U]), v: parseValue(parts[COL_V]) });
  }
  if (rows.length === 0) return null;

  const lats = Float64Array.from([...latSet].sort((a, b) => a - b));
  const lons = Float64Array.from([...lonSet].sort((a, b) => a - b));
  const nLat = lats.length;
  const nLon = lons.length;
  const total = nLat * nLon;
  if (rows.length !== total) return null;

  const latIndex = new Map();
  for (let i = 0; i < nLat; i += 1) latIndex.set(lats[i], i);
  const lonIndex = new Map();
  for (let j = 0; j < nLon; j += 1) lonIndex.set(lons[j], j);

  const u = new Float32Array(total).fill(NaN);
  const v = new Float32Array(total).fill(NaN);
  const seen = new Uint8Array(total);
  let finite = 0;
  for (const row of rows) {
    const idx = latIndex.get(row.lat) * nLon + lonIndex.get(row.lon);
    if (seen[idx]) return null; // duplicate cell: the grid is not rectangular
    seen[idx] = 1;
    // A current vector needs BOTH components: a cell with a finite u and a
    // missing v has no direction, and letting it through would let a renderer
    // draw a purely eastward arrow where the dataset said nothing. Half a
    // vector is therefore no vector, which also makes `finite` exactly the
    // count of cells a streakline integrator can step through.
    const usable = Number.isFinite(row.u) && Number.isFinite(row.v);
    u[idx] = usable ? row.u : NaN;
    v[idx] = usable ? row.v : NaN;
    if (usable) finite += 1;
  }

  let timeIso = null;
  if (times.size === 1) {
    const t = Date.parse([...times][0]);
    if (Number.isFinite(t)) timeIso = isoStamp(t);
  }
  return { lats, lons, u, v, finite, total, timeIso };
}

/**
 * Stitch the two halves of a dateline-crossing fetch into one grid.
 *
 * `west` holds the high longitudes (up to +179.875) and `east` the low ones
 * (from −179.875); the eastern longitudes are unwrapped by +360 so the joined
 * axis is strictly ascending and evenly spaced across the seam. The result's
 * longitudes therefore exceed 180 — this is the honest representation of a
 * rectangle that crosses the antimeridian, and sampling code must wrap its
 * query longitude into the same frame.
 *
 * Returns null if the halves cannot belong to one grid: either argument
 * missing or not shaped like a parsed grid, differing latitude axes, a payload
 * whose length disagrees with its own axes, or a seam gap that is not one
 * stride — all of which mean a phase error upstream, and none of which may be
 * papered over by concatenating anyway. It returns null rather than throwing
 * even for a malformed argument, because the caller's next move is identical in
 * every case: report the fetch as failed.
 *
 * @param {?{lats: Float64Array, lons: Float64Array, u: Float32Array,
 *   v: Float32Array, finite: number, timeIso: ?string}} west - Parsed grid for
 *   the western segment, from `parseGlobalCurrentsCsv0`.
 * @param {?{lats: Float64Array, lons: Float64Array, u: Float32Array,
 *   v: Float32Array, finite: number, timeIso: ?string}} east - Ditto, eastern.
 * @param {number} stepDeg - Expected column spacing, degrees (stride × 0.25).
 * @returns {?{lats: Float64Array, lons: Float64Array, u: Float32Array,
 *   v: Float32Array, finite: number, total: number, timeIso: ?string}}
 */
export function stitchGlobalCurrents(west, east, stepDeg) {
  if (!west || !east || !Number.isFinite(stepDeg) || stepDeg <= 0) return null;
  // Shape the arguments before indexing them: a half built by hand elsewhere
  // must come back as null, not as a TypeError from `undefined.length` or a
  // RangeError from a short `set()`.
  for (const half of [west, east]) {
    if (typeof half.lats?.length !== 'number' || typeof half.lons?.length !== 'number') return null;
    // The payloads are copied row-by-row with subarray(), so they have to be
    // the typed arrays `parseGlobalCurrentsCsv0` produces, not plain arrays.
    if (typeof half.u?.subarray !== 'function' || typeof half.v?.subarray !== 'function') return null;
  }
  const nLat = west.lats.length;
  if (east.lats.length !== nLat) return null;
  for (let i = 0; i < nLat; i += 1) {
    if (Math.abs(west.lats[i] - east.lats[i]) > COORD_EPS) return null;
  }
  const nWest = west.lons.length;
  const nEast = east.lons.length;
  if (nWest === 0 || nEast === 0) return null;
  if (west.u.length !== nLat * nWest || west.v.length !== nLat * nWest) return null;
  if (east.u.length !== nLat * nEast || east.v.length !== nLat * nEast) return null;
  const seam = (east.lons[0] + 360) - west.lons[nWest - 1];
  if (Math.abs(seam - stepDeg) > COORD_EPS) return null;

  const nLon = nWest + nEast;
  const lons = new Float64Array(nLon);
  lons.set(west.lons, 0);
  for (let j = 0; j < nEast; j += 1) lons[nWest + j] = east.lons[j] + 360;

  const total = nLat * nLon;
  const u = new Float32Array(total);
  const v = new Float32Array(total);
  for (let i = 0; i < nLat; i += 1) {
    const dst = i * nLon;
    u.set(west.u.subarray(i * nWest, (i + 1) * nWest), dst);
    v.set(west.v.subarray(i * nWest, (i + 1) * nWest), dst);
    u.set(east.u.subarray(i * nEast, (i + 1) * nEast), dst + nWest);
    v.set(east.v.subarray(i * nEast, (i + 1) * nEast), dst + nWest);
  }
  return {
    lats: Float64Array.from(west.lats),
    lons,
    u,
    v,
    finite: west.finite + east.finite,
    total,
    timeIso: west.timeIso === east.timeIso ? west.timeIso : null,
  };
}

/**
 * Wire an abort signal that fires on the caller's signal or on a timeout.
 * @param {?AbortSignal} signal
 * @param {number} timeoutMs
 * @returns {{signal: AbortSignal, release: Function}}
 */
function abortAfter(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`globalCurrents: upstream timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Fetch a URL as text, enforcing HTTP success and the proxy's byte cap.
 * Throws with the status and a body excerpt so an ERDDAP `Error {…}` block
 * reaches the log instead of being flattened into "fetch failed".
 * @param {string} url
 * @param {Function} fetchImpl
 * @param {?AbortSignal} signal
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function fetchText(url, fetchImpl, signal, timeoutMs) {
  const gate = abortAfter(signal, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: gate.signal,
      headers: {
        Accept: 'text/csv, text/plain, */*',
        // Omitting this earns a 403 HTML page from coastwatch.noaa.gov.
        'User-Agent': GLOBAL_CURRENTS_USER_AGENT,
      },
    });
    // Success must be asserted, not assumed: an object with no `ok` field is a
    // broken fetch impl, and treating it as a 200 would hand `undefined` to the
    // parser and surface as "empty ocean" rather than as the wiring bug it is.
    if (!response || typeof response.text !== 'function' || typeof response.ok !== 'boolean') {
      throw new Error(`globalCurrents: fetchImpl returned no usable response for ${url}`);
    }
    if (!response.ok) {
      throw new Error(`globalCurrents: HTTP ${response.status ?? 'unknown status'} from ${url}`);
    }
    const text = await response.text();
    if (typeof text !== 'string') {
      throw new Error(`globalCurrents: non-text response body from ${url}`);
    }
    // `.csv0` for this dataset is pure ASCII (ISO stamps, digits, signs, dots,
    // commas, "NaN"), so character length is byte length.
    if (text.length > RESPONSE_BYTE_CAP) {
      throw new Error(
        `globalCurrents: response ${text.length} B exceeds the ${RESPONSE_BYTE_CAP} B cap — `
        + 'lower targetCells',
      );
    }
    return text;
  } finally {
    gate.release();
  }
}

/**
 * Probe the dataset's most recent time step.
 *
 * Issues `<dataset>.csv0?time[(last)]`, which returns a single ISO stamp. The
 * result is deliberately NOT cached here: the caller owns the cache policy (the
 * dataset updates once a day, so a multi-hour TTL is appropriate), this function
 * only reports what the server says and how old it is.
 *
 * Returns null on any failure — HTTP error, empty body, unparseable stamp — so
 * a caller can fall back to a previously cached stamp instead of fetching a
 * grid for a time that does not exist. Cancellation and timeout are failures
 * too and also yield null, so a caller that passes a `signal` must re-check
 * `signal.aborted` on a null result rather than blaming the dataset
 * (`fetchGlobalCurrents` does exactly that).
 *
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl=fetch] - Injectable fetch.
 * @param {number} [options.nowMs=Date.now()] - Reference time for `ageMs`.
 * @param {?AbortSignal} [options.signal=null] - Caller cancellation.
 * @param {number} [options.timeoutMs=20000] - Per-request timeout.
 * @returns {Promise<?{timeIso: string, validAtMs: number, ageMs: number, url: string}>}
 */
export async function latestTimeIso({
  fetchImpl = (...args) => fetch(...args),
  nowMs = Date.now(),
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const { server, id } = GLOBAL_CURRENTS_DATASET;
  const url = `${server}/griddap/${id}.csv0?time%5B(last)%5D`;
  let text;
  try {
    text = await fetchText(url, fetchImpl, signal, timeoutMs);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const first = text.trim().split(/\r?\n/)[0]?.trim();
  if (!first || first.startsWith('Error') || first.startsWith('<')) return null;
  const validAtMs = Date.parse(first);
  if (!Number.isFinite(validAtMs)) return null;
  return {
    timeIso: isoStamp(validAtMs),
    validAtMs,
    ageMs: nowMs - validAtMs,
    url,
  };
}

/**
 * Common spacing of a reconstructed axis, with a uniformity check.
 *
 * A single number can only describe the resolution of a grid whose axis is
 * evenly spaced, so this reports the step and refuses to guess one otherwise.
 *
 * @param {Float64Array} axis - Strictly ascending axis values, degrees.
 * @returns {?number} The common step in degrees; NaN when the axis has fewer
 *   than two points, so no spacing is observable; null when the axis is not
 *   uniform, which callers must treat as a corrupt grid rather than round off.
 */
function axisStep(axis) {
  if (axis.length < 2) return NaN;
  const step = axis[1] - axis[0];
  // Every axis value on this grid is an exact multiple of 1/8 deg, so the
  // differences are exact in binary floating point; the tolerance only covers a
  // future dataset whose axis is not.
  const tol = Math.max(Math.abs(step) * 1e-6, COORD_EPS);
  for (let i = 1; i < axis.length; i += 1) {
    if (Math.abs((axis[i] - axis[i - 1]) - step) > tol) return null;
  }
  return step;
}

/**
 * Fetch the global surface-current field for a view rectangle, normalized.
 *
 * Resolves the newest time step (unless one is supplied), picks a stride under
 * the cell budget, issues one request per longitude segment — two when the box
 * crosses ±180 — parses each and stitches them, and returns the grid together
 * with a source report a UI can put on screen without inventing anything.
 *
 * Throws rather than returning an empty grid whenever the field cannot be
 * trusted: an unusable box, no resolvable time step, an HTTP failure, a body
 * over the response cap, a body whose shape drifted, a body carrying no single
 * time stamp, a served axis that is not uniformly spaced, or a seam that will
 * not stitch. A caller cancellation is re-thrown as the caller's own abort
 * reason, not disguised as an upstream failure. The one thing it will never do
 * is report ocean where it has no data.
 *
 * Everything in `source` that describes the data describes what the SERVER
 * returned, never what was requested: `validAtMs`/`ageMs` come from the time
 * stamp in the response body (ERDDAP snaps a `(t)` constraint to its nearest
 * time step, so asking for a stamp off the daily axis returns a different day)
 * and `resolutionDeg` from the returned axis spacing. `requestedTimeIso` and
 * `stride` are kept beside them as the request side of the pair.
 *
 * @param {Object} options
 * @param {{latMin: number, latMax: number, lonMin: number, lonMax: number}} options.box
 *   View rectangle, degrees; `lonMin`/`lonMax` may cross ±180.
 * @param {number} [options.targetCells=DEFAULT_TARGET_CELLS] - Cell budget.
 * @param {Function} [options.fetchImpl=fetch] - Injectable fetch.
 * @param {?string} [options.timeIso=null] - Time step to fetch; probed when null.
 * @param {number} [options.nowMs=Date.now()] - Reference time for `ageMs`.
 * @param {?AbortSignal} [options.signal=null] - Caller cancellation.
 * @param {number} [options.timeoutMs=20000] - Per-request timeout.
 * @returns {Promise<{lats: Float64Array, lons: Float64Array, u: Float32Array,
 *   v: Float32Array, finite: number, total: number, source: Object}>}
 *   `source` is `{datasetId, timeIso, requestedTimeIso, validAtMs, ageMs,
 *   resolutionDeg, nativeResolutionDeg, stride, cells, coverage, label,
 *   attribution, license, url, urls, crossesDateline}`; `coverage` is
 *   finite/total, i.e. the fraction of the fetched rectangle carrying a
 *   two-component vector, and `url` is `urls[0]`.
 */
export async function fetchGlobalCurrents({
  box,
  targetCells = DEFAULT_TARGET_CELLS,
  fetchImpl = (...args) => fetch(...args),
  timeIso = null,
  nowMs = Date.now(),
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const plan = chooseStride(box, targetCells);
  if (!plan) throw new Error('globalCurrents: unusable view rectangle or cell budget');

  let stamp = timeIso;
  let requestedAtMs = timeIso ? Date.parse(timeIso) : NaN;
  if (!stamp) {
    const probe = await latestTimeIso({ fetchImpl, nowMs, signal, timeoutMs });
    if (!probe) {
      // `latestTimeIso` flattens every failure to null, cancellation included.
      // Re-throw the caller's own abort reason instead of reporting a dataset
      // outage: a camera move is not a CoastWatch problem, and the caller needs
      // to be able to tell the two apart.
      if (signal?.aborted) throw signal.reason ?? new Error('globalCurrents: aborted');
      throw new Error('globalCurrents: could not resolve the dataset\'s latest time step');
    }
    stamp = probe.timeIso;
    requestedAtMs = probe.validAtMs;
  }
  if (!Number.isFinite(requestedAtMs)) throw new Error(`globalCurrents: unparseable timeIso "${timeIso}"`);

  const urls = plan.segments.map((segment) => buildGlobalCurrentsUrl({
    box: segment,
    timeIso: stamp,
    stride: plan.stride,
    ext: 'csv0',
  }));
  const bodies = await Promise.all(urls.map((url) => fetchText(url, fetchImpl, signal, timeoutMs)));
  const grids = bodies.map((text, i) => {
    const grid = parseGlobalCurrentsCsv0(text);
    if (!grid) throw new Error(`globalCurrents: unparseable or shape-drifted response from ${urls[i]}`);
    return grid;
  });

  let grid;
  if (grids.length === 1) {
    [grid] = grids;
  } else {
    grid = stitchGlobalCurrents(grids[0], grids[1], plan.cellSizeDeg);
    if (!grid) throw new Error('globalCurrents: dateline halves do not stitch into one grid');
  }

  // Report the time the server actually served. ERDDAP snaps `(t)` to its
  // nearest time step, so a stamp that is not exactly on the daily axis comes
  // back as a neighbouring day's field; reporting the requested stamp would
  // understate the age of what is on screen. A body with no single parseable
  // stamp is shape drift, not licence to fall back on the request.
  const validAtMs = grid.timeIso ? Date.parse(grid.timeIso) : NaN;
  if (!Number.isFinite(validAtMs)) {
    throw new Error('globalCurrents: response carries no single parseable time stamp');
  }
  // Same rule for the resolution: measure the axis that came back rather than
  // repeating the stride we asked for. A non-uniform axis has no single
  // resolution at all, and a renderer that assumed one would smear the field.
  const latStepDeg = axisStep(grid.lats);
  const lonStepDeg = axisStep(grid.lons);
  if (latStepDeg === null || lonStepDeg === null) {
    throw new Error('globalCurrents: the served grid axes are not uniformly spaced');
  }
  // A degenerate 1-column or 1-row grid shows no spacing; fall back to the
  // other axis, then to the plan, which is the only thing left that knows one.
  const servedResolutionDeg = Number.isFinite(lonStepDeg) ? lonStepDeg
    : (Number.isFinite(latStepDeg) ? latStepDeg : plan.cellSizeDeg);

  const { id, resolutionDeg, label, attribution, license } = GLOBAL_CURRENTS_DATASET;
  return {
    lats: grid.lats,
    lons: grid.lons,
    u: grid.u,
    v: grid.v,
    finite: grid.finite,
    total: grid.total,
    source: {
      datasetId: id,
      /** Stamp carried by the response body — the field actually on screen. */
      timeIso: grid.timeIso,
      /** Stamp asked for; differs from `timeIso` when ERDDAP snapped it. */
      requestedTimeIso: isoStamp(requestedAtMs),
      validAtMs,
      ageMs: nowMs - validAtMs,
      resolutionDeg: servedResolutionDeg,
      nativeResolutionDeg: resolutionDeg,
      stride: plan.stride,
      cells: grid.total,
      coverage: grid.total > 0 ? grid.finite / grid.total : 0,
      label,
      attribution,
      license,
      crossesDateline: plan.crossesDateline,
      url: urls[0],
      urls,
    },
  };
}
