/**
 * @file HF-radar surface-current ingest from the CoastWatch/NOAA ERDDAP mirror
 * of the IOOS HFRNet real-time total-vector (RTV) products.
 *
 * WHAT THE DATA IS. Shore-based HF radars measure the radial component of
 * surface velocity (top ~1 m) from Bragg-resonant backscatter off ocean waves.
 * HFRNet least-squares-combines overlapping radials from >=2 sites into hourly
 * gridded TOTAL vectors (`water_u`, `water_v`, m/s, eastward/northward). Each
 * cell also carries `hdop` — the horizontal dilution of precision, the vector
 * magnitude of the along-x/along-y DOP, i.e. the amplification of radial error
 * into total-vector error caused purely by the radial-crossing geometry. hdop
 * is dimensionless and near 1 only where two sites cross near-orthogonally;
 * it blows up along baselines and outside the site fence. Verbatim from the
 * `ucsdHfrW2` .das, fetched 2026-09-01: "The horizontal dilution of precision
 * (hdop) is the vector length (magnitude) of the eastward (dopx) and northward
 * (dopy) dilution of precision. It represents the contribution of radial
 * geometry to the overall uncertainty in the total velocity (u and v)
 * estimate."
 *
 * LIVE DATASET INVENTORY. Enumerated 2026-09-01 from the complete griddap
 * index of `https://coastwatch.pfeg.noaa.gov/erddap` (2768 datasets); every
 * row below was then individually probed for `.das` coverage (`actual_range`),
 * grid spacing (two adjacent `latitude` values), and true latest timestamp via
 * `.csv0?time%5B(last)%5D`. "Age" is measured against 2026-09-01T07:10Z.
 *
 *   dataset       domain             res    lat range         lon range          latest (UTC)          age
 *   ucsdHfrW500   US West (SF Bay)   0.5km  37.4555..38.1387  -122.5935..-122.0469  2026-08-31T23:00Z   8.2 h
 *   ucsdHfrW1     US West            1 km   30.2500..49.9920  -130.3600..-115.8056  2026-08-31T22:00Z   9.2 h
 *   ucsdHfrW2     US West            2 km   30.2500..49.9920  -130.3600..-115.8056  2026-08-31T22:00Z   9.2 h
 *   ucsdHfrE1     US East + Gulf     1 km   21.7000..46.4944   -97.8839.. -57.1925  2026-08-31T22:00Z   9.2 h
 *   ucsdHfrE2     US East + Gulf     2 km   21.7000..46.4944   -97.8839.. -57.1925  2026-08-31T23:00Z   8.2 h
 *   ucsdHfrE6     US East + Gulf     6 km   21.7360..46.4944   -97.8839.. -57.2312  2026-08-31T23:00Z   8.2 h
 *   ucsdHfrH1     Hawaii             1 km   16.2204..24.9169  -163.1444..-151.9565  2026-08-31T21:00Z  10.2 h
 *   ucsdHfrP2     Puerto Rico/USVI   2 km   14.5000..21.9977   -70.5000.. -61.0056  2026-08-31T22:00Z   9.2 h
 *   ucsdHfrP6     Puerto Rico/USVI   6 km   14.5000..21.9977   -70.5000.. -61.0242  2026-08-31T22:00Z   9.2 h
 *
 * All nine are genuinely near-real-time: every one is 8-11 h behind wall clock,
 * which is HFRNet's normal aggregation latency, not staleness. (Contrast the
 * `noaacwBlendednrtWinds6hr` trap — a dataset titled "near real time" whose
 * data stops in 2023. Titles lie; only `time[(last)]` is evidence.) Each
 * dataset also has a `*_Lon0360` twin serving longitudes on [0, 360); this
 * module uses only the [-180, 180) originals, so callers never need to know
 * which convention a rung speaks.
 *
 * FINDINGS THAT CONTRADICT THE PORT BRIEF, both re-verified 2026-09-01:
 * 1. `ucsdHfrW6` NO LONGER EXISTS. The reference implementation's 6 km US West
 *    rung (and the brief that described it as live on 2026-08-30) is dead: the
 *    id is absent from the full griddap index, `.das` 404s, and the surviving
 *    `ucsdHfrW6_Lon0360` alias was a dangling shell that first answered
 *    `time[(last)]` from cached axis metadata while 500-ing every data request
 *    ("underlying local datasetID=ucsdHfrW6 not found") and then 404'd outright
 *    minutes later. So US West has NO 6 km rung; its ladder is 500 m -> 1 km ->
 *    2 km. That failure mode is exactly why {@link fetchHfrField} treats a
 *    successful time probe as necessary but never sufficient, and falls through
 *    on a failed or unusable DATA request rather than trusting the probe.
 * 2. There is no Alaska HFRNet dataset on this ERDDAP at all, and no separate
 *    Gulf of Mexico dataset — the Gulf is covered by the `ucsdHfrE*` boxes,
 *    whose longitude range reaches -97.88 (west Texas shelf).
 *
 * WIRE FORMAT. `.csv0` is headerless CSV; griddap emits one row per
 * (time, latitude, longitude) cell in the requested hyperslab, with the
 * requested variables appended in request order:
 *   `2026-08-31T22:00:00Z,36.59694,-122.09374,0.1,0.1,0.64`
 * Absent cells are the literal token `NaN` in every value column (the `.das`
 * `_FillValue` of -327.67 is already translated by ERDDAP). Coverage is sparse
 * and patchy: a 10x10 cell box at Monterey on `ucsdHfrW2` returned 92/100
 * finite at the latest hour, while the SAME box on the finer `ucsdHfrW1`
 * returned 0/160 finite across an eight-hour window — 1 km totals need dense
 * short-range radials that simply are not there. Finer resolution is therefore
 * NOT a proxy for better data, which is the entire reason the ladder gates on a
 * realized vector count instead of just picking the finest box that overlaps.
 *
 * END-TO-END LIVE VALIDATION of {@link fetchHfrField}, 2026-09-01, stride 1,
 * default knobs. `n` counts QC-passing vectors in the single served hour;
 * `|V|` is the speed magnitude sqrt(u^2+v^2) over exactly those n vectors:
 *
 *   box                                  rung          n     |V| median  |V| max
 *   Monterey Bay 36.5..36.8N             ucsdHfrW2     68    0.130 m/s   0.324
 *   San Francisco 37.7..37.9N            ucsdHfrW500   66    0.153 m/s   0.647
 *   Chesapeake mouth 36.6..37.4N         ucsdHfrE1    735    0.425 m/s   1.270
 *   Mid-Atlantic Bight 38.8..40.2N       ucsdHfrE2   1210    0.102 m/s   0.259
 *   S Florida / Keys 24.8..26.0N         ucsdHfrE2    383    1.482 m/s   1.976
 *   Oahu 21.1..21.8N                     ucsdHfrH1    336    0.219 m/s   0.414
 *   N Puerto Rico 18.2..18.8N            ucsdHfrP2    134    0.362 m/s   0.989
 *
 * Two checks on that table. (a) The magnitudes are physical: the Florida Current
 * core at 1.48 m/s median, the Chesapeake tidal jet at 0.43, the summer
 * Mid-Atlantic shelf nearly slack at 0.10. (b) The fastest real water anywhere
 * in it, 1.976 m/s, sits below {@link MAX_CURRENT_MS} = 2.4 — so the speed gate
 * removes artifacts without clipping the strongest genuine signal these domains
 * produce, which is the only evidence that justifies the constant.
 *
 * Cape Hatteras and the Texas shelf returned null: real coverage holes between
 * radar clusters, where every cell in the box is NaN at every hour of the
 * window even though the dataset timestamp is fresh. Null is the correct answer
 * there, and is the behaviour the vector floor exists to produce.
 *
 * DELIBERATE IMPROVEMENTS OVER THE REFERENCE
 * (`grok-workspace/src/lib/ocean/ingest/hfradar.ts`):
 * - One hour, not a smear. The reference pools every vector in its 6 h window
 *   into a single observation set, so a downstream Barnes analysis blends
 *   currents up to six hours apart. Coastal surface currents are dominated by
 *   semidiurnal tides (~12.42 h M2 period), so vectors 6 h apart are close to
 *   ANTIPHASE and their mean is biased toward zero. This module still REQUESTS
 *   a window (to survive an empty newest hour) but groups by timestamp and
 *   returns only the newest single hour that clears the vector gate.
 * - Box clamping. The reference passes the caller's box straight through;
 *   ERDDAP hard-404s a hyperslab that starts outside an axis ("Start=10.0 is
 *   less than the axis minimum=30.25"), so a viewport larger than the dataset
 *   turned a usable rung into a total failure. {@link clampBoxToDataset}
 *   intersects first.
 * - Error bodies are refused, not parsed. ERDDAP reports failure as
 *   `text/plain` beginning `Error {` with `code=` / `message=` lines. The
 *   reference's CSV splitter drops only lines starting with "Error", so the
 *   remaining brace/`message=...` lines fell through into the row parser and
 *   inflated the reject count instead of failing. {@link parseHfrCsv0} refuses
 *   any body whose first line is not an ISO-timestamped data row.
 * - The two knobs are named and exported ({@link HFR_MAX_AGE_MS},
 *   {@link HFR_MIN_VECTORS}) rather than the reference's hardcoded
 *   `keep.length < 40`.
 *
 * @module server/ocean/hfradar
 */

