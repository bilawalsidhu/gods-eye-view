/**
 * @file Global base tier of the animated surface-current field, served from the
 * US Navy's HYCOM ESPC-D-V02 global ocean forecast over OPeNDAP. This is the
 * replacement for the altimetry tier in `./globalCurrents.js`, and it exists
 * because those two products are not the same physical quantity:
 * `noaacwBLENDEDNRTcurrentsDaily` carries ABSOLUTE GEOSTROPHIC velocity derived
 * from sea-surface height — no Ekman (wind-driven) component, no tides, an
 * effective resolved wavelength around 300 km, and a multi-day publication lag.
 * ESPC-D-V02 is a full primitive-equation model (HYCOM 2.2.99 coupled to CICE
 * 5.1.2) that carries tides and wind-driven flow, runs on a 0.08 deg grid, and
 * publishes a forecast. Where the altimetry tier draws a smooth gyre, this tier
 * draws the flow a drifter would actually sit in.
 *
 * Its contract is the contract of the tier it replaces: return an honest grid
 * for any box on Earth, or fail loudly. Never return an empty grid that a
 * renderer would draw as "still ocean".
 *
 * DATASET GEOMETRY (read 2026-09-01 from the dataset's own `.das`/`.dds`;
 * re-read them before changing any number here):
 *   time      Float64[121]   3-hourly, `hours since <run epoch>` — SEE "TIME"
 *   depth     Float64[40]    m, positive down; depth[0] = 0.0, the true surface
 *   lat       Float64[4251]  -80.0 … 90.0, uniform 0.04 deg
 *   lon       Float64[4500]  0.0 … 359.92, uniform 0.08 deg, 0-360 CONVENTION
 *   water_u, water_v  Float32[time][depth][lat][lon], m/s, standard_name
 *                     {eastward,northward}_sea_water_velocity,
 *                     actual_range u ∈ [-5.1330004, 4.5990005],
 *                                  v ∈ [-5.05, 4.262]
 * The grid is `glby0.08` — 0.08 deg zonally but 0.04 deg meridionally, so its
 * cells are ANISOTROPIC in degrees (about 8.9 km x 4.4 km at the equator). One
 * stride applied to both axes therefore preserves that 2:1 shape rather than
 * squaring it; see `HYCOM_DATASET.resolutionDeg` for which of the two numbers
 * this module reports upward and why.
 *
 * There is no `ssu`/`ssv` surface-only companion dataset — the surface field is
 * `depth[0]` of the 3-D `uv3z` aggregation, and every request this module builds
 * pins `[0:1:0]` on the depth axis. `parseHycomAscii` re-checks the served depth
 * and refuses a body that came back at any other level, because silently drawing
 * the 30 m flow as the surface flow is exactly the substitution this module
 * exists to prevent.
 *
 * AXIS ARITHMETIC. Both axes are uniform, verified against served coordinates at
 * 4 N, 36 N, 48 N and 72 N and at the prime meridian, 100 E, 180 and 359.92 E:
 *     iLat = round((lat + 80) / 0.04)                       lat = -80 + 0.04·i
 *     iLon = round((((lon % 360) + 360) % 360) / 0.08)       lon = 0.08·j
 * Neither 0.04 nor 0.08 is exactly representable in binary floating point, so
 * `(lat + 80) / 0.04` is not always an exact integer at a grid line: measured,
 * lat = -79.96 gives 1.0000000000001563, whose `Math.ceil` is 2 — an off-by-one
 * that would shift a whole fetched rectangle by one row. Every index derived
 * here therefore goes through `snapIndex`, which collapses a value within
 * `INDEX_SNAP_EPS` of an integer onto that integer before flooring or ceiling.
 *
 * LONGITUDE CONVENTION, and where the seam really is. This dataset numbers
 * longitude 0…359.92, unlike the altimetry product (-179.875…179.875) and
 * unlike the app's view boxes. The practical consequence is the opposite of the
 * one the altimetry tier deals with:
 *   - A box crossing the ANTIMERIDIAN is CONTIGUOUS in this index space.
 *     Verified live: lon[2248…2252] = 179.8399…, 179.9200…, 180.0, 180.0799…,
 *     180.1600… — 180 sits at index 2250, in the middle of the axis, with no
 *     discontinuity. Such a box needs no split at all.
 *   - A box crossing the PRIME MERIDIAN is the one that wraps, at index
 *     4499 → 0. That is the case this module fetches as two index ranges and
 *     stitches.
 * Both crossings are handled; neither is refused. `hycomLonSegments` places the
 * two ranges on ONE arithmetic progression of axis indices so the seam gap is
 * exactly one stride like every other gap, using the same construction and for
 * the same reason as `planLongitudeSegments` in `./globalCurrents.js`.
 *
 * OUTPUT LONGITUDE FRAME. The rest of the pipeline expects a strictly ascending
 * longitude axis anchored in [-180, 180), so `stitchHycomGrids` unwraps the
 * served 0-360 values into an ascending sequence and then shifts the whole axis
 * by -360 when its first value is at or beyond 180. Worked through:
 *   -122.48…-122.24  served 237.52…237.76      → shifted → -122.48…-122.24
 *   -10…+10          served 350…359.92 | 0…10  → unwrapped 350…370 → -10…+10
 *   170…-170 (east)  served 170…190            → left alone → 170…190
 * The last line is deliberate and matches `stitchGlobalCurrents`: a rectangle
 * that crosses the antimeridian has no representation as an ascending axis
 * inside [-180, 180), so the axis is allowed to continue past +180 and callers
 * sampling it must wrap their query longitude into the same frame. Every other
 * box lands wholly inside [-180, 180).
 *
 * TIME, AND WHY `ageMs` CAN BE NEGATIVE. The axis is 121 steps of 3 hours
 * (0, 3, … 360) counted from an epoch that MOVES with each model run — the
 * `.das` read on 2026-09-01 said `hours since 2026-08-23 12:00:00.000 UTC`,
 * with `NC_GLOBAL.created_on` 2026-08-30 05:41:19 — so the epoch is parsed from
 * the `.das` at run time by `parseHycomTimeEpoch` and never hardcoded. Note the
 * attribute's format: `YYYY-MM-DD HH:MM:SS.mmm UTC`, a space separator and a
 * trailing ` UTC`, which `Date.parse` does NOT accept; the parser normalizes it.
 * The span runs roughly -10 d to +5 d around now, so IT INCLUDES A FORECAST.
 * `chooseHycomTimeIndex` picks the step NEAREST the requested instant and
 * clamps to the axis, so for `atMs = now` the served step can be up to 1.5 h in
 * the FUTURE, and a caller passing a future `atMs` gets a step further ahead
 * still. Consequences, all deliberate:
 *   - `ageMs` is reported as `nowMs - validAtMs` and is therefore NEGATIVE for a
 *     forecast step. It is NOT clamped to zero. Clamping would render a
 *     forecast indistinguishable from a just-published analysis, which is the
 *     one thing a freshness number must never do.
 *   - `source.isForecast` and `source.forecastLeadMs` say so explicitly, so a
 *     caller does not have to infer it from the sign of a number.
 *   - Nearest-step is preferred to nearest-step-at-or-before-now because both
 *     come from the same model run: a step 1.5 h ahead is the same simulation's
 *     state, not an extrapolation, and it is closer to the requested instant
 *     than a 1.5 h-old one.
 * `validAtMs` is always computed from the time value the response ECHOES, not
 * from the index that was requested.
 *
 * WIRE FORMAT: OPeNDAP `.ascii`. Square brackets MUST be percent-encoded as
 * %5B/%5D. Both components are requested in ONE round trip
 * (`water_u[…],water_v[…]`), and the server answers with one block per variable
 * — but IN ITS OWN `.dds` DECLARATION ORDER, NOT THE QUERY ORDER. Verified
 * live: a request naming `water_u` first came back with the `water_v` block
 * first. `parseHycomAscii` therefore keys blocks by NAME and never by position;
 * a positional parser would silently transpose u and v and rotate the entire
 * field by 90 degrees. Each variable's block carries its own MAPS echo of the
 * time, depth, lat and lon coordinates actually served, and those echoed
 * coordinates are the ones used — never the requested ones. (This repo already
 * has a fix, `resolveServedAxes` in `vite.config.js`, about exactly that class
 * of bug.) Data rows are `[timeIdx][depthIdx][latIdx], v0, v1, … vN` running
 * across LONGITUDE, with the row index counting the OUTPUT rows 0…nLat-1 even
 * under a stride. Land and missing data arrive as the literal token `NaN`.
 *
 * The NCSS endpoint under `/thredds/ncss/` returns empty bodies for this
 * dataset and must not be used.
 *
 * MEASURED COST (2026-09-01, from this machine, both components in one
 * request). Latency is dominated by whether the server has the block cached,
 * not by how much data comes back:
 *   141x141 out, stride 4 (561x561 native), cold : 223,666 B in  9.97 s
 *   141x141 out, stride 4 (561x561 native), warm : 223,666 B in  1.22 s
 *   141x141 out, stride 1 (141x141 native)       : 215,691 B in  1.13 s
 *   141x141 out, stride 2 (281x281 native)       : 213,839 B in  0.71 s
 *   141x141 out, stride 8 (1121x1121 native)     : 296,399 B in  1.22 s
 *   95x100 out, stride 45 (WHOLE 4251x4500 grid) : 173,966 B in  4.55 s
 * The last line is the important one: a whole-globe view is servable, so this
 * tier does not have to refuse one. The 9.97 s cold read is what sizes
 * `HYCOM_TIMEOUT_MS`.
 *
 * Byte cost per cell, both components: 296,399 B / 19,881 cells = 14.9 B/cell
 * worst MEASURED (the mostly-ocean stride-8 box), against 11.25 B/cell for a
 * land-heavy box where `NaN` is only 3 characters. The DESIGN worst case is an
 * all-ocean box whose every value renders at full Float32 width — `-0.049000002`
 * is 12 characters, plus `, ` — giving 14 B per value and 28 B per cell. See
 * `HYCOM_RESPONSE_BYTE_CAP` for how the cap follows from that.
 *
 * LICENCE. The `.das` declares NO `license` attribute. What it does state, and
 * what `HYCOM_DATASET.license` quotes verbatim, is
 * `NC_GLOBAL.distribution_statement` = "Approved for public release;
 * distribution unlimited." with `classification_level` empty. That is a US
 * Government release statement, not a licence grant, and it is reported as such
 * rather than being upgraded to a claim of public domain that the server does
 * not make.
 *
 * This module is pure ESM with no dependencies and no Cesium/DOM access: the
 * Node-side proxy handler and the offline test suite import the same code, and
 * every network call goes through an injected `fetchImpl`.
 *
 * Sources:
 * - Dataset metadata (`units`, `actual_range`, `distribution_statement`,
 *   `institution`, `generating_model`, `grid_name`, `created_on`) read from
 *   https://tds.hycom.org/thredds/dodsC/FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd.das
 *   and the matching `.dds`, both fetched 2026-09-01.
 * - Axis extents, wire format, block ordering, NaN rendering, error payloads and
 *   every timing above measured live against the `.ascii` service on the same
 *   date.
 * - OPeNDAP constraint-expression / hyperslab syntax `[start:stride:stop]`, stop
 *   INCLUSIVE: OPeNDAP DAP2 User Guide, https://opendap.github.io/documentation/
 *   and the THREDDS Data Server OPeNDAP service documentation.
 * - CF time-coordinate `units` grammar ("<interval> since <datetime>"):
 *   CF Conventions v1.4 (the `Conventions` attribute this dataset declares),
 *   section 4.4 "Time Coordinate".
 *
 * @module server/ocean/hycomCurrents
 */