/** @const {string} griddap root of the CoastWatch West Coast Node ERDDAP. */
export const HFR_ERDDAP_BASE = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';

/** @const {string[]} Variables requested per cell, in griddap column order. */
export const HFR_VARS = Object.freeze(['water_u', 'water_v', 'hdop']);

/**
 * @const {number} Speed gate, m/s per component. Inherited verbatim from the
 * reference project's `src/lib/ocean/domain.ts` (`MAX_CURRENT_MS = 2.4`). A
 * surface current with |u| or |v| above this in a coastal HFRNet domain is a
 * radial-unwrapping artifact, not water: the Gulf Stream core, the fastest
 * flow any of these boxes sees, tops out near 2.0 m/s (measured p95 0.553,
 * max 2.025 m/s over a 30x60 deg Gulf Stream box on the daily blended product).
 */
export const MAX_CURRENT_MS = 2.4;

/**
 * @const {number} Geometry gate, dimensionless. Inherited verbatim from the
 * reference's `domain.ts` (`HDOP_REJECT = 1.6`). Above it the two radials cross
 * too obliquely for the total vector to mean anything. For scale, the 52 finite
 * cells of the committed Monterey fixture (60 rows over 6 latitudes x 10
 * longitudes) span hdop 0.26..0.66, median 0.44 — a whole domain of
 * well-conditioned geometry sits far below the gate, which only bites along
 * baselines and outside the site fence. (The 92/100 figure in the `@file` block
 * is the larger LIVE 10x10 box that capture was drawn from, not the fixture.)
 */
export const HDOP_REJECT = 1.6;

/**
 * @const {number} hdop assumed when the column is absent, `NaN`, or negative,
 * so that a usable vector is never silently promoted to perfect confidence.
 *
 * Calibrated against the committed Monterey fixture's 52 finite cells
 * (hdop min 0.26, p25 0.38, median 0.44, p75 0.51, max 0.66): 0.4 sits just
 * below the median, giving `quality = 1/1.4 = 0.7143` against 0.6944 at the
 * median. So an unknown-DOP vector is scored a little BETTER than typical good
 * geometry and far worse than a perfect crossing — deliberately: the intent is
 * a mildly optimistic stand-in that still cannot outweigh a measured crossing,
 * not a penalty that would amount to inventing bad geometry from silence.
 *
 * Must be finite and >= 0; {@link parseHfrCsv0} rejects any other value rather
 * than emit a non-positive or infinite `quality` (see its `@throws`).
 */
export const HFR_DEFAULT_HDOP = 0.4;

/**
 * @const {number} Freshness bound: how far BEHIND the requested time a rung's
 * newest usable hour may sit and still be offered, in ms.
 *
 * This is one of the two knobs that decide whether a user sees real data or a
 * lie, and it is a genuine tension with no free choice:
 *  - FLOOR. HFRNet's own aggregation latency was measured at 8.2-10.2 h across
 *   all nine live datasets on 2026-09-01. Any bound at or below ~10 h rejects
 *   every dataset all of the time and the layer shows nothing, ever.
 *  - CEILING. Coastal surface currents are tidally dominated; the M2 semidiurnal
 *   constituent has a 12.42 h period, so an observation half a period old
 *   (~6.2 h) is drawn from near-antiphase flow and points roughly the WRONG WAY.
 * The floor exceeds the ceiling, so 12 h is chosen as the smallest round bound
 * that clears measured latency with ~2 h of margin, and the honesty burden is
 * pushed onto the caller instead: {@link fetchHfrField} always returns `ageMs`,
 * and a consumer that renders this field without surfacing that age is making
 * the claim this constant cannot.
 *
 * The bound is measured on the hour ACTUALLY SERVED, not on the hyperslab's
 * end: {@link fetchHfrField} requests {@link HFR_WINDOW_HOURS} of history as
 * insurance against an empty newest hour, so bounding only the request end
 * would let a rung that passed at 11 h serve an hour 6 h deeper in the window.
 * Measured before that was fixed: probe `2026-08-31T11:00:00Z`, sole hour
 * clearing the vector floor `05:00:00Z`, `atMs` `22:30:00Z` — `ageMs` 17.5 h
 * returned under a 12 h bound. Post-fix, `0 <= ageMs <= maxAgeMs` always holds.
 */
export const HFR_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * @const {number} Minimum QC-passing vectors in a single hour for that hour to
 * be served. The reference's equivalent knob is its hardcoded
 * `if (keep.length < 40) return null;` — kept at 40 here, but named.
 *
 * The second knob that decides real-data-or-lie. An objective analysis
 * (Barnes/OI) always returns a field; with too few observations that field is
 * overwhelmingly the background/decay term wearing an "observed" label. 40
 * vectors is roughly a 6x7 patch of cells — enough that the analysis interior
 * is observation-constrained rather than interpolation over one radar's
 * footprint. Below it, falling through to a coarser rung whose cells actually
 * have crossings beats reporting a confidently smooth fabrication.
 *
 * WARNING — this knob is coupled to `stride`. Decimating a 2-D hyperslab by k
 * divides the returned cell count by ~k^2, so raising `stride` pushes a box
 * under this floor quadratically. Measured 2026-09-01, north Puerto Rico box
 * (18.2..18.8 N, -67.0..-65.8 E) on `ucsdHfrP2` at the newest hour: 134 vectors
 * at stride 1 versus 30 at stride 2 — the same water, but stride 2 falls under
 * the floor and {@link fetchHfrField} correctly returns null. A caller that
 * raises `stride` to cut payload MUST lower `minVectors` in step or it will
 * silently see no data where data exists.
 */
export const HFR_MIN_VECTORS = 40;

/**
 * @const {number} Hours of hyperslab requested ending at the target hour.
 * Matches the reference's `6 * 3600000`. The window exists ONLY as insurance
 * against an empty newest hour — exactly one hour is ever returned.
 */
export const HFR_WINDOW_HOURS = 6;

/**
 * @const {number} Barnes length scale per unit of observation spacing.
 *
 * Chosen so the TWO-PASS response reaches half amplitude at exactly 4x the
 * observation spacing. For the Gaussian weight w(r) = exp(-r^2/L^2) the
 * single-pass response at wavelength lambda is D1 = exp(-pi^2 L^2 / lambda^2),
 * and pass 2 re-analyses the residual at L2 = L*sqrt(gamma), so the total is
 * D2 = D1 + D1^gamma (1 - D1) [Koch, DesJardins & Kocin 1983]. Solving
 * D2(4*delta) = 0.5 with gamma = 0.3 gives L = 2.0498*delta.
 *
 * WHY IT CHANGED. The previous rule, L = 2d + 6 km, inherited two anchors from
 * the reference project (L = 10 km at d = 2 km, 18 km at d = 6 km) and put the
 * half-amplitude wavelength at 19.5 km for the 2 km product — 10.5x the
 * measured observation spacing. Against a live ucsdHfrW2 request over Monterey
 * (710 QC-passing vectors, mean nearest-neighbour spacing 1.86 km) the response
 * at the data's own Nyquist wavelength 2*delta = 3.7 km was 0.0000, and at
 * 10 km only 0.052. The layer advertised "1 km HF radar" while delivering a
 * field smoothed to a ~16 km half-amplitude scale, barely finer than the global
 * tier it was meant to improve on.
 * @const {number}
 */
const BARNES_L_PER_SPACING = 2.0498;

/**
 * @const {number} Floor on the Barnes length scale, metres.
 *
 * The one physically-motivated part of the old rule, kept: L must not shrink
 * toward zero as the grid refines, because the useful analysis radius is
 * floored by the decorrelation scale of the surface current field itself, not
 * by the sampling grid. Fitting below that scale fits radial noise, not flow.
 * The old intercept placed that floor at 6 km of L (a ~12 km half-amplitude
 * wavelength), which is above published coastal submesoscale decorrelation
 * scales rather than at them; 2.05 km of L puts the half-amplitude wavelength
 * at 4 km, at the fine end of the O(5-10 km) range, and binds only for the
 * 0.5 km and 1 km products.
 *
 * FLAGGED AS AN ESTIMATE: the O(5-10 km) coastal decorrelation scale is
 * inherited from the reference project's rationale and is NOT sourced to a
 * paper here. It sets a floor, not the working value, and the working value at
 * every product coarser than 1 km is set by the spacing rule above.
 */
const BARNES_L_FLOOR_M = 2050;

/**
 * Barnes length scale for a product, metres: `L = 2.0498 * d`, floored.
 *
 * | d (km) | L (m) | half-amplitude wavelength | previously |
 * |--------|-------|---------------------------|------------|
 * | 0.5    |  2050 |  4.0 km (floored)         | 7 km       |
 * | 1      |  2050 |  4.0 km (floored)         | 8 km       |
 * | 2      |  4100 |  8.0 km                   | 10 km      |
 * | 6      | 12299 | 24.0 km                   | 18 km      |
 *
 * @param {number} resolutionKm - Native grid spacing, km.
 * @returns {number} Barnes length scale, metres.
 */
function lengthScaleForResolution(resolutionKm) {
  return Math.max(BARNES_L_FLOOR_M, Math.round(BARNES_L_PER_SPACING * resolutionKm * 1000));
}

/**
 * @const {ReadonlyArray<object>} The verified HFRNet total-vector ladder.
 *
 * Every `bbox` is the dataset's own `latitude`/`longitude` `actual_range` read
 * from its `.das` on 2026-09-01, not a hand-drawn region. Ordered finest-first
 * within each `domain`; `ucsdHfrW6` is deliberately absent because it no longer
 * exists (see the `@file` block).
 */
export const HFR_DATASETS = Object.freeze([
  Object.freeze({
    id: 'ucsdHfrW500',
    domain: 'us-west',
    resolutionKm: 0.5,
    lengthScaleM: lengthScaleForResolution(0.5),
    bbox: Object.freeze({ latMin: 37.45549, latMax: 38.13873, lonMin: -122.5935, lonMax: -122.0469 }),
    label: 'IOOS HF-radar US West Coast 500 m totals (ERDDAP ucsdHfrW500)',
  }),
  Object.freeze({
    id: 'ucsdHfrW1',
    domain: 'us-west',
    resolutionKm: 1,
    lengthScaleM: lengthScaleForResolution(1),
    bbox: Object.freeze({ latMin: 30.25, latMax: 49.99204, lonMin: -130.36, lonMax: -115.8056 }),
    label: 'IOOS HF-radar US West Coast 1 km totals (ERDDAP ucsdHfrW1)',
  }),
  Object.freeze({
    id: 'ucsdHfrW2',
    domain: 'us-west',
    resolutionKm: 2,
    lengthScaleM: lengthScaleForResolution(2),
    bbox: Object.freeze({ latMin: 30.25, latMax: 49.99204, lonMin: -130.36, lonMax: -115.8056 }),
    label: 'IOOS HF-radar US West Coast 2 km totals (ERDDAP ucsdHfrW2)',
  }),
  Object.freeze({
    id: 'ucsdHfrE1',
    domain: 'us-east-gulf',
    resolutionKm: 1,
    lengthScaleM: lengthScaleForResolution(1),
    bbox: Object.freeze({ latMin: 21.7, latMax: 46.49442, lonMin: -97.88385, lonMax: -57.19249 }),
    label: 'IOOS HF-radar US East Coast + Gulf of Mexico 1 km totals (ERDDAP ucsdHfrE1)',
  }),
  Object.freeze({
    id: 'ucsdHfrE2',
    domain: 'us-east-gulf',
    resolutionKm: 2,
    lengthScaleM: lengthScaleForResolution(2),
    bbox: Object.freeze({ latMin: 21.7, latMax: 46.49442, lonMin: -97.88385, lonMax: -57.19249 }),
    label: 'IOOS HF-radar US East Coast + Gulf of Mexico 2 km totals (ERDDAP ucsdHfrE2)',
  }),
  Object.freeze({
    id: 'ucsdHfrE6',
    domain: 'us-east-gulf',
    resolutionKm: 6,
    lengthScaleM: lengthScaleForResolution(6),
    bbox: Object.freeze({ latMin: 21.73596, latMax: 46.49442, lonMin: -97.88385, lonMax: -57.23121 }),
    label: 'IOOS HF-radar US East Coast + Gulf of Mexico 6 km totals (ERDDAP ucsdHfrE6)',
  }),
  Object.freeze({
    id: 'ucsdHfrH1',
    domain: 'hawaii',
    resolutionKm: 1,
    lengthScaleM: lengthScaleForResolution(1),
    bbox: Object.freeze({ latMin: 16.2204, latMax: 24.91688, lonMin: -163.1444, lonMax: -151.9565 }),
    label: "IOOS HF-radar US Hawai'i State 1 km totals (ERDDAP ucsdHfrH1)",
  }),
  Object.freeze({
    id: 'ucsdHfrP2',
    domain: 'puerto-rico',
    resolutionKm: 2,
    lengthScaleM: lengthScaleForResolution(2),
    bbox: Object.freeze({ latMin: 14.5, latMax: 21.99766, lonMin: -70.5, lonMax: -61.00562 }),
    label: 'IOOS HF-radar Puerto Rico + USVI 2 km totals (ERDDAP ucsdHfrP2)',
  }),
  Object.freeze({
    id: 'ucsdHfrP6',
    domain: 'puerto-rico',
    resolutionKm: 6,
    lengthScaleM: lengthScaleForResolution(6),
    bbox: Object.freeze({ latMin: 14.5, latMax: 21.99766, lonMin: -70.5, lonMax: -61.0242 }),
    label: 'IOOS HF-radar Puerto Rico + USVI 6 km totals (ERDDAP ucsdHfrP6)',
  }),
]);