/**
 * Frozen description of the upstream dataset. Every field is transcribed from
 * the dataset's own `.das`/`.dds` on 2026-09-01, not from documentation about
 * it.
 *
 * `license` quotes `NC_GLOBAL.distribution_statement` verbatim. There is no
 * `license` attribute on this dataset; `licenseNote` records that absence so a
 * UI can attribute the data without implying terms the server never granted.
 * `label` is composed here rather than quoted, because the `.das` declares no
 * `title` either — its parts (`generating_model`, `grid_name`) are quoted.
 *
 * @const {Readonly<Object>}
 */
export const HYCOM_DATASET = Object.freeze({
  /** THREDDS OPeNDAP dataset base URL; append `.das`, `.dds` or `.ascii?…`. */
  base: 'https://tds.hycom.org/thredds/dodsC/FMRC_ESPC-D-V02_uv3z/FMRC_ESPC-D-V02_uv3z_best.ncd',
  /** Identifier reported upward; matches the aggregation name in the response trailer. */
  id: 'FMRC_ESPC-D-V02_uv3z_best',
  /** Eastward component variable, m/s. */
  uVar: 'water_u',
  /** Northward component variable, m/s. */
  vVar: 'water_v',
  /** Depth-axis index of the surface. `depth[0] = 0.0 m`, verified live. */
  surfaceDepthIndex: 0,
  /**
   * Meridional native spacing, degrees. This is the number reported as
   * `nativeResolutionDeg`, and `source.resolutionDeg` is likewise the served
   * MERIDIONAL step, because `fieldGrid.js` converts `resolutionDeg` to
   * kilometres with `metresPerDegLat`. The zonal spacing is twice this and is
   * reported separately as `source.resolutionLonDeg`.
   */
  resolutionDeg: 0.04,
  /** Zonal native spacing, degrees (`grid_name` glby0.08). */
  resolutionLonDeg: 0.08,
  /** Composed from `generating_model` and `grid_name`; the `.das` declares no title. */
  label:
    'Sea Surface Currents (Full Dynamics incl. Tides and Wind Drift), '
    + 'US Navy HYCOM ESPC-D V02 Global Ocean Forecast, glby0.08, 3-Hourly',
  /** `NC_GLOBAL.distribution_statement`, verbatim. NOT a licence grant. */
  license: 'Approved for public release; distribution unlimited.',
  /** Why `license` is a release statement and not a licence. */
  licenseNote:
    'The dataset declares no `license` attribute; this is '
    + '`NC_GLOBAL.distribution_statement`, with `classification_level` empty. '
    + 'A US Government public-release statement is not an explicit grant of '
    + 'reuse terms, so no such grant is claimed here.',
  /** `NC_GLOBAL.institution` — the string to put on a map credit. */
  attribution: 'US Navy Fleet Numerical Meteorology and Oceanography Center (FNMOC)',
  /** `NC_GLOBAL.generating_model`, verbatim. */
  generatingModel: 'ESPC-D V02: HYCOM 2.2.99, CICE 5.1.2, expt_03.1',
  /** `NC_GLOBAL.reference`, verbatim. */
  infoUrl: 'https://portal.fnmoc.navy.mil/',
  /**
   * Speed magnitude, m/s, beyond which a component is treated as corrupt and
   * mapped to NaN. A symmetric envelope over the dataset's own declared
   * `actual_range` values (u ∈ [-5.1330004, 4.5990005], v ∈ [-5.05, 4.262]),
   * rounded up to the next whole m/s. Deliberately WIDER than
   * `GLOBAL_CURRENTS_DATASET.maxSpeedMs = 5`, because this model resolves
   * western-boundary-current cores that the altimetry product smooths away and
   * its own metadata already reports a -5.133 m/s sample: a 5 m/s gate would
   * clip real signal out of the Gulf Stream and the Kuroshio.
   */
  maxSpeedMs: 6,
});

/**
 * Axis geometry, split out because the index arithmetic uses it constantly.
 * `value(i) = origin + i * step`, ascending, i ∈ [0, count). Longitude is in
 * the 0-360 convention and is MODULO: index `lonCount` is index 0 again.
 * @const {Readonly<Object>}
 */
export const HYCOM_AXES = Object.freeze({
  latOrigin: -80,
  latStep: 0.04,
  latCount: 4251,
  lonOrigin: 0,
  lonStep: 0.08,
  lonCount: 4500,
  /** Nominal time-step spacing, hours. Verified: time = 0, 3, 6 … 360. */
  timeStepHours: 3,
  /** Nominal time-axis length. Read back at run time; never assumed. */
  timeCount: 121,
});

/**
 * Default cell budget. At the design worst case of 28 B/cell (all-ocean, full
 * Float32 width, both components) this is ~560 kB, and at the worst MEASURED
 * 14.9 B/cell it is ~298 kB — both far under `HYCOM_RESPONSE_BYTE_CAP`. Matches
 * `DEFAULT_TARGET_CELLS` in `./globalCurrents.js` so swapping the tier does not
 * change the on-screen vector density.
 * @const {number}
 */
export const DEFAULT_TARGET_CELLS = 20000;

/**
 * Hard ceiling on any caller-supplied budget: ~840 kB at the design worst case.
 * A caller asking for more is clamped rather than refused, because a too-coarse
 * field still renders honestly while a truncated body does not.
 * @const {number}
 */
export const MAX_TARGET_CELLS = 30000;

/**
 * Response size this module refuses to parse, matching `OCEAN_MAX_RESPONSE_BYTES`
 * in `vite.config.js` so it fails with a useful message instead of letting the
 * proxy truncate a body mid-row.
 *
 * Headroom, derived from the measurements in the file header: the cap is 2 MiB
 * = 2,097,152 B; the largest body this module can ask for is
 * `MAX_TARGET_CELLS` = 30,000 cells, which at the DESIGN worst case of 28 B/cell
 * (every value rendering at the full 12-character Float32 width, plus `, `)
 * is 840,000 B, plus a MAPS coordinate echo of at most
 * 2 variables x (nLat + nLon) x ~19 B — under 12 kB for any grid this shape.
 * That is a factor of ~2.4 of headroom over the worst case the module can
 * generate, and a factor of ~4.7 over the worst 14.9 B/cell actually measured.
 * @const {number}
 */
export const HYCOM_RESPONSE_BYTE_CAP = 2 * 1024 * 1024;