/**
 * Normalize a longitude into [-180, 180). Accepts the 0..360 convention used by
 * the `*_Lon0360` twins and by many globe viewports.
 *
 * @param {number} lon - Degrees east, any range.
 * @returns {number} Equivalent longitude in [-180, 180), or NaN if not finite.
 */
export function wrapLon(lon) {
  if (!Number.isFinite(lon)) return NaN;
  // Identity fast path, and NOT merely an optimization: the modular form is
  // lossy in binary floating point for values already in range — it maps
  // -122.6 to -122.60000000000002 (the +180/-180 round trip is not exact).
  // That drift would leak verbatim into griddap constraint strings, making
  // request URLs unreadable and irreproducible for the same viewport.
  if (lon >= -180 && lon < 180) return lon;
  return (((lon + 180) % 360) + 360) % 360 - 180;
}

/**
 * Split a requested longitude span into 1 or 2 ascending intervals on
 * [-180, 180], so that a dateline-crossing or 0..360 box can be intersected
 * against dataset boxes that are all expressed on [-180, 180).
 *
 * Refuses nothing except non-finite input (which yields no intervals); a span of
 * 360 degrees or more collapses to the whole world rather than to a degenerate
 * point.
 *
 * @param {number} lonMin - West edge, degrees east, any range.
 * @param {number} lonMax - East edge, degrees east, any range.
 * @returns {Array<[number, number]>} One interval, or two when the span crosses
 *   +/-180. Empty when either edge is non-finite. Never contains a degenerate
 *   `[-180, -180]` tail.
 */
export function lonIntervals(lonMin, lonMax) {
  if (!Number.isFinite(lonMin) || !Number.isFinite(lonMax)) return [];
  if (lonMax - lonMin >= 360) return [[-180, 180]];
  const a = wrapLon(lonMin);
  let b = wrapLon(lonMax);
  // wrapLon's range is half-open, so it sends the east edge +180 to -180. A span
  // that merely ENDS on the antimeridian is not a dateline crossing: without
  // this, lonIntervals(0, 180) — the whole eastern hemisphere — returned
  // [[0, 180], [-180, -180]], the second a zero-width interval that can only
  // ever produce a spurious edge-touch match against a dataset reaching -180.
  if (b === -180 && a > b) b = 180;
  // After wrapping, a > b means the span steps over the antimeridian.
  if (a <= b) return [[a, b]];
  return [[a, 180], [-180, b]];
}

/**
 * Whether a requested box overlaps a dataset's coverage box, with dateline
 * handling on the request side. Touching edges count as overlap.
 *
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} box - Request.
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} coverage - Dataset bbox.
 * @returns {boolean} True when the boxes intersect in both lat and lon.
 */
export function boxIntersects(box, coverage) {
  const latMin = Math.min(box.latMin, box.latMax);
  const latMax = Math.max(box.latMin, box.latMax);
  if (latMax < coverage.latMin || latMin > coverage.latMax) return false;
  return lonIntervals(box.lonMin, box.lonMax)
    .some(([a, b]) => b >= coverage.lonMin && a <= coverage.lonMax);
}

/**
 * Candidate datasets whose coverage intersects the requested box, finest first.
 *
 * Pure and network-free: it decides only which rungs are geographically
 * plausible, never whether any of them actually has data there — coverage
 * inside an HFRNet box is sparse and only a real fetch can settle it. Ties in
 * resolution keep {@link HFR_DATASETS} order, so a box straddling two domains
 * yields an interleaved finest-first ladder.
 *
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} box -
 *   Requested lat/lon box; longitudes may be [-180,180), [0,360), or a
 *   dateline-crossing span with `lonMin > lonMax`.
 * @returns {Array<object>} Frozen {@link HFR_DATASETS} entries, ascending by
 *   `resolutionKm`. Empty when the box is off-coverage or malformed.
 */
export function selectHfrDatasets(box) {
  if (!box || !Number.isFinite(box.latMin) || !Number.isFinite(box.latMax)) return [];
  if (!Number.isFinite(box.lonMin) || !Number.isFinite(box.lonMax)) return [];
  return HFR_DATASETS
    .map((dataset, order) => ({ dataset, order }))
    .filter(({ dataset }) => boxIntersects(box, dataset.bbox))
    .sort((x, y) => (x.dataset.resolutionKm - y.dataset.resolutionKm) || (x.order - y.order))
    .map(({ dataset }) => dataset);
}

/**
 * Intersect a requested box with a dataset's coverage so ERDDAP receives a
 * hyperslab it can actually serve.
 *
 * ERDDAP does not clip: a constraint starting outside an axis is a hard 404
 * ("Start=10.0 is less than the axis minimum=30.25"), which the reference
 * implementation never guarded. Longitude is resolved to a single interval —
 * the widest one that overlaps coverage — because a griddap request cannot
 * express a wrapped span.
 *
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} box - Request.
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} coverage - Dataset bbox.
 * @returns {?{latMin:number,latMax:number,lonMin:number,lonMax:number}} Clamped
 *   box with all four edges finite, or null when there is no overlap or either
 *   argument is missing or carries a non-finite edge. It never returns a box
 *   with a NaN edge: `Math.max(NaN, x)` is NaN and `NaN > NaN` is false, so the
 *   ordering guard below cannot catch one, and such a box reached
 *   {@link buildHfrUrl} as a TypeError from deep inside the ladder.
 */
export function clampBoxToDataset(box, coverage) {
  if (!box || !coverage) return null;
  const edges = [box.latMin, box.latMax, box.lonMin, box.lonMax,
    coverage.latMin, coverage.latMax, coverage.lonMin, coverage.lonMax];
  if (!edges.every((edge) => Number.isFinite(edge))) return null;
  const latMin = Math.max(Math.min(box.latMin, box.latMax), coverage.latMin);
  const latMax = Math.min(Math.max(box.latMin, box.latMax), coverage.latMax);
  if (latMin > latMax) return null;
  let best = null;
  for (const [a, b] of lonIntervals(box.lonMin, box.lonMax)) {
    const lonMin = Math.max(a, coverage.lonMin);
    const lonMax = Math.min(b, coverage.lonMax);
    if (lonMin > lonMax) continue;
    if (!best || lonMax - lonMin > best.lonMax - best.lonMin) best = { lonMin, lonMax };
  }
  return best ? { latMin, latMax, lonMin: best.lonMin, lonMax: best.lonMax } : null;
}