/**
 * Per-request network timeout, ms. Sized from the measured 9.97 s cold-cache
 * read of a 561x561 native block: the server materializes an uncached block
 * before answering, and a timeout tighter than about 15 s would turn a first
 * visit to a region into a spurious outage while a warm re-read of the same
 * region returns in ~1.2 s.
 * @const {number}
 */
export const HYCOM_TIMEOUT_MS = 20000;

/**
 * Descriptive User-Agent, following the repo's `gods-eye-view-*-proxy/1.0`
 * convention (see the CelesTrak, Overpass and GBFS proxies in `vite.config.js`).
 * tds.hycom.org served 200 to Node's default undici User-Agent during probing,
 * unlike coastwatch.noaa.gov, so this is courtesy rather than a workaround —
 * but it is what lets an operator identify this traffic in an upstream log.
 * @const {string}
 */
export const HYCOM_USER_AGENT =
  'gods-eye-view-hycom-currents-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/**
 * Tolerance for collapsing a computed axis index onto an integer, in index
 * units. The measured worst offender is `(-79.96 + 80) / 0.04`, which evaluates
 * to 1.0000000000001563 — an error of 1.6e-13 index units. 1e-6 is seven orders
 * of magnitude above that and seven below the 1.0 that would merge two distinct
 * grid lines.
 * @const {number}
 */
const INDEX_SNAP_EPS = 1e-6;

/**
 * Coordinate comparison tolerance, degrees, for checking that two variables'
 * MAPS echoes describe the same grid and that a stitched seam has the right
 * gap.
 *
 * This is MUCH looser than the 2.5e-7 used in `./globalCurrents.js`, and it has
 * to be: that dataset's axis values are exact multiples of 1/8 deg, while these
 * arrive at Float32 precision. Measured on served longitudes 237.52001953125,
 * 237.5999755859375, 237.679931640625, 237.760009765625, the consecutive
 * spacings are 0.0799560546875, 0.0799560546875 and 0.080078125 — a spread of
 * 1.22e-4 deg on a nominal 0.08 deg step. A tolerance below that would reject
 * every real response as non-uniform. 1e-3 deg clears the observed spread by a
 * factor of 8 while still being 80x smaller than a single native cell, so a
 * genuinely missing or duplicated column (which shifts a gap by a whole 0.08)
 * is still caught.
 * @const {number}
 */
const COORD_EPS = 1e-3;

/** Milliseconds in one hour. */
const HOUR_MS = 3600000;

/** `.ascii` extensions this module is willing to name. */
const ALLOWED_EXTS = new Set(['ascii', 'dods', 'das', 'dds']);

/**
 * Clamp a number into an inclusive range.
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/**
 * Normalize a longitude into [0, 360), this dataset's own convention.
 * @param {number} lon - Degrees, any range.
 * @returns {number} Equivalent longitude in [0, 360), or NaN if not finite.
 */
export function norm360(lon) {
  if (!Number.isFinite(lon)) return NaN;
  const x = ((lon % 360) + 360) % 360;
  // `((-1e-15 % 360) + 360) % 360` is exactly 360 in IEEE-754, not 0: the sum
  // rounds up to 360 and the second modulo cannot bring it back. Returning 360
  // would put `hycomLonIndex` one past the end of the axis.
  return x === 360 ? 0 : x;
}

/**
 * Normalize a longitude into [-180, 180), the frame the rest of the pipeline
 * uses.
 * @param {number} lon - Degrees, any range.
 * @returns {number} Equivalent longitude in [-180, 180), or NaN if not finite.
 */