/** Percent-encode only the griddap subset delimiters, per the ERDDAP URL spec. */
function encodeErddap(url) {
  return url.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
}

/**
 * Epoch ms floored to the top of its UTC hour — HFRNet's native time step.
 *
 * Floors toward -Infinity, so it is correct for pre-1970 epochs too.
 *
 * @param {number} ms - Epoch milliseconds.
 * @returns {number} Epoch ms at :00:00.000 of the containing hour; NaN for
 *   non-finite input, which it propagates rather than substituting an hour for.
 */
export function floorToHourMs(ms) {
  return Math.floor(ms / 3600000) * 3600000;
}

/**
 * ISO-8601 UTC stamp, the form ERDDAP accepts in constraints. A string passes
 * through verbatim; a number is rendered from epoch ms.
 *
 * Only an exactly-zero millisecond field is dropped (`.000Z` -> `Z`), never a
 * non-zero one: stripping `.500Z` would silently move the request by half a
 * second and, in {@link parseHfrCsv0}, would make the emitted `time` string
 * disagree with the `timeMs` beside it — the same row landing in one hour
 * bucket while advertising another.
 */
function isoStamp(value) {
  if (typeof value === 'string') return value;
  return new Date(value).toISOString().replace(/\.000Z$/, 'Z');
}

/** ERDDAP `.csv0` time stamps: `YYYY-MM-DDTHH:MM:SS[.sss][Z|+-HH:MM]`. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse an ERDDAP timestamp to epoch ms, reading a designator-less stamp as UTC.
 *
 * Bare `Date.parse` cannot be used here. Per the ECMAScript Date Time String
 * Format, a date-TIME form with no offset is interpreted as LOCAL time, so
 * `Date.parse('2026-08-31T22:00:00')` returns a value 7 h off the true instant
 * under `TZ=America/Los_Angeles` (measured). Every freshness decision in this
 * module — the `maxAgeMs` gate, `ageMs`, which hour is "newest" — would then
 * depend on the server's configured zone. ERDDAP time axes are defined as
 * `seconds since 1970-01-01T00:00:00Z` and `.csv0` renders them in UTC, so the
 * missing designator is read as `Z`: that is the source's own convention, not a
 * substituted value.
 *
 * @param {string} text - Candidate stamp; surrounding whitespace is ignored.
 * @returns {number} Epoch ms, or NaN when the text is not an ERDDAP timestamp.
 *   Refuses anything `Date.parse` would accept loosely — a bare date, a
 *   locale string, `'not-a-time'` — rather than guess at it.
 */
function parseIsoUtcMs(text) {
  const s = String(text ?? '').trim();
  const match = ISO_STAMP.exec(s);
  if (!match) return NaN;
  const ms = Date.parse(match[2] ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Build the exact ERDDAP griddap URL for one HF-radar hyperslab.
 *
 * Shape: `<base>/<id>.csv0?<var>[(t0):1:(t1)][(latMin):stride:(latMax)][(lonMin):stride:(lonMax)]`
 * repeated per variable and comma-joined, with `[` and `]` percent-encoded to
 * `%5B`/`%5D`. The time stride is fixed at 1 — HFRNet is already hourly and
 * decimating it would alias the tide. `.csv0` (headerless) is used rather than
 * `.json`: on a Gulf Stream-sized box the table-JSON form was ~2.1 MB where the
 * same rows in `.csv0` are a small fraction of that.
 *
 * Pure. It builds precisely what it is given and refuses malformed input: it
 * does NOT clamp the box to dataset coverage (see {@link clampBoxToDataset}),
 * does not reorder variables, and does not check that the dataset exists.
 *
 * @param {string} datasetId - griddap dataset id, e.g. `ucsdHfrW2`.
 * @param {string[]} vars - Variable names in the order their columns should appear.
 * @param {string|number} t0 - Window start: ISO-8601 UTC string, or epoch ms.
 * @param {string|number} t1 - Window end, same forms as `t0`.
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} box - Hyperslab
 *   corners in degrees; min/max are used as given, so they must already be ascending.
 * @param {number} [stride=1] - Spatial index stride, a positive integer applied to
 *   both lat and lon.
 * @param {string} [base=HFR_ERDDAP_BASE] - griddap root, overridable for tests.
 * @returns {string} Fully encoded absolute URL.
 * @throws {TypeError} On an empty `datasetId`, an empty `vars`, a `t0`/`t1` that
 *   is neither a non-empty string nor a finite number, a non-integer or
 *   non-positive `stride`, or a box with a non-finite or descending edge.
 */
export function buildHfrUrl(datasetId, vars, t0, t1, box, stride = 1, base = HFR_ERDDAP_BASE) {
  if (typeof datasetId !== 'string' || datasetId.length === 0) {
    throw new TypeError('buildHfrUrl: datasetId must be a non-empty string');
  }
  if (!Array.isArray(vars) || vars.length === 0) {
    throw new TypeError('buildHfrUrl: vars must be a non-empty array');
  }
  // Unchecked, a non-finite epoch reaches `new Date(NaN).toISOString()`, whose
  // RangeError surfaces far from the caller that supplied it — and inside the
  // ladder's catch it would be indistinguishable from a dead rung.
  for (const [name, value] of [['t0', t0], ['t1', t1]]) {
    const ok = typeof value === 'string' ? value.trim().length > 0 : Number.isFinite(value);
    if (!ok) {
      throw new TypeError(`buildHfrUrl: ${name} must be a non-empty ISO-8601 string or finite epoch ms, got ${value}`);
    }
  }
  if (!Number.isInteger(stride) || stride < 1) {
    throw new TypeError(`buildHfrUrl: stride must be a positive integer, got ${stride}`);
  }
  const edges = [box?.latMin, box?.latMax, box?.lonMin, box?.lonMax];
  if (!edges.every((edge) => Number.isFinite(edge))) {
    throw new TypeError('buildHfrUrl: box edges must all be finite numbers');
  }
  if (box.latMin > box.latMax || box.lonMin > box.lonMax) {
    throw new TypeError('buildHfrUrl: box edges must be ascending (latMin<=latMax, lonMin<=lonMax)');
  }
  const dims = `[(${isoStamp(t0)}):1:(${isoStamp(t1)})]`
    + `[(${box.latMin}):${stride}:(${box.latMax})]`
    + `[(${box.lonMin}):${stride}:(${box.lonMax})]`;
  const query = vars.map((v) => `${v}${dims}`).join(',');
  return encodeErddap(`${base}/${datasetId}.csv0?${query}`);
}

/**
 * Build the one-value URL that reveals a dataset's true newest timestamp.
 *
 * This is the only trustworthy freshness signal — dataset titles claim "Near
 * Real Time" regardless of whether the data stopped years ago. Note it is
 * necessary but NOT sufficient: `ucsdHfrW6_Lon0360` answered this probe from
 * cached axis metadata while every data request behind it failed.
 *
 * @param {string} datasetId - griddap dataset id.
 * @param {string} [base=HFR_ERDDAP_BASE] - griddap root, overridable for tests.
 * @returns {string} Encoded `<base>/<id>.csv0?time%5B(last)%5D`.
 * @throws {TypeError} When `datasetId` is not a non-empty string.
 */
export function buildHfrProbeUrl(datasetId, base = HFR_ERDDAP_BASE) {
  if (typeof datasetId !== 'string' || datasetId.length === 0) {
    throw new TypeError('buildHfrProbeUrl: datasetId must be a non-empty string');
  }
  return encodeErddap(`${base}/${datasetId}.csv0?time[(last)]`);
}

/** First non-empty line of a body, or '' when there is none. */
function firstLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** A griddap `.csv0` data row always begins with an ISO-8601 UTC stamp + comma. */
const DATA_ROW_HEAD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?,/;

/**
 * Reject any body that is not headerless griddap CSV before a single row is read.
 *
 * ERDDAP signals failure with a `text/plain` envelope beginning `Error {`
 * followed by `code=` / `message="..."` lines; proxies and gateways return HTML.
 * Both contain commas, so a permissive row splitter yields plausible-looking
 * garbage rows. Refusing up front is what makes a failed rung fall through
 * cleanly instead of contributing a partially-parsed field.
 *
 * @param {string} text - Raw response body.
 * @returns {void}
 * @throws {Error} When the body is empty, an ERDDAP error envelope, HTML/XML,
 *   JSON, or headered `.csv` rather than `.csv0`.
 */
export function assertHfrCsv0(text) {
  const head = firstLine(text);
  if (head === '') throw new Error('HF-radar response was empty');
  if (/^Error\b/.test(head) || head.startsWith('{') || head.startsWith('[')) {
    throw new Error(`HF-radar response was an ERDDAP error envelope, not CSV: ${head.slice(0, 160)}`);
  }
  if (head.startsWith('<')) {
    throw new Error(`HF-radar response was markup, not CSV: ${head.slice(0, 160)}`);
  }
  if (!DATA_ROW_HEAD.test(head)) {
    throw new Error(`HF-radar response did not start with a griddap .csv0 data row: ${head.slice(0, 160)}`);
  }
}

/** Numeric cell -> finite number; `NaN`/blank/sentinel -> NaN. */
function cell(value) {
  if (value === undefined) return NaN;
  const s = value.trim();
  if (s === '' || s === 'NaN' || s === 'null') return NaN;
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
}

/**
 * Parse a headerless griddap `.csv0` body into QC-passing HF-radar observations.
 *
 * Column order is the griddap contract: `time, latitude, longitude` followed by
 * the requested variables — `water_u, water_v` and, when `hasHdop`, `hdop`.
 *
 * QC gates, applied in order, each incrementing `rejected` and dropping the row:
 *  1. unparseable timestamp, or non-finite `latitude`/`longitude`;
 *  2. wrong column count for the requested variable set;
 *  3. non-finite `u` or `v` — the sparse-coverage `NaN` fill, by far the most
 *     common rejection (8 of 60 rows in the committed Monterey fixture);
 *  4. `|u| > maxCurrentMs` or `|v| > maxCurrentMs` — radial-unwrapping artifacts;
 *  5. `hdop > hdopReject` — radial crossing geometry too oblique to invert.
 * A row whose hdop is absent, `NaN`, or NEGATIVE is KEPT and scored with
 * `defaultHdop`: a missing DOP is not evidence of bad geometry, and hdop is
 * `|(dopx, dopy)|`, a vector magnitude, so a negative value is not a
 * measurement at all but an undeclared fill or a corrupt column — the same
 * epistemic state as an absent one. Taken literally it would be far worse than
 * useless downstream: `quality = 1/(1 + hdop)` is <= 0 for hdop <= -1 and
 * exactly `+Infinity` at hdop = -1, and `src/server/ocean/barnes.js` documents
 * (with a measured 11x11 fixture) that a single `+Infinity` weight makes
 * `Sum w = Infinity` and takes every analysed cell to NaN. This module is the
 * upstream that file names, so it must never emit one.
 *
 * Deterministic and pure: takes text, never fetches, and preserves input row
 * order in `observations`. It refuses a non-CSV body outright rather than
 * salvaging rows from it (see {@link assertHfrCsv0}).
 *
 * @param {string} text - Raw `.csv0` body.
 * @param {object} [options] - Overrides.
 * @param {boolean} [options.hasHdop=true] - Whether an `hdop` column was requested.
 * @param {number} [options.defaultHdop=HFR_DEFAULT_HDOP] - hdop assumed when the
 *   column is absent, `NaN`, or negative. Must be finite and >= 0.
 * @param {number} [options.maxCurrentMs=MAX_CURRENT_MS] - Per-component speed gate, m/s.
 * @param {number} [options.hdopReject=HDOP_REJECT] - Upper hdop bound, inclusive-pass.
 * @returns {{observations: Array<object>, rejected: number, times: string[]}}
 *   `observations` carry `{lat, lon, u, v, hdop, quality, time, timeMs}` in input
 *   order, with `hdop >= 0` and `quality = 1/(1 + hdop)` in (0, 1] guaranteed;
 *   `time` is the exact ISO rendering of `timeMs`; `rejected` counts dropped
 *   rows; `times` are the distinct ISO stamps of KEPT rows, ascending.
 * @throws {Error} When the body is not griddap `.csv0`.
 * @throws {TypeError} When `defaultHdop`, `maxCurrentMs`, or `hdopReject` is not
 *   a finite non-negative number — each would otherwise silently disable a gate
 *   or manufacture an out-of-range `quality`.
 */
export function parseHfrCsv0(text, options = {}) {
  const {
    hasHdop = true,
    defaultHdop = HFR_DEFAULT_HDOP,
    maxCurrentMs = MAX_CURRENT_MS,
    hdopReject = HDOP_REJECT,
  } = options;
  for (const [name, value] of [
    ['defaultHdop', defaultHdop], ['maxCurrentMs', maxCurrentMs], ['hdopReject', hdopReject],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`parseHfrCsv0: ${name} must be a finite number >= 0, got ${value}`);
    }
  }
  assertHfrCsv0(text);

  const expectedColumns = hasHdop ? 6 : 5;
  const observations = [];
  const times = new Set();
  let rejected = 0;

  for (const line of String(text).split(/\r?\n/)) {
    const row = line.trim();
    if (row.length === 0) continue;
    const parts = row.split(',');
    if (parts.length !== expectedColumns) { rejected += 1; continue; }

    const timeMs = parseIsoUtcMs(parts[0]);
    const lat = cell(parts[1]);
    const lon = cell(parts[2]);
    if (!Number.isFinite(timeMs) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      rejected += 1;
      continue;
    }

    const u = cell(parts[3]);
    const v = cell(parts[4]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) { rejected += 1; continue; }
    if (Math.abs(u) > maxCurrentMs || Math.abs(v) > maxCurrentMs) { rejected += 1; continue; }

    const rawHdop = hasHdop ? cell(parts[5]) : NaN;
    if (Number.isFinite(rawHdop) && rawHdop > hdopReject) { rejected += 1; continue; }
    // `>= 0` and not merely `Number.isFinite`: see the negative-hdop paragraph
    // above. This is the single line that keeps `quality` inside (0, 1].
    const hdop = Number.isFinite(rawHdop) && rawHdop >= 0 ? rawHdop : defaultHdop;

    const iso = isoStamp(timeMs);
    times.add(iso);
    observations.push({
      lat,
      lon,
      u,
      v,
      hdop,
      // Inverse-DOP weight in (0,1]: 1 for a perfectly conditioned crossing,
      // 0.385 at the hdop=1.6 reject boundary. Consumed as the Barnes/OI
      // observation weight alongside HFR_SIGMA0.
      quality: 1 / (1 + hdop),
      time: iso,
      timeMs,
    });
  }

  return { observations, rejected, times: [...times].sort() };
}