export function wrapLon180(lon) {
  if (!Number.isFinite(lon)) return NaN;
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/**
 * Collapse a computed index onto an integer when it is within `INDEX_SNAP_EPS`
 * of one. See `INDEX_SNAP_EPS` for the measured case that makes this necessary:
 * neither 0.04 nor 0.08 is exactly representable, so a coordinate sitting
 * exactly on a grid line can divide to 1.0000000000001563 and `Math.ceil` it to
 * the next row.
 * @param {number} raw - Index in real-valued form.
 * @returns {number} `raw`, or the nearest integer if it is within tolerance.
 */
function snapIndex(raw) {
  const nearest = Math.round(raw);
  return Math.abs(raw - nearest) <= INDEX_SNAP_EPS ? nearest : raw;
}

/**
 * Nearest latitude-axis index for a latitude, clamped to the axis.
 *
 * `iLat = round((lat + 80) / 0.04)`, verified against served coordinates: index
 * 2900 is 36.0 exactly, index 0 is -80.0 exactly, index 4250 is 90.0.
 *
 * @param {number} lat - Degrees north, nominally in [-80, 90].
 * @returns {number} Integer index in [0, 4250], or NaN if `lat` is not finite.
 *   A latitude outside the dataset's coverage (south of -80) clamps to the
 *   nearest edge rather than failing — the caller's box is intersected with the
 *   dataset's domain, and `chooseHycomStride` reports the rectangle actually
 *   fetched.
 */
export function hycomLatIndex(lat) {
  if (!Number.isFinite(lat)) return NaN;
  const { latOrigin, latStep, latCount } = HYCOM_AXES;
  const raw = snapIndex((lat - latOrigin) / latStep);
  return clamp(Math.round(raw), 0, latCount - 1);
}

/**
 * Nearest longitude-axis index for a longitude, in this dataset's 0-360
 * convention. The axis is MODULO, so no clamping is needed or wanted: -0.08
 * and 359.92 are the same meridian and both give index 4499.
 *
 * `iLon = round((((lon % 360) + 360) % 360) / 0.08)`, verified against served
 * coordinates: index 2969 is 237.52 (= -122.48), index 2250 is 180.0 exactly,
 * index 1250 is 100.0, index 4499 is 359.92.
 *
 * @param {number} lon - Degrees east, any range; -180…180 and 0…360 both work.
 * @returns {number} Integer index in [0, 4499], or NaN if `lon` is not finite.
 */
export function hycomLonIndex(lon) {
  if (!Number.isFinite(lon)) return NaN;
  const { lonStep, lonCount } = HYCOM_AXES;
  const raw = snapIndex(norm360(lon) / lonStep);
  // `round` at the top of the axis (lon just under 360) can land on lonCount;
  // that is index 0 one revolution on, not a point past the end.
  return Math.round(raw) % lonCount;
}

/**
 * Outward-covering axis index: the lowest index whose cell reaches `raw`, or the
 * highest, so the fetched grid always covers the caller's rectangle. Outward
 * (floor/ceil) rather than nearest, for the same reason `coveringIndex` in
 * `./globalCurrents.js` is: nearest-snapping can drop the edge cell of a
 * viewport and leave a strip where streaklines visibly die.
 * @param {number} raw - Real-valued index, pre-snap.
 * @param {boolean} upper - True for the upper edge (ceil), false for lower.
 * @returns {number} Integer index, unclamped and possibly outside the axis.
 */
function coveringIndex(raw, upper) {
  const snapped = snapIndex(raw);
  // `+ 0` normalizes the -0 that Math.ceil returns for snapped ∈ (-1, 0]; an
  // index of -0 is arithmetically harmless but `Object.is` and
  // `assert.deepStrictEqual` distinguish it from 0 in returned plan objects.
  return (upper ? Math.ceil(snapped) : Math.floor(snapped)) + 0;
}

/**
 * Eastward angular span of a view rectangle, degrees, in [0, 360].
 *
 * A box is read as spanning EASTWARD from `lonMin` to `lonMax`, matching
 * `longitudeIndexRanges` in `./globalCurrents.js`: a raw span of 360 or more is
 * the whole globe, and a `lonMax` numerically west of `lonMin` is a wrapped box
 * (e.g. 170 → -170 is a 20 deg box across the antimeridian, not a -340 deg one).
 *
 * @param {number} lonMin - Western edge, degrees.
 * @param {number} lonMax - Eastern edge, degrees.
 * @returns {number} Span in [0, 360], or NaN if either bound is not finite.
 */
function eastwardSpanDeg(lonMin, lonMax) {
  if (!Number.isFinite(lonMin) || !Number.isFinite(lonMax)) return NaN;
  const raw = lonMax - lonMin;
  if (raw >= 360) return 360;
  const span = ((raw % 360) + 360) % 360;
  // A raw span that is a nonzero multiple of 360 (e.g. exactly -360) means a
  // full revolution, not a degenerate point.
  return (span === 0 && raw !== 0) ? 360 : span;
}

/**
 * Split a view rectangle's longitude range into contiguous OPeNDAP index
 * ranges at one stride, resolving the 0-360 axis wrap.
 *
 * The wrap for this dataset is at the PRIME MERIDIAN (index 4499 → 0), not at
 * the antimeridian, which sits contiguously at index 2250. So a box crossing
 * 180 comes back as ONE segment and a box crossing 0 comes back as TWO.
 *
 * Both segments lie on ONE arithmetic progression of axis indices. With west
 * start w0, stride s and N = 4500 columns:
 *     nW = min(nTotal, floor((N - 1 - w0)/s) + 1)   (columns up to the axis end)
 *     e0 = w0 + s·nW - N                            (east start, same phase)
 *     nE = nTotal - nW
 * `e0` lands in [0, s) because `nW` is the first count that steps past N-1, so
 * the seam gap is exactly `s · 0.08` deg like every other gap. Restarting the
 * phase at 0 instead would leave a short, non-uniform column spacing at the
 * seam that no downstream uniform-axis check would accept.
 *
 * @param {{lonMin: number, lonMax: number}} box - View rectangle, degrees.
 * @param {number} stride - Positive integer index stride.
 * @returns {?{segments: Array<{start: number, count: number}>, nLon: number,
 *   crossesSeam: boolean, nativeCount: number}} Index-space segments in
 *   west-to-east travel order, or null on a non-finite bound or bad stride.
 */
export function hycomLonSegments(box, stride) {
  const lonMin = Number(box?.lonMin);
  const lonMax = Number(box?.lonMax);
  const span = eastwardSpanDeg(lonMin, lonMax);
  if (!Number.isFinite(span)) return null;
  if (!Number.isInteger(stride) || stride < 1) return null;
  const { lonStep, lonCount } = HYCOM_AXES;

  const lon0 = norm360(lonMin);
  const start = coveringIndex(lon0 / lonStep, false);
  const end = coveringIndex((lon0 + span) / lonStep, true);
  // Never ask for more than one full revolution: past that the same meridian
  // would be fetched twice, and while the unwrapped axis would still ascend,
  // the duplicate columns are pure waste on a grid this size.
  const nativeCount = clamp(end - start + 1, 1, lonCount);
  const nTotal = Math.floor((nativeCount - 1) / stride) + 1;

  const nWest = Math.min(nTotal, Math.floor((lonCount - 1 - start) / stride) + 1);
  const segments = [{ start, count: nWest }];
  if (nTotal > nWest) {
    segments.push({ start: start + stride * nWest - lonCount, count: nTotal - nWest });
  }
  return { segments, nLon: nTotal, crossesSeam: segments.length > 1, nativeCount };
}

/**
 * Pick the finest index stride whose fetched grid fits a cell budget, and
 * report the grid it produces.
 *
 * The cell count is non-increasing in the stride, so the smallest stride that
 * fits is also the one landing nearest under the budget. One stride is applied
 * to BOTH axes, which preserves the grid's native 2:1 anisotropy (0.04 deg
 * meridional, 0.08 deg zonal) rather than squaring the cells — a square-celled
 * plan would have to throw away half the meridional resolution at stride 1.
 *
 * Refuses (returns null) a box with non-finite bounds, `latMin > latMax`, or a
 * budget that is not a finite number >= 1. It never refuses for being too
 * small: a budget below the coarsest possible grid still yields a 1-2 cell plan,
 * on the principle that one honest vector beats a blank ocean.
 *
 * @param {{latMin: number, latMax: number, lonMin: number, lonMax: number}} box
 *   View rectangle, degrees. `lonMin`/`lonMax` may cross either ±180 or 0.
 * @param {number} [targetCells=DEFAULT_TARGET_CELLS] - Cell budget; clamped to
 *   [1, MAX_TARGET_CELLS].
 * @returns {?{stride: number, latCellDeg: number, lonCellDeg: number,
 *   nLat: number, nLon: number, cells: number, crossesSeam: boolean,
 *   targetCells: number, latStart: number,
 *   segments: Array<{latStart: number, nLat: number, lonStart: number,
 *   nLon: number}>}} Index-space plan; `segments` are ready for
 *   `buildHycomUrl`.
 */
export function chooseHycomStride(box, targetCells = DEFAULT_TARGET_CELLS) {
  const latMin = Number(box?.latMin);
  const latMax = Number(box?.latMax);
  if (!Number.isFinite(latMin) || !Number.isFinite(latMax) || latMin > latMax) return null;
  if (!Number.isFinite(targetCells) || targetCells < 1) return null;
  if (!hycomLonSegments(box, 1)) return null;

  const budget = Math.min(Math.floor(targetCells), MAX_TARGET_CELLS);
  const {
    latOrigin, latStep, latCount, lonStep, lonCount,
  } = HYCOM_AXES;
  const latStart = clamp(coveringIndex((latMin - latOrigin) / latStep, false), 0, latCount - 1);
  const latEnd = clamp(coveringIndex((latMax - latOrigin) / latStep, true), 0, latCount - 1);
  const latSpan = latEnd - latStart;

  // Termination: at stride = max(latSpan, lonCount) the plan is one row by at
  // most two columns, so the loop always finds a fit at or before that bound.
  const maxStride = Math.max(1, latSpan, lonCount);
  let stride = maxStride;
  let lonPlan = hycomLonSegments(box, maxStride);
  for (let s = 1; s <= maxStride; s += 1) {
    const nLat = Math.floor(latSpan / s) + 1;
    const plan = hycomLonSegments(box, s);
    if (nLat * plan.nLon <= budget) {
      stride = s;
      lonPlan = plan;
      break;
    }
  }

  const nLat = Math.floor(latSpan / stride) + 1;
  const segments = lonPlan.segments
    .filter((seg) => seg.count > 0)
    .map((seg) => ({ latStart, nLat, lonStart: seg.start, nLon: seg.count }));
  const nLon = segments.reduce((sum, seg) => sum + seg.nLon, 0);
  return {
    stride,
    latCellDeg: stride * latStep,
    lonCellDeg: stride * lonStep,
    nLat,
    nLon,
    cells: nLat * nLon,
    crossesSeam: segments.length > 1,
    targetCells: budget,
    latStart,
    segments,
  };
}

/**
 * Build the OPeNDAP `.ascii` URL for ONE contiguous index segment. Pure.
 *
 * Emits both components in a single query, `water_u` before `water_v`. That
 * order is cosmetic only: the server answers in its own `.dds` declaration
 * order (verified live — a `water_u,water_v` query returns the `water_v` block
 * first), and `parseHycomAscii` keys blocks by name, so the two functions are
 * not order-coupled the way `buildGlobalCurrentsUrl`/`parseGlobalCurrentsCsv0`
 * are.
 *
 * The depth axis is pinned to `[0:1:0]`, the surface. OPeNDAP hyperslab bounds
 * are `[start:stride:stop]` with stop INCLUSIVE, so the stop emitted is
 * `start + (count - 1) * stride` and the served length is exactly `count`.
 *
 * Refuses, by throwing, anything that would produce a URL whose response shape
 * is not predictable: a non-integer or out-of-range index, a count that would
 * run past the end of an axis, a non-positive stride, or an extension outside
 * the allowlist. Throwing rather than returning null is deliberate: these inputs
 * come from `chooseHycomStride`, so reaching them is a programming error, not
 * bad user data.
 *
 * @param {Object} options
 * @param {number} options.timeIndex - Index on the 121-step time axis.
 * @param {number} options.latStart - First latitude index.
 * @param {number} options.nLat - Number of latitude samples (>= 1).
 * @param {number} options.lonStart - First longitude index.
 * @param {number} options.nLon - Number of longitude samples (>= 1).
 * @param {number} [options.stride=1] - Index stride, applied to both spatial axes.
 * @param {number} [options.depthIndex=0] - Depth index; 0 is the surface.
 * @param {string} [options.ext='ascii'] - Response format.
 * @returns {string} Fully encoded URL, brackets percent-encoded as %5B/%5D.
 */
export function buildHycomUrl({
  timeIndex,
  latStart,
  nLat,
  lonStart,
  nLon,
  stride = 1,
  depthIndex = HYCOM_DATASET.surfaceDepthIndex,
  ext = 'ascii',
} = {}) {
  if (!ALLOWED_EXTS.has(ext)) throw new Error(`hycomCurrents: unsupported ext "${ext}"`);
  if (!Number.isInteger(stride) || stride < 1) {
    throw new Error(`hycomCurrents: stride must be a positive integer, got ${stride}`);
  }
  const { latCount, lonCount } = HYCOM_AXES;
  for (const [name, value] of [['timeIndex', timeIndex], ['depthIndex', depthIndex],
    ['latStart', latStart], ['nLat', nLat], ['lonStart', lonStart], ['nLon', nLon]]) {
    if (!Number.isInteger(value)) {
      throw new Error(`hycomCurrents: ${name} must be an integer, got ${value}`);
    }
  }
  if (nLat < 1 || nLon < 1) {
    throw new Error(`hycomCurrents: nLat/nLon must be >= 1, got ${nLat}x${nLon}`);
  }
  if (timeIndex < 0) throw new Error(`hycomCurrents: timeIndex ${timeIndex} is negative`);
  if (depthIndex < 0) throw new Error(`hycomCurrents: depthIndex ${depthIndex} is negative`);
  const latStop = latStart + (nLat - 1) * stride;
  const lonStop = lonStart + (nLon - 1) * stride;
  if (latStart < 0 || latStop > latCount - 1) {
    throw new Error(`hycomCurrents: latitude slab ${latStart}:${stride}:${latStop} leaves the ${latCount}-row axis`);
  }
  // The longitude axis is modulo, but a single OPeNDAP request is not: a
  // segment that runs past the end must have been split by `hycomLonSegments`.
  if (lonStart < 0 || lonStop > lonCount - 1) {
    throw new Error(
      `hycomCurrents: longitude slab ${lonStart}:${stride}:${lonStop} crosses the 0-360 seam — `
      + 'split it with hycomLonSegments() before building a URL',
    );
  }

  const { base, uVar, vVar } = HYCOM_DATASET;
  const slab = `[${timeIndex}:1:${timeIndex}]`
    + `[${depthIndex}:1:${depthIndex}]`
    + `[${latStart}:${stride}:${latStop}]`
    + `[${lonStart}:${stride}:${lonStop}]`;
  const query = `${uVar}${slab},${vVar}${slab}`;
  // Brackets are the only characters the TDS constraint parser needs escaped;
  // colons and commas are part of the documented hyperslab grammar and must
  // stay literal.
  return `${base}.${ext}?${query.replace(/\[/g, '%5B').replace(/\]/g, '%5D')}`;
}

/**
 * Parse a CF `units` string of the form "<interval> since <datetime>" out of the
 * `time` stanza of a `.das` body, and return the epoch it names.
 *
 * The epoch MOVES with each model run — it is the start of the aggregation's
 * forecast-model-run collection, not a fixed reference — so it must be read at
 * run time rather than hardcoded. The `time` stanza is matched by name and not
 * by position, because `time_run` and `time_offset` carry `units` attributes of
 * exactly the same shape and picking the first match would silently take one of
 * theirs.
 *
 * The datetime format is NOT one `Date.parse` accepts: the dataset writes
 * `hours since 2026-08-23 12:00:00.000 UTC` (space separator, trailing ` UTC`).
 * Both that and the ISO form `hours since 2026-08-23T12:00:00Z` are normalized
 * here. A stamp with no zone marker at all is read as UTC, which is what CF
 * specifies and what this dataset's `UTC` suffix confirms.
 *
 * @param {string} dasText - Full `.das` body.
 * @returns {?{epochMs: number, unitMs: number, units: string, raw: string}}
 *   `epochMs` is the reference instant; `unitMs` is the length of one axis unit
 *   in milliseconds, so `validAtMs = epochMs + value * unitMs`. Returns null if
 *   the body is not a string, has no `time` stanza, has no `units` attribute in
 *   it, names an interval this module does not handle, or carries a datetime
 *   that will not parse — every one of which the caller must treat as a failed
 *   probe rather than guessing an epoch.
 */
export function parseHycomTimeEpoch(dasText) {
  if (typeof dasText !== 'string' || dasText === '') return null;
  // Anchor on a stanza whose name is exactly `time`: the `\s*\{` after the name
  // is what excludes `time_run {` and `time_offset {`.
  const stanza = /(?:^|\n)[ \t]*time[ \t]*\{([\s\S]*?)\n[ \t]*\}/.exec(dasText);
  if (!stanza) return null;
  const units = /\bunits\s+"([^"]*)"/.exec(stanza[1]);
  if (!units) return null;
  const raw = units[1].trim();
  const parts = /^(\w+)\s+since\s+(.+)$/i.exec(raw);
  if (!parts) return null;

  const unitMs = {
    hour: HOUR_MS, hours: HOUR_MS, hr: HOUR_MS, hrs: HOUR_MS,
    day: 24 * HOUR_MS, days: 24 * HOUR_MS,
    minute: 60000, minutes: 60000, min: 60000, mins: 60000,
    second: 1000, seconds: 1000, sec: 1000, secs: 1000,
  }[parts[1].toLowerCase()];
  // An unrecognized interval is a real change in the upstream contract, not
  // something to approximate with a guess at hours.
  if (!unitMs) return null;

  let stamp = parts[2].trim();
  // `2026-08-23 12:00:00.000 UTC` -> `2026-08-23T12:00:00.000Z`.
  stamp = stamp.replace(/\s+UTC$/i, 'Z').replace(/\s+GMT$/i, 'Z');
  stamp = stamp.replace(/^(\d{4}-\d{2}-\d{2})[ \t]+/, '$1T');
  // CF: a time coordinate with no zone offset is UTC.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(stamp)) stamp += 'Z';
  const epochMs = Date.parse(stamp);
  if (!Number.isFinite(epochMs)) return null;
  return { epochMs, unitMs, units: parts[1].toLowerCase(), raw };
}

/**
 * Split an OPeNDAP `.ascii` body into its named blocks.
 *
 * The body is a `Dataset { … };` declaration, then a line of dashes, then one
 * block per requested variable. A block is a header line naming the variable
 * and its served dimensions — `water_u.water_u[1][1][4][4]` inside a Grid, or a
 * bare `time[121]` for a standalone array — followed by payload lines up to a
 * blank line.
 *
 * @param {string} text - Full response body.
 * @returns {?Map<string, {dims: number[], lines: string[]}>} Blocks keyed by the
 *   full dotted name exactly as the server wrote it, or null if the body has no
 *   dashed separator (which every `.ascii` response carries).
 */
function parseDapAsciiBlocks(text) {
  const lines = text.split(/\r?\n/);
  let i = lines.findIndex((line) => /^-{3,}\s*$/.test(line));
  if (i < 0) return null;
  i += 1;

  const blocks = new Map();
  const header = /^([A-Za-z_][\w.]*)((?:\[\d+\])+)\s*$/;
  while (i < lines.length) {
    const match = header.exec(lines[i]);
    if (!match) { i += 1; continue; }
    const dims = [...match[2].matchAll(/\[(\d+)\]/g)].map((d) => Number(d[1]));
    i += 1;
    const payload = [];
    // Payload runs to the next blank line or the next block header. DAP writes
    // a whole coordinate axis on one line (measured: 141 values, and 121 time
    // values, each on a single line), but accumulating handles a wrapped one.
    while (i < lines.length && lines[i].trim() !== '' && !header.test(lines[i])) {
      payload.push(lines[i]);
      i += 1;
    }
    blocks.set(match[1], { dims, lines: payload });
  }
  return blocks;
}

/**
 * Parse a comma-separated list of numbers spread over one or more lines.
 * Rejects, by returning null, any token that is blank or not a finite number:
 * `Number('')` is 0, so a lenient parse of a truncated coordinate axis would
 * place a column on the prime meridian instead of failing.
 * @param {string[]} lines - Payload lines.
 * @param {number} expected - Required value count.
 * @returns {?Float64Array}
 */
function parseCoordList(lines, expected) {
  const tokens = lines.join(',').split(',').map((t) => t.trim()).filter((t) => t !== '');
  if (tokens.length !== expected) return null;
  const out = new Float64Array(expected);
  for (let i = 0; i < expected; i += 1) {
    const x = Number(tokens[i]);
    if (!Number.isFinite(x)) return null;
    out[i] = x;
  }
  return out;
}

/**
 * Parse one velocity token, mapping every flavour of "no data" to NaN.
 * @param {string} token
 * @returns {number} m/s, or NaN.
 */
function parseValue(token) {
  const s = token.trim();
  if (s === '' || /^nan$/i.test(s)) return NaN;
  const x = Number(s);
  if (!Number.isFinite(x)) return NaN;
  // Catches a corrupt spike or an un-masked fill; see HYCOM_DATASET.maxSpeedMs.
  if (Math.abs(x) > HYCOM_DATASET.maxSpeedMs) return NaN;
  return x;
}

/**
 * Find a variable's time MAPS block, whatever the aggregation named it.
 *
 * The FMRC aggregation gives each variable its OWN time coordinate and numbers
 * them apart: the `.dds` declares `water_u[time = 129]` but
 * `water_v[time1 = 129]`, so one body carries `water_u.time` alongside
 * `water_v.time1`. Requiring the literal name `time` rejected every real
 * response — verified live 2026-09-02 against five disjoint boxes (Monterey,
 * mid-Pacific, North Sea, antimeridian, equator), all five parsed as shape
 * drift while the server was healthy.
 *
 * Matching the FAMILY rather than one literal is safe because the two axes are
 * the same axis under two names: fetched whole, `time` and `time1` agree
 * elementwise across all 129 steps (max |time − time1| = 0, both 0…384 h at
 * 3 h). That is measured, not assumed, and it is exactly what
 * `parseHycomAscii`'s `uGrid.timeValue !== vGrid.timeValue` guard keeps
 * checking per response — so a future aggregation that really did serve two
 * components at different instants is still refused.
 *
 * @param {Map<string, {dims: number[], lines: string[]}>} blocks
 * @param {string} name - Variable name, e.g. `water_u`.
 * @returns {?{dims: number[], lines: string[]}} The block, or null.
 */
function findTimeMapBlock(blocks, name) {
  const prefix = `${name}.`;
  for (const [key, block] of blocks) {
    if (!key.startsWith(prefix)) continue;
    if (/^time\d*$/.test(key.slice(prefix.length))) return block;
  }
  return null;
}

/**
 * Pull one variable's Grid out of a parsed block map: its data array plus the
 * MAPS echo of the coordinates actually served.
 * @param {Map<string, {dims: number[], lines: string[]}>} blocks
 * @param {string} name - Variable name, e.g. `water_u`.
 * @returns {?{values: Float32Array, nLat: number, nLon: number,
 *   lats: Float64Array, lons: Float64Array, timeValue: number, depthValue: number}}
 */