/**
 * Read a dataset's newest timestamp out of a `time[(last)]` probe body.
 *
 * Strict, and deliberately so: it returns null for anything that is not a
 * complete ERDDAP timestamp, rather than letting a truncated or malformed stamp
 * through. It is also timezone-independent — see {@link parseIsoUtcMs} — so the
 * freshness verdict does not depend on the server's `TZ`.
 *
 * @param {string} text - Probe response body (one bare ISO stamp).
 * @returns {?number} Epoch ms, or null when the body is not a timestamp.
 */
export function parseHfrProbe(text) {
  const ms = parseIsoUtcMs(firstLine(text).split(',')[0]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @const {number} Per-request network timeout, ms.
 *
 * Without one, a hung ERDDAP socket falls through to undici's 300 s default
 * headers/body timeout, and the field handler coalesces concurrent callers onto
 * one in-flight promise — so a single stall held a cache key for minutes, and a
 * 3-rung box can issue 6 sequential requests. 20 s matches
 * `globalCurrents.DEFAULT_TIMEOUT_MS` and every other `/api/ocean` fetch in
 * `vite.config.js`. The measured p50 for a 1°×1° W1 request is ~7 s.
 */
export const HFR_TIMEOUT_MS = 20000;

/**
 * @const {number} Maximum response body, bytes.
 *
 * This module was the only ocean fetcher enforcing neither a timeout nor a cap,
 * and `response.text()` buffers a body whole. The cap is above
 * `globalCurrents.RESPONSE_BYTE_CAP` (2 MiB) because the payloads genuinely
 * differ: the widest legitimate request here is the `windowHours` fallback on
 * the finest rung, measured 2026-09-01 at 3.85 MiB for a 1°×1° `ucsdHfrW1` box.
 * 8 MiB leaves ~2x headroom over that while still bounding a runaway body.
 * The common path is far smaller — the narrow-first fetch in
 * {@link fetchHfrField} makes it 0.55 MiB. Exceeding the cap throws, so the
 * ladder falls through to a coarser rung rather than parsing a truncated body.
 */
export const HFR_RESPONSE_BYTE_CAP = 8 * 1024 * 1024;

/**
 * Bind an abort signal that fires on the caller's signal OR a timeout.
 * Mirrors `globalCurrents.abortAfter`.
 */
function abortAfter(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`HF-radar: upstream timed out after ${timeoutMs} ms`)),
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
 * Fetch a URL as text, enforcing HTTP success, a timeout and the byte cap.
 * A non-2xx, a stall or an oversized body all throw, so the ladder falls
 * through to the next rung instead of hanging or parsing a partial field.
 */
async function fetchText(fetchImpl, url, signal, timeoutMs = HFR_TIMEOUT_MS) {
  const bound = abortAfter(signal, timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: bound.signal });
    if (!response || response.ok === false) {
      throw new Error(`HF-radar HTTP ${response ? response.status : 'no response'} for ${url}`);
    }
    // Trust `content-length` when offered so an oversized body is refused
    // before it is buffered; otherwise measure what actually arrived.
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > HFR_RESPONSE_BYTE_CAP) {
      throw new Error(`HF-radar response ${declared} B exceeds the ${HFR_RESPONSE_BYTE_CAP} B cap for ${url}`);
    }
    const text = await response.text();
    if (text.length > HFR_RESPONSE_BYTE_CAP) {
      throw new Error(`HF-radar response ${text.length} B exceeds the ${HFR_RESPONSE_BYTE_CAP} B cap for ${url}`);
    }
    return text;
  } finally {
    bound.release();
  }
}

/**
 * The newest hour in `observations` that may be served, or undefined.
 *
 * All three conditions are load-bearing:
 * - `hourMs <= targetMs` keeps `ageMs >= 0`. A body may carry an hour past the
 *   end of the hyperslab we asked for (a mirror serving a snapped index, a
 *   stale cache), and reporting a NEGATIVE age would claim a measurement from
 *   the future.
 * - `atMs - hourMs <= maxAgeMs` enforces the freshness bound on the hour
 *   actually served, which the probe gate cannot: the served hour may be up to
 *   `windowHours` older than the target that passed the probe.
 * - the vector floor, so the field is observation-constrained.
 *
 * One hour only, never a multi-hour pool — tidal currents 6 h apart are near
 * antiphase, and averaging them would cancel the very signal the tier exists to
 * show.
 *
 * @param {Array<{timeMs: number}>} observations - QC-passing vectors.
 * @param {{targetMs: number, atMs: number, maxAgeMs: number, minVectors: number}} bounds
 * @returns {number|undefined} Epoch ms of the servable hour.
 */
export function selectServableHour(observations, { targetMs, atMs, maxAgeMs, minVectors }) {
  const counts = new Map();
  for (const obs of observations) counts.set(obs.timeMs, (counts.get(obs.timeMs) ?? 0) + 1);
  return [...counts.keys()]
    .sort((a, b) => b - a)
    .find((hourMs) => hourMs <= targetMs
      && atMs - hourMs <= maxAgeMs
      && counts.get(hourMs) >= minVectors);
}

/**
 * Fetch the finest usable HF-radar surface-current field covering a box.
 *
 * The ladder, per candidate from {@link selectHfrDatasets} (finest first):
 *  1. probe `time[(last)]` for the dataset's true newest hour;
 *  2. target the older of that hour and the requested hour, and REJECT the rung
 *     when the target trails `atMs` by more than `maxAgeMs` (a rung whose data
 *     stopped years ago dies here, whatever its title claims);
 *  3. clamp the box to the dataset's coverage and request a `windowHours`
 *     hyperslab ending at the target;
 *  4. parse with full QC, group the survivors by hour, and take the NEWEST hour
 *     that is no newer than the target, is itself within `maxAgeMs` of `atMs`,
 *     and holds at least `minVectors` vectors — one hour only, never a
 *     multi-hour pool, because tidal currents 6 h apart are near-antiphase;
 *  5. on any failure — probe error, HTTP error, error-envelope body, empty
 *     coverage, or too few vectors — move to the next rung.
 * Returns null only when every candidate fails. It never falls back to a
 * partially-parsed or stale-but-oversized field: an absent answer is the
 * honest one.
 *
 * Note that the freshness bound is tested TWICE, and neither test is redundant.
 * Step 2 bounds the probe's newest hour, which costs nothing and lets a
 * long-dead rung be abandoned without a data request at all. Step 4 bounds the
 * hour actually served, which can be up to `windowHours` older than the target
 * because the window exists precisely to survive an empty newest hour. With
 * only the first, a rung probing at 11 h could serve a 17.5 h-old hour under a
 * 12 h bound (measured; see {@link HFR_MAX_AGE_MS}).
 *
 * @param {object} options - Request.
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} options.box -
 *   Requested box; longitudes may be [-180,180), [0,360), or dateline-crossing.
 * @param {number} [options.atMs=Date.now()] - Requested valid time, epoch ms.
 * @param {Function} [options.fetchImpl=globalThis.fetch] - `fetch`-shaped
 *   `(url, init) => Promise<{ok, status, text()}>`. Injectable so tests never
 *   touch the network.
 * @param {number} [options.stride=1] - Spatial index stride passed to griddap.
 *   Cuts payload by ~stride^2 but cuts the realized vector count by the same
 *   factor; raise it only together with a lowered `minVectors` (see
 *   {@link HFR_MIN_VECTORS}).
 * @param {Array<object>} [options.datasets] - Candidate override; defaults to
 *   {@link selectHfrDatasets}`(box)`.
 * @param {number} [options.windowHours=HFR_WINDOW_HOURS] - Hyperslab depth in hours.
 * @param {number} [options.maxAgeMs=HFR_MAX_AGE_MS] - Freshness bound.
 * @param {number} [options.minVectors=HFR_MIN_VECTORS] - Per-hour vector floor.
 * @param {AbortSignal} [options.signal] - Forwarded to `fetchImpl`, and honoured
 *   by the ladder itself: once aborted it stops rather than working down the
 *   remaining rungs with a dead signal.
 * @param {string} [options.base=HFR_ERDDAP_BASE] - griddap root.
 * @returns {Promise<?object>} `{observations, datasetId, resolutionKm,
 *   lengthScaleM, validAtMs, ageMs, rejected, source}` — `observations` all
 *   share `validAtMs` and are in served-row order; `0 <= ageMs <= maxAgeMs`
 *   where `ageMs = atMs - validAtMs`; `rejected` counts dropped rows across the
 *   WHOLE requested window, not just `validAtMs`. Null when no rung qualifies.
 * @throws {TypeError} When `fetchImpl` is not a function, `atMs` is not finite,
 *   or `stride`/`windowHours`/`maxAgeMs`/`minVectors` is out of range. These are
 *   caller bugs, so they are raised rather than folded into the ladder's
 *   fall-through, where they would be reported as the indistinguishable and
 *   much more alarming answer "there is no HF-radar data here".
 * @throws {DOMException|Error} The abort reason, when `signal` is aborted.
 */