function readGridVariable(blocks, name) {
  const array = blocks.get(`${name}.${name}`);
  if (!array) return null;
  // [time][depth][lat][lon]; time and depth are pinned to one index each.
  if (array.dims.length !== 4) return null;
  const [nTime, nDepth, nLat, nLon] = array.dims;
  if (nTime !== 1 || nDepth !== 1 || nLat < 1 || nLon < 1) return null;

  // Every MAPS block must be present. A missing one means the response is not
  // the self-describing Grid this parser reads, and inferring the coordinates
  // from the request is precisely the substitution this module forbids.
  const timeBlock = findTimeMapBlock(blocks, name);
  const depthBlock = blocks.get(`${name}.depth`);
  const latBlock = blocks.get(`${name}.lat`);
  const lonBlock = blocks.get(`${name}.lon`);
  if (!timeBlock || !depthBlock || !latBlock || !lonBlock) return null;
  const times = parseCoordList(timeBlock.lines, 1);
  const depths = parseCoordList(depthBlock.lines, 1);
  const lats = parseCoordList(latBlock.lines, nLat);
  const lons = parseCoordList(lonBlock.lines, nLon);
  if (!times || !depths || !lats || !lons) return null;
  // The MAPS blocks must also agree with the ARRAY's own declared shape.
  if (latBlock.dims[0] !== nLat || lonBlock.dims[0] !== nLon) return null;

  const values = new Float32Array(nLat * nLon);
  if (array.lines.length !== nLat) return null;
  const rowHead = /^((?:\[\d+\])+)\s*,\s*(.*)$/;
  for (let i = 0; i < nLat; i += 1) {
    const row = rowHead.exec(array.lines[i]);
    if (!row) return null;
    const prefix = [...row[1].matchAll(/\[(\d+)\]/g)].map((d) => Number(d[1]));
    // A 4-D array prefixes each row with [time][depth][lat]; the last index is
    // the OUTPUT row counter (0…nLat-1) even under a stride, verified live.
    if (prefix.length !== 3 || prefix[2] !== i) return null;
    const tokens = row[2].split(',');
    if (tokens.length !== nLon) return null;
    for (let j = 0; j < nLon; j += 1) values[i * nLon + j] = parseValue(tokens[j]);
  }
  return {
    values, nLat, nLon, lats, lons, timeValue: times[0], depthValue: depths[0],
  };
}

/**
 * Parse an OPeNDAP `.ascii` body carrying `water_u` and `water_v` into a dense
 * row-major grid.
 *
 * Coordinates come from the MAPS echo in the body — the coordinates the server
 * actually SERVED — never from the indices that were requested. Blocks are
 * looked up by NAME, because the server emits them in its own `.dds` order
 * rather than the query's, and a positional read would transpose the two
 * components.
 *
 * Longitudes are returned in the dataset's own 0-360 convention, unconverted.
 * Conversion to the pipeline's [-180, 180) frame is `stitchHycomGrids`'s job,
 * because it is the step that also has to unwrap a seam crossing, and doing it
 * twice would double-shift the axis.
 *
 * Returns null — never a partially-filled grid — on any shape drift: a
 * non-string or empty body, an OPeNDAP `Error {…}` payload, HTML, a missing
 * dashed separator, a missing variable or MAPS block, a row count disagreeing
 * with the declared dimensions, a row whose value count disagrees with them, a
 * row index out of sequence, a non-numeric coordinate, a served depth that is
 * not the surface, or two variables whose served axes disagree. A caller must
 * treat null as a failed fetch, never as ocean with no current in it.
 *
 * Components are kept in step: a cell whose u or v is missing has BOTH written
 * NaN, because a one-component vector has no direction and a streakline
 * integrator stepping through it would draw a confident due-east flow out of a
 * data void. `finite` is therefore exactly the number of usable vectors.
 *
 * @param {string} text - Response body.
 * @returns {?{lats: Float64Array, lons: Float64Array, u: Float32Array,
 *   v: Float32Array, finite: number, total: number, timeValue: number,
 *   depthM: number}} `u[i * lons.length + j]` is the eastward component at
 *   `lats[i]`, `lons[j]`. `timeValue` is the raw time-axis value the response
 *   echoed, in the axis's own units — turn it into an instant with
 *   `parseHycomTimeEpoch`.
 */
export function parseHycomAscii(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim();
  if (body === '') return null;
  // TDS reports failures as an `Error { code = …; message = "…"; };` block with
  // a 400 status (verified live), and a misconfigured proxy can hand back HTML.
  if (body.startsWith('Error') || body.startsWith('<')) return null;

  const blocks = parseDapAsciiBlocks(text);
  if (!blocks) return null;
  const { uVar, vVar } = HYCOM_DATASET;
  const uGrid = readGridVariable(blocks, uVar);
  const vGrid = readGridVariable(blocks, vVar);
  if (!uGrid || !vGrid) return null;
  if (uGrid.nLat !== vGrid.nLat || uGrid.nLon !== vGrid.nLon) return null;

  // The two components must describe the same cells at the same instant and
  // level, or they are not a vector field.
  if (!Number.isFinite(uGrid.timeValue) || uGrid.timeValue !== vGrid.timeValue) return null;
  for (let i = 0; i < uGrid.nLat; i += 1) {
    if (Math.abs(uGrid.lats[i] - vGrid.lats[i]) > COORD_EPS) return null;
  }
  for (let j = 0; j < uGrid.nLon; j += 1) {
    if (Math.abs(uGrid.lons[j] - vGrid.lons[j]) > COORD_EPS) return null;
  }
  // Refuse a body served from any level but the surface. The depth axis has 40
  // levels and this module always pins index 0; if that ever stops meaning
  // 0.0 m, drawing level 1 as the surface would be a silent substitution.
  if (!(Math.abs(uGrid.depthValue) <= COORD_EPS) || uGrid.depthValue !== vGrid.depthValue) return null;

  const total = uGrid.nLat * uGrid.nLon;
  const u = new Float32Array(total);
  const v = new Float32Array(total);
  let finite = 0;
  for (let k = 0; k < total; k += 1) {
    const usable = Number.isFinite(uGrid.values[k]) && Number.isFinite(vGrid.values[k]);
    u[k] = usable ? uGrid.values[k] : NaN;
    v[k] = usable ? vGrid.values[k] : NaN;
    if (usable) finite += 1;
  }
  return {
    lats: uGrid.lats,
    lons: uGrid.lons,
    u,
    v,
    finite,
    total,
    timeValue: uGrid.timeValue,
    depthM: uGrid.depthValue,
  };
}

/**
 * Join one or two fetched segments into a single grid on a strictly ascending
 * longitude axis in the pipeline's frame.
 *
 * Two things happen to the longitudes, in this order:
 *   1. UNWRAP. The served values are in 0-360, so a seam-crossing pair runs
 *      350…359.92 then 0…10. Each value that does not exceed its predecessor
 *      gets +360 until it does, making the axis strictly ascending: 350…370.
 *   2. RE-ANCHOR. If the first value is at or beyond 180, the whole axis shifts
 *      by -360, so 350…370 becomes -10…+10 and 237.52…237.76 becomes
 *      -122.48…-122.24.
 * A box crossing the ANTIMERIDIAN starts below 180 and is left alone, so its
 * axis ascends past +180 (170…190). That is intentional and matches
 * `stitchGlobalCurrents` in `./globalCurrents.js`: a rectangle spanning the
 * antimeridian has no ascending representation inside [-180, 180), and callers
 * sampling the field must wrap their query longitude into the same frame rather
 * than assume every axis value is below 180.
 *
 * Returns null if the pieces cannot belong to one grid: no segments, differing
 * latitude axes, a payload length disagreeing with its own axes, a time value
 * that differs between segments, or a seam gap that is not one stride. All of
 * those mean a phase error upstream, and none may be papered over by
 * concatenating anyway. It returns null rather than throwing even for a
 * malformed argument, because the caller's next move is identical in every
 * case: report the fetch as failed.
 *
 * @param {Array<?Object>} grids - Parsed segments from `parseHycomAscii`, in
 *   west-to-east travel order.
 * @param {number} lonStepDeg - Expected column spacing, degrees (stride x 0.08).
 * @returns {?{lats: Float64Array, lons: Float64Array, u: Float32Array,
 *   v: Float32Array, finite: number, total: number, timeValue: number,
 *   depthM: number}}
 */