export async function fetchHfrField(options = {}) {
  const {
    box,
    atMs = Date.now(),
    fetchImpl = globalThis.fetch,
    stride = 1,
    datasets = null,
    windowHours = HFR_WINDOW_HOURS,
    maxAgeMs = HFR_MAX_AGE_MS,
    minVectors = HFR_MIN_VECTORS,
    signal = null,
    base = HFR_ERDDAP_BASE,
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchHfrField: fetchImpl must be a function');
  }
  // Validated HERE, before the loop, and not left to buildHfrUrl inside it: the
  // ladder's catch cannot tell a caller's bad `stride` from a dead dataset, so
  // an unvalidated stride of 0 used to make every rung throw and the function
  // return a perfectly ordinary-looking `null`.
  if (!Number.isFinite(atMs)) {
    throw new TypeError(`fetchHfrField: atMs must be a finite epoch-ms number, got ${atMs}`);
  }
  if (!Number.isInteger(stride) || stride < 1) {
    throw new TypeError(`fetchHfrField: stride must be a positive integer, got ${stride}`);
  }
  if (!Number.isFinite(windowHours) || windowHours < 0) {
    throw new TypeError(`fetchHfrField: windowHours must be a finite number >= 0, got ${windowHours}`);
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError(`fetchHfrField: maxAgeMs must be a finite number >= 0, got ${maxAgeMs}`);
  }
  if (!Number.isFinite(minVectors) || minVectors < 0) {
    throw new TypeError(`fetchHfrField: minVectors must be a finite number >= 0, got ${minVectors}`);
  }

  const candidates = datasets || selectHfrDatasets(box);
  const requestedHourMs = floorToHourMs(atMs);

  for (const dataset of candidates) {
    signal?.throwIfAborted?.();
    try {
      const lastMs = parseHfrProbe(
        await fetchText(fetchImpl, buildHfrProbeUrl(dataset.id, base), signal),
      );
      if (lastMs === null) continue;

      // Never ask for a future hour; never accept one too far in the past.
      const targetMs = Math.min(floorToHourMs(lastMs), requestedHourMs);
      if (atMs - targetMs > maxAgeMs) continue;

      const clamped = clampBoxToDataset(box, dataset.bbox);
      if (!clamped) continue;

      // Narrow first, widen only on a miss. The hyperslab is one request per
      // rung, and only ONE hour of it is ever served (see the selection below),
      // so asking for `windowHours` up front pays for `windowHours + 1` hours to
      // use one. Measured 2026-09-01 on ucsdHfrW1 over a 1°×1° Monterey box:
      // the target hour alone is 0.55 MiB / 10,865 rows / 5.8 s, the 7-hour
      // window 3.85 MiB / 76,049 rows / 7.5 s — 7x the bytes for the same
      // answer whenever the target hour is itself servable, which is the common
      // case. The window still exists for when it is not: HFRNet hours go
      // missing, and a rung whose newest hour is thin should fall back in time
      // before it falls back to a coarser product.
      const attempts = windowHours > 0 ? [0, windowHours] : [0];
      let observations = [];
      let rejected = 0;
      let url = null;
      let validAtMs;
      for (const hoursBack of attempts) {
        url = buildHfrUrl(
          dataset.id, HFR_VARS, targetMs - hoursBack * 3600000, targetMs, clamped, stride, base,
        );
        ({ observations, rejected } = parseHfrCsv0(
          await fetchText(fetchImpl, url, signal),
          { hasHdop: true },
        ));
        validAtMs = selectServableHour(observations, { targetMs, atMs, maxAgeMs, minVectors });
        if (validAtMs !== undefined) break;
      }
      if (validAtMs === undefined) continue;

      // Group by hour and take the newest hour that is servable. All three
      // conditions are load-bearing:
      //  - `hourMs <= targetMs` keeps `ageMs >= 0`. A body may carry an hour
      //    past the end of the hyperslab we asked for (a mirror serving a
      //    snapped index, a stale cache), and reporting a NEGATIVE age would
      //    claim a measurement from the future.
      //  - `atMs - hourMs <= maxAgeMs` enforces the freshness bound on the hour
      //    actually served, which the probe gate above cannot: the served hour
      //    may be up to `windowHours` older than the target it passed on.
      //  - the vector floor, so the field is observation-constrained.
      const hourObs = observations.filter((obs) => obs.timeMs === validAtMs);
      return {
        observations: hourObs,
        datasetId: dataset.id,
        resolutionKm: dataset.resolutionKm,
        lengthScaleM: dataset.lengthScaleM,
        validAtMs,
        ageMs: atMs - validAtMs,
        rejected,
        source: {
          id: `hfr-${dataset.id}`,
          label: dataset.label,
          kind: 'observed',
          url,
          fetchedAtMs: Date.now(),
          validAtMs,
          records: hourObs.length,
          note: 'Hourly HFRNet radial least-squares total vectors, quality-controlled '
            + `by speed (<= ${MAX_CURRENT_MS} m/s per component) and geometry (hdop <= ${HDOP_REJECT}).`,
        },
      };
    } catch (error) {
      // An abort is the caller withdrawing the request, not a rung failing.
      // Swallowing it made the ladder issue a fetch per remaining rung against
      // a dead signal and then report the cancellation as `null` — "there is no
      // HF-radar data here", which is a different and false claim.
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      // A dead, throttled, or lying rung must not end the ladder — the next
      // coarser product is usually healthy. Measured: ucsdHfrW6_Lon0360 served
      // a valid time probe while every data request behind it failed.
      continue;
    }
  }

  return null;
}