export function stitchHycomGrids(grids, lonStepDeg) {
  if (!Array.isArray(grids) || grids.length === 0) return null;
  if (!Number.isFinite(lonStepDeg) || lonStepDeg <= 0) return null;
  for (const g of grids) {
    if (!g) return null;
    if (typeof g.lats?.length !== 'number' || typeof g.lons?.length !== 'number') return null;
    if (typeof g.u?.subarray !== 'function' || typeof g.v?.subarray !== 'function') return null;
    if (g.lats.length === 0 || g.lons.length === 0) return null;
    if (g.u.length !== g.lats.length * g.lons.length) return null;
    if (g.v.length !== g.lats.length * g.lons.length) return null;
  }
  const nLat = grids[0].lats.length;
  for (const g of grids) {
    if (g.lats.length !== nLat) return null;
    for (let i = 0; i < nLat; i += 1) {
      if (Math.abs(g.lats[i] - grids[0].lats[i]) > COORD_EPS) return null;
    }
    if (g.timeValue !== grids[0].timeValue) return null;
  }

  const nLon = grids.reduce((sum, g) => sum + g.lons.length, 0);
  const lons = new Float64Array(nLon);
  let at = 0;
  for (const g of grids) {
    for (let j = 0; j < g.lons.length; j += 1) {
      let value = g.lons[j];
      if (at > 0) {
        // Unwrap onto the running axis. The loop runs at most once for a real
        // response (one seam crossing), but is written as a loop so a
        // pathological input terminates rather than emitting a descending axis.
        while (value <= lons[at - 1] && value < lons[at - 1] + 360) value += 360;
        const gap = value - lons[at - 1];
        if (Math.abs(gap - lonStepDeg) > COORD_EPS) return null;
      }
      lons[at] = value;
      at += 1;
    }
  }
  // Re-anchor into [-180, 180). Only the FIRST value is tested: shifting the
  // whole axis by one revolution preserves both its spacing and its ordering,
  // and testing every value would break a deliberate antimeridian overhang.
  if (lons[0] >= 180) for (let j = 0; j < nLon; j += 1) lons[j] -= 360;

  const total = nLat * nLon;
  const u = new Float32Array(total);
  const v = new Float32Array(total);
  let finite = 0;
  for (let i = 0; i < nLat; i += 1) {
    let col = 0;
    for (const g of grids) {
      const w = g.lons.length;
      u.set(g.u.subarray(i * w, (i + 1) * w), i * nLon + col);
      v.set(g.v.subarray(i * w, (i + 1) * w), i * nLon + col);
      col += w;
    }
  }
  for (let k = 0; k < total; k += 1) {
    if (Number.isFinite(u[k]) && Number.isFinite(v[k])) finite += 1;
  }
  return {
    lats: Float64Array.from(grids[0].lats),
    lons,
    u,
    v,
    finite,
    total,
    timeValue: grids[0].timeValue,
    depthM: grids[0].depthM,
  };
}

/**
 * Pick the time-axis index whose step is nearest a requested instant.
 *
 * Nearest, not nearest-at-or-before: the axis carries a forecast, and for
 * `atMs = now` the nearest step is at most half a step (1.5 h) away in either
 * direction. A step 1.5 h ahead is the same model run's own state and is closer
 * to the requested instant than a 1.5 h-old one, so it is the better answer.
 * The index is clamped to the axis, which is what stops a far-future `atMs` from
 * requesting a step beyond the last.
 *
 * @param {number} atMs - Requested instant, ms since the epoch.
 * @param {{epochMs: number, unitMs: number}} epoch - From `parseHycomTimeEpoch`.
 * @param {Float64Array|number[]} hours - Served time-axis values, ascending.
 * @returns {?{index: number, validAtMs: number, clamped: boolean}} `validAtMs`
 *   is the instant of the CHOSEN step. Null if any input is unusable.
 */
export function chooseHycomTimeIndex(atMs, epoch, hours) {
  if (!Number.isFinite(atMs)) return null;
  if (!Number.isFinite(epoch?.epochMs) || !Number.isFinite(epoch?.unitMs)) return null;
  const n = hours?.length ?? 0;
  if (!n) return null;
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(hours[i])) return null;
    const delta = Math.abs(epoch.epochMs + hours[i] * epoch.unitMs - atMs);
    if (delta < bestDelta) { bestDelta = delta; best = i; }
  }
  if (best < 0) return null;
  return {
    index: best,
    validAtMs: epoch.epochMs + hours[best] * epoch.unitMs,
    // True when the request fell outside the axis and the answer is an endpoint
    // rather than a genuine nearest neighbour.
    clamped: best === 0 || best === n - 1,
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
    () => controller.abort(new Error(`hycomCurrents: upstream timed out after ${timeoutMs} ms`)),
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
 * Fetch a URL as text, enforcing HTTP success and the byte cap. Throws with the
 * status and a body excerpt so an OPeNDAP `Error {…}` block reaches the log
 * instead of being flattened into "fetch failed".
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
        Accept: 'text/plain, */*',
        'User-Agent': HYCOM_USER_AGENT,
      },
    });
    // Success must be asserted, not assumed: an object with no `ok` field is a
    // broken fetch impl, and treating it as a 200 would hand `undefined` to the
    // parser and surface as "empty ocean" rather than as the wiring bug it is.
    if (!response || typeof response.text !== 'function' || typeof response.ok !== 'boolean') {
      throw new Error(`hycomCurrents: fetchImpl returned no usable response for ${url}`);
    }
    if (!response.ok) {
      throw new Error(`hycomCurrents: HTTP ${response.status ?? 'unknown status'} from ${url}`);
    }
    const text = await response.text();
    if (typeof text !== 'string') {
      throw new Error(`hycomCurrents: non-text response body from ${url}`);
    }
    // OPeNDAP `.ascii` for this dataset is pure ASCII (digits, signs, dots,
    // commas, brackets, "NaN"), so character length is byte length.
    if (text.length > HYCOM_RESPONSE_BYTE_CAP) {
      throw new Error(
        `hycomCurrents: response ${text.length} B exceeds the ${HYCOM_RESPONSE_BYTE_CAP} B cap — `
        + 'lower targetCells',
      );
    }
    return text;
  } finally {
    gate.release();
  }
}

/**
 * Probe the dataset's time axis: the run epoch from the `.das` and every step
 * value from the axis itself.
 *
 * Both are read because both move. The epoch advances with each model run, and
 * the axis length is not guaranteed to stay at 121 — assuming either would
 * eventually point this module at a step that does not exist, or silently
 * misdate every field it serves. The two requests are issued concurrently, so
 * this costs one round trip of latency and about 5 kB.
 *
 * Deliberately NOT cached here: the caller owns the cache policy. The
 * aggregation's `created_on` advanced roughly twice a day during probing, so a
 * TTL of a few hours is appropriate; pass the result back in as
 * `fetchHycomCurrents`'s `timeAxis` option to reuse it.
 *
 * Returns null on any failure — HTTP error, unparseable `.das`, an axis block
 * that will not parse. Cancellation and timeout are failures too and also yield
 * null, so a caller that passes a `signal` must re-check `signal.aborted` on a
 * null result rather than blaming the dataset (`fetchHycomCurrents` does this).
 *
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl=fetch] - Injectable fetch.
 * @param {?AbortSignal} [options.signal=null] - Caller cancellation.
 * @param {number} [options.timeoutMs=HYCOM_TIMEOUT_MS] - Per-request timeout.
 * @returns {Promise<?{epochMs: number, unitMs: number, units: string,
 *   hours: Float64Array, count: number, urls: string[]}>}
 */
export async function fetchHycomTimeAxis({
  fetchImpl = (...args) => fetch(...args),
  signal = null,
  timeoutMs = HYCOM_TIMEOUT_MS,
} = {}) {
  const { base } = HYCOM_DATASET;
  const dasUrl = `${base}.das`;
  const axisUrl = `${base}.ascii?time`;
  let dasText;
  let axisText;
  try {
    [dasText, axisText] = await Promise.all([
      fetchText(dasUrl, fetchImpl, signal, timeoutMs),
      fetchText(axisUrl, fetchImpl, signal, timeoutMs),
    ]);
  } catch {
    return null;
  }
  const epoch = parseHycomTimeEpoch(dasText);
  if (!epoch) return null;
  const blocks = typeof axisText === 'string' ? parseDapAsciiBlocks(axisText) : null;
  const block = blocks?.get('time');
  if (!block || block.dims.length !== 1) return null;
  const hours = parseCoordList(block.lines, block.dims[0]);
  if (!hours || hours.length === 0) return null;
  return {
    epochMs: epoch.epochMs,
    unitMs: epoch.unitMs,
    units: epoch.units,
    hours,
    count: hours.length,
    urls: [dasUrl, axisUrl],
  };
}

/**
 * Common spacing of a served axis, with a uniformity check.
 *
 * A single number can only describe the resolution of an evenly spaced axis, so
 * this reports the step and refuses to guess one otherwise. The tolerance is
 * `COORD_EPS`, sized for this dataset's Float32 coordinate noise — see that
 * constant for the measured spread.
 *
 * @param {Float64Array} axis - Ascending axis values, degrees.
 * @param {number} nominal - Expected step, for the tolerance band.
 * @returns {?number} The mean step in degrees; NaN when the axis has fewer than
 *   two points, so no spacing is observable; null when the axis is not uniform,
 *   which callers must treat as a corrupt grid rather than round off.
 */
function axisStep(axis, nominal) {
  if (axis.length < 2) return NaN;
  let sum = 0;
  for (let i = 1; i < axis.length; i += 1) {
    const step = axis[i] - axis[i - 1];
    if (Math.abs(step - nominal) > COORD_EPS) return null;
    sum += step;
  }
  // The MEAN of the served gaps, not the first one: the coordinates arrive at
  // Float32 precision, so any single gap carries up to ~1.2e-4 deg of rounding
  // noise while the mean of n-1 of them is the axis's true spacing to within
  // that noise over n-1.
  return sum / (axis.length - 1);
}

/**
 * Fetch the HYCOM surface-current field for a view rectangle, normalized.
 *
 * Resolves the time axis (unless one is supplied), picks the step nearest the
 * requested instant, picks a stride under the cell budget, issues one request
 * per longitude segment — two when the box crosses the prime meridian — parses
 * each and stitches them, and returns the grid together with a source report a
 * UI can put on screen without inventing anything.
 *
 * DROP-IN for `fetchGlobalCurrents` in `./globalCurrents.js`: same call shape
 * (`{box, targetCells, fetchImpl, nowMs, signal}`) and same return shape
 * (`{lats, lons, u, v, finite, total, source}`), so `fieldGrid.js` can swap the
 * tier without changing how it consumes the result.
 *
 * Throws rather than returning an empty grid whenever the field cannot be
 * trusted: an unusable box, no resolvable time axis, an HTTP failure, a body
 * over the response cap, a body whose shape drifted, a served level that is not
 * the surface, a served axis that is not uniformly spaced, or a seam that will
 * not stitch. A caller cancellation is re-thrown as the caller's own abort
 * reason, not disguised as an upstream failure. The one thing it will never do
 * is report ocean where it has no data.
 *
 * FORECAST AND NEGATIVE AGE. This dataset publishes about five days ahead, so
 * the step nearest the requested instant CAN BE IN THE FUTURE, and `ageMs`
 * (`nowMs - validAtMs`) is then NEGATIVE. That is reported as-is and never
 * clamped: a clamped age would make a five-day forecast look like a
 * just-published analysis. `source.isForecast` and `source.forecastLeadMs` state
 * it outright so a caller need not infer it from a sign. Note for downstream:
 * `fieldGrid.js` treats staleness as `ageMs > GLOBAL_STALE_MS`, which a
 * negative age simply never trips, and its "not the time that was requested"
 * caveat fires for a forecast step — both are the correct behaviours here.
 *
 * Everything in `source` that describes the data describes what the SERVER
 * returned, never what was requested: `validAtMs` comes from the time value the
 * response echoed, and `resolutionDeg` from the served axis spacing.
 *
 * @param {Object} options
 * @param {{latMin: number, latMax: number, lonMin: number, lonMax: number}} options.box
 *   View rectangle, degrees; `lonMin`/`lonMax` may cross ±180 or 0.
 * @param {number} [options.targetCells=DEFAULT_TARGET_CELLS] - Cell budget.
 * @param {Function} [options.fetchImpl=fetch] - Injectable fetch.
 * @param {number} [options.nowMs=Date.now()] - Reference time for `ageMs`.
 * @param {?number} [options.atMs=null] - Instant to serve; defaults to `nowMs`.
 * @param {?Object} [options.timeAxis=null] - A cached `fetchHycomTimeAxis`
 *   result, to skip the two probe requests.
 * @param {?AbortSignal} [options.signal=null] - Caller cancellation.
 * @param {number} [options.timeoutMs=HYCOM_TIMEOUT_MS] - Per-request timeout.
 * @returns {Promise<{lats: Float64Array, lons: Float64Array, u: Float32Array,
 *   v: Float32Array, finite: number, total: number, validAtMs: number,
 *   ageMs: number, source: Object}>} `source` is `{datasetId, validAtMs, ageMs,
 *   isForecast, forecastLeadMs, timeIndex, timeIso, resolutionDeg,
 *   resolutionLonDeg, nativeResolutionDeg, stride, cells, coverage, label,
 *   attribution, license, note, url, urls, crossesSeam}`; `coverage` is
 *   finite/total, i.e. the fraction of the fetched rectangle carrying a
 *   two-component vector, and `url` is `urls[0]`.
 */
export async function fetchHycomCurrents({
  box,
  targetCells = DEFAULT_TARGET_CELLS,
  fetchImpl = (...args) => fetch(...args),
  nowMs = Date.now(),
  atMs = null,
  timeAxis = null,
  signal = null,
  timeoutMs = HYCOM_TIMEOUT_MS,
} = {}) {
  const plan = chooseHycomStride(box, targetCells);
  if (!plan) throw new Error('hycomCurrents: unusable view rectangle or cell budget');

  let axis = timeAxis;
  if (!axis) {
    axis = await fetchHycomTimeAxis({ fetchImpl, signal, timeoutMs });
    if (!axis) {
      // `fetchHycomTimeAxis` flattens every failure to null, cancellation
      // included. Re-throw the caller's own abort reason instead of reporting a
      // dataset outage: a camera move is not a HYCOM problem, and the caller
      // needs to be able to tell the two apart.
      if (signal?.aborted) throw signal.reason ?? new Error('hycomCurrents: aborted');
      throw new Error('hycomCurrents: could not resolve the dataset\'s time axis');
    }
  }
  const wantMs = Number.isFinite(atMs) ? atMs : nowMs;
  const step = chooseHycomTimeIndex(wantMs, axis, axis.hours);
  if (!step) throw new Error('hycomCurrents: could not choose a time step');

  const urls = plan.segments.map((segment) => buildHycomUrl({
    timeIndex: step.index,
    latStart: segment.latStart,
    nLat: segment.nLat,
    lonStart: segment.lonStart,
    nLon: segment.nLon,
    stride: plan.stride,
  }));
  const bodies = await Promise.all(urls.map((url) => fetchText(url, fetchImpl, signal, timeoutMs)));
  const grids = bodies.map((text, i) => {
    const grid = parseHycomAscii(text);
    if (!grid) throw new Error(`hycomCurrents: unparseable or shape-drifted response from ${urls[i]}`);
    return grid;
  });

  const grid = stitchHycomGrids(grids, plan.lonCellDeg);
  if (!grid) throw new Error('hycomCurrents: fetched segments do not stitch into one grid');

  // Report the instant the server actually served, computed from the echoed
  // time value rather than from the index that was asked for. A body carrying a
  // value the epoch cannot turn into an instant is shape drift, not licence to
  // fall back on the request.
  const validAtMs = axis.epochMs + grid.timeValue * axis.unitMs;
  if (!Number.isFinite(validAtMs)) {
    throw new Error('hycomCurrents: response carries no usable time value');
  }
  // Same rule for the resolution: measure the axes that came back rather than
  // repeating the stride that was asked for. A non-uniform axis has no single
  // resolution at all, and a renderer that assumed one would smear the field.
  const latStepDeg = axisStep(grid.lats, plan.latCellDeg);
  const lonStepDeg = axisStep(grid.lons, plan.lonCellDeg);
  if (latStepDeg === null || lonStepDeg === null) {
    throw new Error('hycomCurrents: the served grid axes are not uniformly spaced');
  }
  // A degenerate single-row or single-column grid shows no spacing of its own;
  // fall back to the plan, which is the only thing left that knows one.
  const servedLatDeg = Number.isFinite(latStepDeg) ? latStepDeg : plan.latCellDeg;
  const servedLonDeg = Number.isFinite(lonStepDeg) ? lonStepDeg : plan.lonCellDeg;

  const ageMs = nowMs - validAtMs;
  const {
    id, label, attribution, license, licenseNote, resolutionDeg, generatingModel,
  } = HYCOM_DATASET;
  return {
    lats: grid.lats,
    lons: grid.lons,
    u: grid.u,
    v: grid.v,
    finite: grid.finite,
    total: grid.total,
    validAtMs,
    ageMs,
    source: {
      datasetId: id,
      validAtMs,
      /** `nowMs - validAtMs`; NEGATIVE for a forecast step, deliberately unclamped. */
      ageMs,
      isForecast: validAtMs > nowMs,
      forecastLeadMs: Math.max(0, validAtMs - nowMs),
      /** Index on the served time axis, and the instant it carries. */
      timeIndex: step.index,
      timeIso: new Date(validAtMs).toISOString(),
      /**
       * Served MERIDIONAL spacing, degrees — the axis `fieldGrid.js` converts
       * with `metresPerDegLat`. The zonal spacing is `resolutionLonDeg`.
       */
      resolutionDeg: servedLatDeg,
      resolutionLonDeg: servedLonDeg,
      nativeResolutionDeg: resolutionDeg,
      stride: plan.stride,
      cells: grid.total,
      coverage: grid.total > 0 ? grid.finite / grid.total : 0,
      label,
      attribution,
      license,
      licenseNote,
      note:
        `${generatingModel}. Full primitive-equation model: unlike an altimetric `
        + 'geostrophic product it carries tides and wind-driven (Ekman) flow. Surface '
        + 'level (depth 0 m) of the 3-D field, 3-hourly. The axis runs about five days '
        + 'ahead of now, so a step may be a FORECAST and ageMs may be negative.',
      crossesSeam: plan.crossesSeam,
      url: urls[0],
      urls,
    },
  };
}
