/**
 * @file Tier decision and wire format for the animated ocean-current layer.
 *
 * This module answers one question for the HTTP handler: *given this view
 * rectangle, what current field do we serve, and how honest is it?* It picks a
 * data tier, builds the lattice the field is served on, drives the fetchers and
 * the objective analysis, and emits a single self-describing JSON payload whose
 * `provenance` block is everything the layer's legend needs.
 *
 * ## Tiers
 *
 * | id          | source                                                  | native spacing  | latency        |
 * |-------------|---------------------------------------------------------|-----------------|----------------|
 * | `hfr`       | IOOS HF-radar total vectors (CoastWatch ERDDAP)          | 1 / 2 / 6 km    | ~1–3 h         |
 * | `global`    | HYCOM ESPC-D-V02 forecast (preferred)                    | 0.04°×0.08°     | −10 d … +5 d   |
 * | `global`    | NOAA multi-mission altimetry, geostrophic only (fallback) | 0.25° ≈ 27.8 km | ~3 days        |
 * | `composite` | radar over whichever global source served, per cell      | mixed           | mixed          |
 *
 * `hfr` is a two-pass Barnes objective analysis of quality-controlled radial
 * least-squares totals — an *observed* product. `global` is *derived* or
 * *modeled* depending on which of its two products served, and the two are NOT
 * the same physics: HYCOM integrates primitive equations and carries wind drift
 * and eight tidal constituents, while the altimetry analysis is absolute
 * geostrophic velocity and nothing else — no Ekman, no tides. Which one served,
 * and its physics, ride in `provenance.kind` / `.method` and onto the legend,
 * because this project does not let a three-day-old geostrophic field
 * masquerade as a live observation — nor as a tidal one. See
 * `./globalTier.js` for the selection and the measured case for preferring
 * HYCOM.
 *
 * The tier is chosen from the view box's ground SPAN, never from a zoom level:
 * see {@link chooseTier}. A cheap HF-radar analysis over a continent-sized box
 * would be sub-pixel detail nobody can see; a coarse 27.8 km field over a bay
 * would be four arrows.
 *
 * ## Compositing
 *
 * HF radar is a COASTAL network with finite range, so any view holding open
 * ocean has radar voids by construction. Choosing one tier for the whole view
 * therefore had to be wrong in one of two ways: serve a mostly-empty field, or
 * throw away real 1 km observations because a corner of the view is out of
 * range. Measured live 2026-09-01: a 1°×1° box over Monterey Bay covered 20% of
 * the water and was demoted whole to the 0.25° product, while a 0.6°×0.6° box
 * moved offshore covered 99.9% (629 vectors, holdout RMSE 0.069 m/s).
 *
 * So the two tiers are composited instead. The HF-radar analysis is built on the
 * target lattice as before; the global field arrives on its own 0.25° axes and
 * is BILINEARLY RESAMPLED onto that same lattice
 * ({@link resampleBilinearOntoGrid}); each water cell then takes the HF value if
 * it has one, else the resampled global value, else `null`. The two are never
 * averaged into one vector — a drawn cell has exactly ONE provenance, and
 * `provenance.sources` reports what each contributed
 * (`sources[i].cellShare` sums to 1 over the finite cells).
 *
 * Both directions of the split are cost-controlled: the global request is
 * skipped when HF already covers {@link HFR_SATURATION_COVERAGE} of the water
 * (nothing left to fill), and the Barnes pass is skipped when the fetcher
 * returns fewer than {@link MIN_HFR_OBSERVATIONS} usable vectors (nothing to
 * analyse). An HF analysis that fills less than {@link MIN_HFR_CONTRIBUTION} of
 * the water is dropped from the composite as speckle, not because it is
 * untrustworthy but because a legend row and a scatter of isolated 1 km cells
 * over a smooth 27.8 km field is worse than the field alone.
 *
 * ## Wire format — `gev-ocean-field` v1
 *
 * Every response, success or not, is this object. `status` MUST be checked
 * first; on failure `grid`, `u`, `v`, `stats` and `provenance` are all `null`
 * (never an array of nulls — a mostly-empty field renders as a broken layer,
 * so we refuse to serve one and say why instead).
 *
 * ```jsonc
 * {
 *   "status": "ok" | "unavailable",
 *   "format": "gev-ocean-field",
 *   "version": 1,
 *   "generatedAtMs": 1756694400000,   // server clock when the payload was built
 *   "requestedAtMs": 1756694400000,   // the `atMs` the caller asked the field for
 *   "box": { "latMin": .., "lonMin": .., "latMax": .., "lonMax": .. },
 *
 *   // ---- geometry (status === "ok") -------------------------------------
 *   // Axes are reconstructed ARITHMETICALLY; no coordinate arrays are shipped.
 *   //   lat(i) = lat0 + i * dLat   for i in [0, nLat)
 *   //   lon(j) = lon0 + j * dLon   for j in [0, nLon)
 *   // dLat and dLon are ALWAYS > 0 (row 0 is the southernmost, column 0 the
 *   // westernmost) — a descending source axis is flipped before serving, and a
 *   // source axis of a single point takes its step from the fetcher's own
 *   // reported resolution or else the tier is refused. Never 0: clients divide.
 *   // lon(j) may exceed +180 when the box crosses the antimeridian; the
 *   // client must wrap into [-180, 180) itself.
 *   "grid": { "lat0": .., "lon0": .., "dLat": .., "dLon": .., "nLat": .., "nLon": .. },
 *
 *   // ---- field (status === "ok") -----------------------------------------
 *   // Row-major, length nLat*nLon, index = latIndex * nLon + lonIndex.
 *   // Units m/s in the local ENU frame: u eastward, v northward.
 *   // `null` means NO DATA at that cell (land, outside radar coverage AND outside
 *   // the global field's reach, a Barnes void, or a value past the CONTRIBUTING
 *   // TIER's per-component magnitude gate — FIELD_SANITY_MAX_MS on hfr,
 *   // GLOBAL_FIELD_SANITY_MAX_MS on global) and is
 *   // NEVER to be drawn as a zero vector. u[k] and v[k] are null together.
 *   // Values are rounded to 3 decimals (1 mm/s) — 80x below the HF-radar
 *   // total-vector 1-sigma of 0.08 m/s, so the rounding is not a signal loss.
 *   "u": [0.123, null, ...],
 *   "v": [-0.044, null, ...],
 *
 *   "stats": {                        // over finite cells only; for color scales
 *     "cells": 4096, "finite": 2551,
 *     "speedMeanMs": .., "speedP95Ms": .., "speedMaxMs": ..
 *   },
 *
 *   // ---- provenance (status === "ok") — the legend renders from this ------
 *   "provenance": {
 *     "tier": "hfr" | "global" | "composite",
 *     "tierLabel": "HF radar surface currents",
 *     // The single-tier fields below describe the HF-RADAR COMPONENT whenever
 *     // there is one — on a composite, `datasetId`, `label`, `method`,
 *     // `sourceNote`, `validAtMs`, `ageMs`, `ageLabel`, `stale`, `resolutionKm`,
 *     // `observations`, `rejected`, `holdoutCount`, `rmseMs`, `maeMs`,
 *     // `biasUMs`, `biasVMs`, `meanSigmaMs` and `lengthScaleM` are the radar's,
 *     // NOT an average over the two. Per-source facts live in `sources`.
 *     "datasetId": "ucsdHfrW2" | null,   // null when the fetcher did not say
 *     "label": "IOOS HF-radar US West Coast 2 km totals (ERDDAP ucsdHfrW2)",
 *     "kind": "observed" | "derived" | "mixed",  // the modeled-vs-live label
 *     "method": "two-pass Barnes objective analysis ...",
 *     "url": "https://..." | null,
 *     "attribution": "..." | null,       // credit line; render it if present
 *     "license": "..." | null,
 *     "sourceNote": "..." | null,        // the fetcher's own product/QC note
 *     "validAtMs": 1756688400000 | null, // valid time of the underlying data
 *     "ageMs": 6000000 | null,           // requestedAtMs - validAtMs
 *     "ageLabel": "2 h old",             // human string, safe to print raw
 *     "stale": false,                    // ageMs beyond this tier's staleness bound
 *     "resolutionKm": 2,                 // NATIVE observation/analysis spacing
 *     "gridSpacingKm": { "lat": 1.7, "lon": 1.4 }, // the SERVED lattice
 *     // finite cells / cells that COULD hold a current, [0,1]. The denominator
 *     // is the water cells when the land/sea mask loaded (see ./waterCells.js)
 *     // and the whole lattice when it did not, in which case a caveat says so.
 *     "coverage": 0.62,
 *     // vectors that entered the analysis — barnesVector's `used`, i.e. those
 *     // that deposited pass-1 weight into at least one cell, not merely those
 *     // that survived QC. Null on the global tier, which has no observations.
 *     "observations": 1363,
 *     "rejected": 214,                   // vectors the fetcher's QC threw out
 *     "holdoutCount": 163,               // cross-validation sample size
 *     // rmseMs is the RMS of the VECTOR error magnitude,
 *     // sqrt((1/N) * sum(du^2 + dv^2)) over the held-out observations at which
 *     // the training analysis is finite. For isotropic errors that is sqrt(2)
 *     // times the per-component RMS, so a legend must NOT label it "u error".
 *     // It scores a train-only analysis and therefore slightly UNDERstates the
 *     // skill of the full-data field actually shipped in u/v.
 *     "rmseMs": 0.094,                   // m/s; null when validation did not run
 *     "maeMs": .., "biasUMs": .., "biasVMs": ..,   // null when not computed
 *     "meanSigmaMs": 0.031,              // mean HFR_SIGMA0/sqrt(w) at the holdout
 *     "lengthScaleM": 10000,             // Barnes L; null on the global tier
 *     "fallbackFrom": "hfr" | null,      // set when a finer tier was refused
 *     "note": "one sentence for the legend",
 *     "caveats": ["...", "..."],         // extra lines the user must be told
 *
 *     // ---- per-source provenance — ONE ENTRY PER CONTRIBUTING TIER ---------
 *     // Always present and never empty on `status: "ok"`; length 1 on a
 *     // single-tier response, 2 on a composite, ordered finest source first.
 *     // `cellShare` is that source's fraction of the FINITE served cells, so
 *     // the shares sum to 1 (to 4 decimals) and `cells` sums to `stats.finite`.
 *     // A legend MUST render this array rather than the scalar fields above:
 *     // it is the only place that says a given cell is a 28 km two-day-old
 *     // model value rather than a 2 km one-hour-old observation.
 *     "sources": [
 *       {
 *         "tier": "hfr",                 // "hfr" | "global"
 *         "kind": "observed",            // "observed" | "derived"
 *         "label": "IOOS HF-radar 2 km totals",
 *         "datasetId": "ucsdHfrW2" | null,
 *         "validAtMs": 1756688400000 | null,
 *         "ageMs": 7200000 | null,
 *         "ageLabel": "2 h old",
 *         "stale": false,
 *         "resolutionKm": 2 | null,      // that SOURCE's native spacing
 *         "cells": 1743,                 // finite served cells from this source
 *         "cellShare": 0.6817,           // cells / stats.finite
 *         "url": "https://..." | null,
 *         "attribution": "..." | null,
 *         "license": "..." | null
 *       }
 *     ]
 *   },
 *
 *   "attempts": [ { "tier": "hfr", "reason": "..." } ],  // why tiers were skipped
 *   "reason": "..." | null               // set when status === "unavailable"
 * }
 * ```
 *
 * ## Dependency contract
 *
 * The three sibling modules are the default implementations and are imported
 * lazily, per tier, only when the caller has not injected a replacement. Lazy
 * is deliberate, not a stub: it keeps {@link chooseTier} and
 * {@link buildTargetGrid} — which the client renderer also wants — importable
 * without dragging the ERDDAP fetchers along, and it lets a fully-injected test
 * run with no network module present at all.
 *
 * - `./hfradar.js` → `fetchHfrField({box, atMs, fetchImpl})` resolving to
 *   `{observations, datasetId, resolutionKm, lengthScaleM, validAtMs, ageMs,
 *   rejected, source}` or `null`. Each observation is
 *   `{lat, lon, u, v, hdop, quality, time, timeMs}`, `u`/`v` in m/s east/north,
 *   `quality = 1/(1 + hdop)` in (0, 1].
 * - `./globalCurrents.js` → `fetchGlobalCurrents({box, targetCells, fetchImpl})`
 *   resolving to `{lats, lons, u, v, finite, total, source}` — TYPED arrays —
 *   with `u`/`v` row-major over the returned axes
 *   (`u[latIndex * lons.length + lonIndex]`). It THROWS rather than returning an
 *   untrustworthy grid, which this module turns into a tier `reason`. The axes
 *   must be uniformly spaced — they are the product's own grid after striding.
 *   On a GLOBAL-ONLY response they are served verbatim, so that response ships
 *   no invented intermediate values at all; on a COMPOSITE the field must share
 *   the HF-radar tier's lattice and is bilinearly resampled onto it, which is
 *   the one interpolation this module performs and is declared in the legend by
 *   the source's own `resolutionKm` (27.8 km, not the served cell size).
 * - `./barnes.js` → `barnesVector(obs, xs, ys, L, opts)` and
 *   `validateAnalysis(obs, xs, ys, L, {holdoutFrac, seed})`. `xs` and `ys` are
 *   SEPARABLE strictly-increasing axes in metres (columns = longitude,
 *   rows = latitude), not per-node coordinates — see Geodesy below for what
 *   that forces. Fields come back row-major as `k = iy*nx + ix`, which is
 *   exactly this module's `latIndex * nLon + lonIndex`.
 *
 * `validateAnalysis` performs its own holdout split internally and analyses the
 * TRAINING set alone, so this module does two distinct things and must not
 * conflate them: it ships `barnesVector` over ALL observations (the best
 * estimate available) and reports `validateAnalysis`'s train-only skill beside
 * it. The reference project ships the train-only field instead
 * (`reconstruct.ts` analyses `used` after removing the holdout), which throws
 * away 12% of the data in every served frame for no benefit — cross-validation
 * measures a field, it does not have to BE the field. `holdoutSplit` is
 * therefore never called here: it is owned by `validateAnalysis`.
 *
 * `barnesVector` is load-bearing, so a bad return (wrong length, missing
 * component) throws rather than being packed into a payload; that throw is
 * caught one level up and demotes the whole tier, so a broken analysis costs the
 * HF-radar rung and never corrupts a served field. `validateAnalysis` is
 * diagnostic, so a failure there degrades to "no cross-validation" plus a
 * caveat rather than costing the user the field.
 *
 * ## Geodesy
 *
 * Barnes weights are `exp(-r^2 / L^2)` with `L` a 10–18 km length scale, so the
 * projection has to preserve short-range separations — and `barnesVector`'s
 * row-sweep kernel takes two 1-D axes, so the projection must also be
 * SEPARABLE. Separability rules out every projection that would be more
 * faithful here, so the map is equirectangular about the box centre:
 *
 *   `x = wrap(lon - lon0) * N(phi0) cos(phi0) pi/180`
 *   `y = (lat - lat0) * M(phi0) pi/180`
 *
 * with `M` and `N` the exact WGS84 meridian and prime-vertical radii of
 * curvature. That is one improvement on the reference project
 * (`grok-workspace/src/lib/ocean/coords.ts`), which hard-codes a single
 * `M_PER_DEG_LAT = 111132.95` for all latitudes — off by 0.5% at the equator
 * and 0.5% at the poles, where `M` actually runs 110574–111694 m/deg.
 *
 * The residual is the one that separability forces and cannot be removed: the
 * longitude scale is frozen at `cos(phi0)`, so the x-scale error at latitude
 * `phi` is `cos(phi)/cos(phi0) - 1`. Evaluated at the POLEWARD EDGE of the box
 * (the worse of the two edges), for boxes centred at 45N on WGS84:
 *
 *   -0.44% for a 0.5 deg-tall box (a typical harbour view),
 *   -1.76% for a 2 deg-tall box (a typical HF-radar footprint),
 *   -6.48% for a 7.2 deg-tall box — exactly the {@link HFR_MAX_SPAN_KM} cap at
 *          this latitude, since 7.2 deg * M(45) = 800.1 km.
 *
 * A zonal separation mis-scaled by `eps` moves the pass-1 Barnes weight at
 * `r = L` by `1 - exp(-((1 + eps)^2 - 1))`: 0.9%, 3.5% and 12.5% for those three
 * rows. Note what that is and is not comparable to. It is a perturbation of ONE
 * observation's weight inside a neighbourhood holding tens of them, so its effect
 * on the weighted mean is second order next to the +-0.08 m/s (HFR_SIGMA0)
 * per-vector uncertainty that the weighting exists to average down; it is not
 * itself an error in m/s and must not be quoted as one.
 *
 * The cap row is not reachable in practice, for a reason worth stating rather
 * than assuming: HF-radar footprints are coastal strips a few hundred km deep,
 * so over a 7 deg-tall box the analysis fills a thin sliver of the water and the
 * response is dominated by the global fill, whose resampling (below) does not go
 * through this projection at all.
 *
 * The global field never touches this projection either. On the global-only path
 * it is served on the source's own lat/lon axes; on the composite path it is
 * resampled in DEGREES onto the target lattice, since both lattices are
 * arithmetic in lat/lon and the resampling weights are therefore exact rather
 * than inheriting the equirectangular error budget above.
 *
 * ## Sources
 *
 * - Barnes, S.L. (1964): A technique for maximizing details in numerical
 *   weather map analysis. J. Appl. Meteor. 3(4), 396–409. — the two-pass
 *   successive-correction analysis run on the HF-radar tier.
 * - Koch, S.E., M. DesJardins & P.J. Kocin (1983): An interactive Barnes
 *   objective map analysis scheme. J. Climate Appl. Meteor. 22(9), 1487–1503.
 *   — the second-pass convergence parameter gamma = 0.3.
 * - Snyder, J.P. (1987): Map Projections — A Working Manual. USGS Professional
 *   Paper 1395, §25 — backs the "azimuthal equidistant would distort less"
 *   claim in Geodesy below. It is the alternative this module CANNOT use
 *   (it is not separable), not the projection implemented here.
 * - NIMA TR8350.2, 3rd ed. (2000): WGS 84 defining parameters
 *   a = 6378137 m, 1/f = 298.257223563, and the M/N radii of curvature.
 * - Tunable constants BARNES_WMIN 0.12, BARNES_GAMMA 0.3, HFR_SIGMA0 0.08,
 *   MAX_CURRENT_MS 2.4 and HDOP_REJECT 1.6 are inherited from the reference
 *   project's `src/lib/ocean/domain.ts`; the 40-observation floor is inherited
 *   from its `src/lib/ocean/ingest/hfradar.ts` (`keep.length < 40` rejects a
 *   product). They are named here only where this module uses them; the rest
 *   stay owned by `./barnes.js` and `./hfradar.js` so the two files cannot
 *   drift apart.
 *
 * @module server/ocean/fieldGrid
 */

// The fetchers and the analysis kernel are resolved dynamically so tests can
// inject stand-ins (see resolveDep). The water-cell helpers are not on that
// seam: they are pure, plus one memoized read of the bundled GSHHG asset, and
// classifyWaterCellsFromBundle takes its own `loadMask` override for tests.
import {
  classifyWaterCellsFromBundle,
  waterCoverage,
  blankLandCells,
} from './waterCells.js';

/** @const {string} Format tag stamped on every payload. */
export const FIELD_FORMAT = 'gev-ocean-field';
/** @const {number} Wire-format version; bump on any breaking shape change. */
export const FIELD_FORMAT_VERSION = 1;

/**
 * @const {number} Largest view span, in km, for which the HF-radar tier is
 * worth its cost. Derived, not guessed: the 2 km product's observation spacing
 * is the finest structure the tier adds, and on a typical 1600 px-wide viewport
 * that structure is only legible when one observation cell covers at least
 * ~4 px, i.e. span <= 1600 px * 2 km / 4 px = 800 km. Above that the HF-radar
 * analysis is a blurred copy of the global field at several times the latency
 * and request cost.
 */
export const HFR_MAX_SPAN_KM = 800;

/**
 * @const {number} RETIRED GATE — no longer consulted anywhere in this module,
 * and kept exported only because it is part of the module's published surface.
 *
 * It used to be the fraction of the water in view that the HF-radar analysis had
 * to fill before the tier could be served, on the rendering-quality argument
 * that below roughly a third filled the streakline renderer has more voids than
 * field. That argument was sound about a SINGLE-TIER field and wrong about the
 * layer: it threw away a whole 1 km radar analysis because the corner of the
 * view was out of radar range (measured 2026-09-01, a 1°×1° Monterey Bay box
 * scored 20% and was demoted whole to the 0.25° product). The voids it was
 * defending against are now filled from the global field instead of being
 * traded for it — see the Compositing section of the `@file` block — so nothing
 * reads this number and no analysis is discarded for being partial.
 */
export const MIN_HFR_COVERAGE = 0.35;

/**
 * @const {number} Least fraction of the water in view an HF-radar analysis must
 * fill to appear in a composite at all. NOT a quality bar — the analysis below
 * this floor is exactly as trustworthy as the one above it — but a legibility
 * one: on the default 4096-cell lattice 2% is 82 cells, under a 9x9 patch, and a
 * scatter that small buys a legend row, a second age and a second resolution to
 * explain, while rendering as speckle on top of an otherwise smooth 27.8 km
 * field. Below it the response is single-tier `global` and the HF attempt is
 * recorded in `attempts`.
 *
 * The genuinely expensive work — the Barnes pass itself — is not gated here: it
 * is skipped upstream by {@link MIN_HFR_OBSERVATIONS} when the fetcher returns
 * too few vectors to analyse, before any lattice is touched.
 */
export const MIN_HFR_CONTRIBUTION = 0.02;

/**
 * @const {number} Water coverage at or above which the global tier is not
 * fetched at all. At 98% the fill would contribute at most 2% of the water — 82
 * cells of a 4096-cell lattice — and each of them at 1/14 the resolution and
 * ~2 days older than its neighbours, in exchange for a second ERDDAP round trip
 * (~1.2 MB at the module's 20,000-cell budget; see `./globalCurrents.js`'s cell
 * budget note). The 2% that stays `null` is honest no-data, which this layer
 * already draws as nothing.
 */
export const HFR_SATURATION_COVERAGE = 0.98;

/**
 * @const {number} How far outside the global source's outermost cell CENTRES a
 * target cell may still be filled, in source cells. Half a cell, because that is
 * the cell's own footprint: a gridded 0.25 deg analysis states a value for the
 * whole cell, and its outermost centre sits 0.125 deg inside the area it
 * describes. ERDDAP snaps a coordinate constraint to the nearest axis point, so
 * the returned centres routinely fall up to half a cell inside the requested
 * box; without this the composite would show an empty band up to ~14 km wide
 * along every edge of the view. Beyond half a cell the value would be
 * extrapolation, and the cell stays `null`.
 */
export const RESAMPLE_EDGE_CELLS = 0.5;

/**
 * @const {number} Fewest quality-controlled vectors that can support a Barnes
 * analysis. Inherited from the reference `ingest/hfradar.ts`, which rejects a
 * product outright below 40 kept vectors; the sibling `./hfradar.js` carries the
 * same 40 as `HFR_MIN_VECTORS` and applies it per hour, so the two numbers are
 * deliberately equal and a change to one is a change to both.
 */
export const MIN_HFR_OBSERVATIONS = 40;

/** @const {number} Default analysis-grid cell budget (64x64). */
export const DEFAULT_TARGET_CELLS = 4096;
/** @const {number} Floor on the cell budget (8x8) — below this there is no field. */
export const MIN_TARGET_CELLS = 64;
/** @const {number} Ceiling on the cell budget; caps payload size on camera moves. */
export const MAX_TARGET_CELLS = 32768;
/** @const {number} Per-axis node ceiling, so an extreme aspect cannot blow up one axis. */
export const MAX_GRID_AXIS = 512;
/** @const {number} Per-axis node floor; two nodes is the minimum that defines a spacing. */
export const MIN_GRID_AXIS = 2;

/**
 * @const {number} Absolute floor on the uniform-axis fit tolerance, degrees.
 *
 * A source may deliver its coordinates as Float32 and in a frame this module
 * does not see. HYCOM does both: its axes are Float32 in a 0–360 longitude
 * frame, and a box crossing the prime meridian is stitched from two index
 * ranges and shifted into −180…180. The residual is inherited from the
 * PRE-SHIFT magnitude, where one Float32 ulp at 359.92° is 3.05e-5°, so a
 * stitched axis accumulates ~1e-4° of deviation about its own least-squares
 * line — measured 1.03e-4° on a 40-point English Channel axis, against the
 * 8e-5° that 0.1% of a 0.08° step allows.
 *
 * 4 ulp at the worst-case coordinate magnitude (360°) = 4 · 360 · 2⁻²³ bounds
 * that honestly. It is still ~500× finer than the finest step this module
 * serves, so it cannot admit an irregularity that would misplace a cell.
 */
const FLOAT32_COORD_TOL_DEG = 4 * 360 * 2 ** -23;

/** @const {number} Fraction of observations withheld for cross-validation. */
export const DEFAULT_HOLDOUT_FRACTION = 0.12;
/** @const {number} Fixed RNG seed for the holdout split — identical requests get identical RMSE. */
export const DEFAULT_HOLDOUT_SEED = 7;

/**
 * @const {number} HF-RADAR-TIER per-component gate, m/s: an analysis value past
 * this magnitude is treated as no-data. Twice `./hfradar.js`'s
 * `MAX_CURRENT_MS = 2.4` observation gate (itself inherited from the reference
 * `domain.ts`): that fetcher has already dropped every observation above 2.4, so
 * a Barnes cell past 4.8 m/s cannot be a weighted mean of admitted data — it can
 * only come from a degenerate weight sum — and one such cell would wreck the
 * renderer's color scale.
 *
 * It is a TIER-SPECIFIC number, not a global one; the blended product's own
 * envelope is wider (see {@link GLOBAL_FIELD_SANITY_MAX_MS}).
 */
export const FIELD_SANITY_MAX_MS = 4.8;

/**
 * @const {number} GLOBAL-TIER per-component gate, m/s. This is exactly the
 * envelope `./globalCurrents.js` declares as
 * `GLOBAL_CURRENTS_DATASET.maxSpeedMs`, taken from the dataset's own valid
 * ranges (u in [-4.7954, 4.994], v in [-4.8696, 4.755]); that fetcher maps
 * |value| > 5 to NaN before this module ever sees it, so this gate removes
 * nothing the fetcher kept and exists only to keep one no-data test in one
 * place.
 *
 * Reusing {@link FIELD_SANITY_MAX_MS} here — as this module originally did —
 * silently nulled every global cell in (4.8, 5] m/s that the fetcher had
 * deliberately admitted. `globalCurrents.js` documents at length why an
 * HF-radar-tuned gate must not be applied to a blended product (it clips real
 * western-boundary-current signal), so the two tiers carry two numbers and the
 * gate travels with the tier rather than with the packing code.
 */
export const GLOBAL_FIELD_SANITY_MAX_MS = 5;

/** @const {number} Decimals kept on served u/v — 1 mm/s, far below any measurement sigma. */
export const FIELD_DECIMALS = 3;

/** @const {number} HF-radar hours older than this are flagged stale (hourly product). */
export const HFR_STALE_MS = 6 * 3600_000;
/** @const {number} Global blended currents older than this are flagged stale (~3-day nominal lag). */
export const GLOBAL_STALE_MS = 5 * 86400_000;

/** WGS84 semi-major axis, metres (NIMA TR8350.2). */
const WGS84_A = 6378137;
/** WGS84 flattening (NIMA TR8350.2). */
const WGS84_F = 1 / 298.257223563;
/** First eccentricity squared, e^2 = f(2 - f). */
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const DEG = Math.PI / 180;

/**
 * The tiers this module can serve, frozen so a handler cannot mutate the
 * descriptors it hands to the legend. `minResolutionKm` is the FINEST native
 * spacing the tier can deliver (1 km for the `ucsdHfrW1` HF-radar product,
 * 0.25 deg ~ 27.8 km at the equator for the blended global product); the actual
 * spacing of a given response is `provenance.resolutionKm`.
 *
 * `composite` is not a data source and is never returned by {@link chooseTier}
 * — it is the label for a response whose cells came from BOTH of the other two,
 * one provenance per cell, with the split reported in `provenance.sources`. Its
 * `minResolutionKm` is the HF-radar figure because that is the finest spacing a
 * composite can contain; the coarsest is in `sources[]`, and no single number
 * describes such a response, which is the whole reason `sources` exists.
 *
 * @type {Readonly<{hfr: Readonly<{id: string, label: string, minResolutionKm: number}>,
 *                  global: Readonly<{id: string, label: string, minResolutionKm: number}>,
 *                  composite: Readonly<{id: string, label: string, minResolutionKm: number}>}>}
 */
export const TIERS = Object.freeze({
  hfr: Object.freeze({
    id: 'hfr',
    label: 'HF radar surface currents',
    minResolutionKm: 1,
  }),
  // Product-NEUTRAL labels. This tier is served by HYCOM or by the altimetry
  // fallback, and these strings reach the legend as `provenance.tierLabel`, so
  // naming one product here made a HYCOM-served view announce itself as a
  // blended altimetric analysis. The product that actually served is named
  // exactly once, in `provenance.sources[].label`, alongside its dataset id.
  global: Object.freeze({
    id: 'global',
    label: 'Global surface currents',
    minResolutionKm: 27.8,
  }),
  composite: Object.freeze({
    id: 'composite',
    label: 'HF radar over global surface currents',
    minResolutionKm: 1,
  }),
});

/**
 * Metres per degree of latitude at `lat` — the WGS84 meridian radius of
 * curvature M(phi) times pi/180.
 *
 * @param {number} lat - Degrees.
 * @returns {number} Metres per degree along the meridian.
 */
export function metresPerDegLat(lat) {
  const s = Math.sin(lat * DEG);
  const w = 1 - WGS84_E2 * s * s;
  return (WGS84_A * (1 - WGS84_E2) / (w * Math.sqrt(w))) * DEG;
}

/**
 * Metres per degree of longitude at `lat` — the WGS84 prime-vertical radius
 * N(phi) times cos(phi) times pi/180. Goes to zero at the poles.
 *
 * @param {number} lat - Degrees.
 * @returns {number} Metres per degree along the parallel.
 */
export function metresPerDegLon(lat) {
  const s = Math.sin(lat * DEG);
  return (WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s)) * Math.cos(lat * DEG) * DEG;
}

/**
 * Normalize and validate a view rectangle. The longitude span is measured
 * EASTWARD from `lonMin` to `lonMax` — not "the shorter of the two arcs" — so a
 * box may cross the antimeridian with `lonMax < lonMin` (179 -> -179 is a 2 deg
 * box, not a 358 deg one) while a box from -170 east to 170 is genuinely 340 deg
 * wide, which is what a camera looking at the Pacific from behind actually sees.
 * Signed zeros in the bounds collapse to +0, so the payload survives a JSON round
 * trip (`JSON.parse(JSON.stringify(-0))` is `0`, and the two are not
 * `deepStrictEqual`).
 *
 * Refuses: non-finite bounds, latitudes outside [-90, 90], `latMin >= latMax`,
 * and a zero-width longitude span. It does not clamp — a malformed box is a
 * caller bug and silently repairing it would serve a field for the wrong place.
 *
 * @param {{latMin: number, lonMin: number, latMax: number, lonMax: number}} box - View rectangle, degrees.
 * @returns {{latMin: number, lonMin: number, latMax: number, lonMax: number,
 *            latSpanDeg: number, lonSpanDeg: number, midLat: number, midLon: number}}
 *   The box plus its spans and centre.
 * @throws {Error} On any of the refusals above.
 */
export function normalizeBox(box) {
  if (!box || typeof box !== 'object') throw new Error('view box is missing');
  for (const name of ['latMin', 'lonMin', 'latMax', 'lonMax']) {
    if (!Number.isFinite(box[name])) {
      throw new Error(`${name} is not a finite number (${String(box[name])})`);
    }
  }
  // `+ 0` maps -0 to +0 and leaves every other double untouched.
  const latMin = box.latMin + 0;
  const lonMin = box.lonMin + 0;
  const latMax = box.latMax + 0;
  const lonMax = box.lonMax + 0;
  if (latMin < -90 || latMax > 90) throw new Error(`latitudes out of range: ${latMin}..${latMax}`);
  if (!(latMax > latMin)) throw new Error(`latMax must exceed latMin (${latMin}..${latMax})`);
  const rawSpan = ((lonMax - lonMin) % 360 + 360) % 360;
  // A wrap to exactly 0 is either a zero-width box (refused) or a full 360.
  const lonSpanDeg = rawSpan === 0 ? (lonMax === lonMin ? 0 : 360) : rawSpan;
  if (!(lonSpanDeg > 0)) throw new Error(`longitude span is zero (${lonMin}..${lonMax})`);
  return {
    latMin,
    lonMin,
    latMax,
    lonMax,
    latSpanDeg: latMax - latMin,
    lonSpanDeg,
    midLat: (latMin + latMax) / 2,
    midLon: lonMin + lonSpanDeg / 2,
  };
}

/**
 * Ground dimensions of a view box in kilometres. The latitude span uses the
 * midpoint rule on the meridian arc (error O(dphi^3), under 0.1 km for any box
 * this module accepts); the longitude span uses the parallel at the box centre,
 * which is what makes a 10 deg-wide box at 70N read as 381 km rather than
 * 1113 km.
 *
 * @param {{latMin: number, lonMin: number, latMax: number, lonMax: number}} box - View rectangle, degrees.
 * @returns {{latKm: number, lonKm: number, maxKm: number}} Spans and the larger of the two.
 * @throws {Error} If the box fails {@link normalizeBox}.
 */
export function boxSpanKm(box) {
  const b = normalizeBox(box);
  const latKm = b.latSpanDeg * metresPerDegLat(b.midLat) / 1000;
  const lonKm = b.lonSpanDeg * metresPerDegLon(b.midLat) / 1000;
  return { latKm, lonKm, maxKm: Math.max(latKm, lonKm) };
}

/**
 * {@link normalizeBox} as a RESULT rather than a throw, for callers that have to
 * turn a bad box into a status code instead of an exception.
 *
 * `normalizeBox` throws on purpose — a library refusing a rectangle should say
 * which bound was wrong — but the HTTP handler tested its return value for
 * falsiness, and there is no falsy return path. That made the handler's 400
 * branch unreachable and answered every malformed request with a 500 and a
 * generic `ocean proxy error`, which is both the wrong class of status and a
 * message the caller cannot act on. Verified live against five distinct invalid
 * inputs before the fix; all five returned 500.
 *
 * @param {*} box - Any candidate `{latMin, lonMin, latMax, lonMax}`.
 * @returns {{box: ?Object, error: ?string}} Exactly one of the two is set.
 */
export function tryNormalizeBox(box) {
  try {
    return { box: normalizeBox(box), error: null };
  } catch (error) {
    return { box: null, error: String(error?.message ?? error) };
  }
}

/**
 * Pick the data tier for a view box from its ground SPAN, never from a camera
 * zoom level — span is the thing that decides whether 1–6 km eddies land on
 * enough screen pixels to be worth fetching (see {@link HFR_MAX_SPAN_KM} for
 * the pixel budget the 800 km threshold comes from). Pure: no clock, no
 * network, no coverage knowledge.
 *
 * It does NOT know where the HF-radar network has coverage — a small box in the
 * mid-Pacific still returns `TIERS.hfr` here and is demoted later when
 * `fetchHfrField` comes back empty. Callers that already know the box is
 * outside the network footprint should pass `allowHfr: false` to skip the
 * wasted round trip.
 *
 * @param {{latMin: number, lonMin: number, latMax: number, lonMax: number}} box - View rectangle, degrees.
 * @param {{allowHfr?: boolean}} [options] - `allowHfr` (default true) hard-disables the HF-radar tier.
 * @returns {Readonly<{id: string, label: string, minResolutionKm: number}>} A frozen {@link TIERS} descriptor.
 * @throws {Error} If the box fails {@link normalizeBox}.
 */
export function chooseTier(box, { allowHfr = true } = {}) {
  const span = boxSpanKm(box);
  if (!allowHfr) return TIERS.global;
  return span.maxKm <= HFR_MAX_SPAN_KM ? TIERS.hfr : TIERS.global;
}

/**
 * Build the equirectangular lat/lon lattice the field is served on: node counts
 * chosen so the grid's aspect matches the box's GROUND aspect (cos-corrected,
 * so a high-latitude box is not stretched) and the cell count lands near the
 * budget. Endpoints are inclusive, so `lats[0] === latMin` and
 * `lats[nLat-1]` reaches `latMax` to floating-point.
 *
 * The returned `lats`/`lons` are exactly what the payload's arithmetic axes
 * reconstruct: `lats[i] === lat0 + i*dLat`. Pure.
 *
 * Refuses a malformed box (see {@link normalizeBox}). A non-finite or
 * out-of-range `targetCells` is clamped to [{@link MIN_TARGET_CELLS},
 * {@link MAX_TARGET_CELLS}] rather than refused, since it is a tuning knob
 * rather than a statement about the world.
 *
 * @param {{latMin: number, lonMin: number, latMax: number, lonMax: number}} box - View rectangle, degrees.
 * @param {number} [targetCells] - Approximate cell budget; defaults to {@link DEFAULT_TARGET_CELLS}.
 * @returns {{lats: number[], lons: number[], nLat: number, nLon: number,
 *            dLat: number, dLon: number, lat0: number, lon0: number}}
 *   Ascending axes in degrees; `lon0 + j*dLon` may exceed +180 across the antimeridian.
 * @throws {Error} If the box fails {@link normalizeBox}.
 */
export function buildTargetGrid(box, targetCells = DEFAULT_TARGET_CELLS) {
  const b = normalizeBox(box);
  const budget = clamp(
    Number.isFinite(targetCells) ? Math.round(targetCells) : DEFAULT_TARGET_CELLS,
    MIN_TARGET_CELLS,
    MAX_TARGET_CELLS,
  );

  const latKm = b.latSpanDeg * metresPerDegLat(b.midLat) / 1000;
  // Near the poles metresPerDegLon -> 0; floor the ground width so the aspect
  // stays finite and the grid degrades to a tall sliver rather than dividing by 0.
  const lonKm = Math.max(b.lonSpanDeg * metresPerDegLon(b.midLat) / 1000, 1e-6);
  const aspect = lonKm / Math.max(latKm, 1e-6);

  // nLon from the aspect-weighted budget, then nLat from what is left: this
  // keeps nLat*nLon within one row of the budget for any aspect.
  const nLon = clamp(Math.round(Math.sqrt(budget * aspect)), MIN_GRID_AXIS, MAX_GRID_AXIS);
  const nLat = clamp(Math.round(budget / nLon), MIN_GRID_AXIS, MAX_GRID_AXIS);

  const dLat = b.latSpanDeg / (nLat - 1);
  const dLon = b.lonSpanDeg / (nLon - 1);
  const lats = new Array(nLat);
  for (let i = 0; i < nLat; i += 1) lats[i] = b.latMin + i * dLat;
  const lons = new Array(nLon);
  for (let j = 0; j < nLon; j += 1) lons[j] = b.lonMin + j * dLon;

  return { lats, lons, nLat, nLon, dLat, dLon, lat0: b.latMin, lon0: b.lonMin };
}

/**
 * Build the local tangent-plane projection used for the Barnes analysis: an
 * equirectangular map about the box centre, scaled by the exact WGS84 radii of
 * curvature at that centre.
 *
 * SEPARABILITY IS THE REQUIREMENT, not a simplification. `barnesVector` takes
 * two strictly-increasing 1-D axes and sweeps `exp(-dx^2/L^2)` once per row, so
 * the map must send longitude to x alone and latitude to y alone. A more
 * faithful projection (azimuthal equidistant about the centre, which would cut
 * the distortion below) is not separable — x would depend on latitude — and
 * cannot be handed to that kernel at all. See the `@file` block for the error
 * budget this costs.
 *
 * Observations and grid nodes MUST go through the same projection: Barnes only
 * ever sees separations, so a shared bias in the map largely cancels, while a
 * mismatch between the two would not.
 *
 * Longitude differences are wrapped into [-180, 180), so an
 * antimeridian-crossing box projects its 2 deg width as 2 deg, not 358. The wrap
 * collides only for a box whose longitude span is exactly 360 deg, where the
 * first and last columns land on the same x. {@link chooseTier} does NOT rule
 * that out: a 1 deg-tall, full-longitude box centred at 89.4 N spans 419 km on
 * the ground and is routed here. {@link buildFieldPayload} therefore checks the
 * projected axes for strict monotonicity before handing them to `barnesVector`
 * and demotes the tier with a legible reason (there is no HF-radar coverage over
 * the pole in the first place, so nothing real is lost).
 *
 * @param {{latMin: number, lonMin: number, latMax: number, lonMax: number}} box - View rectangle, degrees.
 * @returns {{lat0: number, lon0: number, mPerDegLat: number, mPerDegLon: number,
 *            projectLat: (lat: number) => number, projectLon: (lon: number) => number,
 *            project: (lat: number, lon: number) => {x: number, y: number}}}
 *   Metres east (x) and north (y) of the box centre; `projectLat`/`projectLon`
 *   are the separable halves used to build the Barnes axes.
 * @throws {Error} If the box fails {@link normalizeBox}.
 */
export function createTangentProjection(box) {
  const b = normalizeBox(box);
  const lat0 = b.midLat;
  const lon0 = b.midLon;
  const mPerDegLat = metresPerDegLat(lat0);
  const mPerDegLon = metresPerDegLon(lat0);
  const projectLat = (lat) => (lat - lat0) * mPerDegLat;
  const projectLon = (lon) => ((((lon - lon0 + 540) % 360) - 180)) * mPerDegLon;
  return {
    lat0,
    lon0,
    mPerDegLat,
    mPerDegLon,
    projectLat,
    projectLon,
    project: (lat, lon) => ({ x: projectLon(lon), y: projectLat(lat) }),
  };
}

/**
 * Render a duration in milliseconds coarsely: `'42 min'`, `'7 h'`, `'3 days'`.
 * @param {number} ms - A non-negative span.
 * @returns {string}
 */
function formatSpan(ms) {
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)} h`;
  const days = Math.round(ms / 86400_000);
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Render an age in milliseconds as a legend string. Deliberately coarse — the
 * legend's job is to stop a user reading a three-day-old blended analysis as a
 * live observation, not to report seconds.
 *
 * A NEGATIVE age is a forecast, not clock skew, and reads `'4 days ahead'`
 * rather than `'just now'`. The global tier can be served by HYCOM, which
 * publishes about five days out; rendering that as `'just now'` would tell a
 * viewer the single most misleading thing available about the field in front of
 * them. Skew is absorbed by the symmetric ±60 s "just now" band.
 *
 * @param {?number} ageMs - Signed age in milliseconds; negative means valid ahead of now.
 * @returns {string} e.g. `'age unknown'`, `'just now'`, `'42 min old'`, `'3 days old'`, `'4 days ahead'`.
 */
export function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'age unknown';
  if (Math.abs(ageMs) < 60_000) return 'just now';
  return ageMs < 0 ? `${formatSpan(-ageMs)} ahead` : `${formatSpan(ageMs)} old`;
}

/**
 * Build the ocean-current wire payload for a view box: run the tiers the box
 * qualifies for and composite what comes back. Never throws for data reasons —
 * an unusable box, a dead upstream, or an empty analysis all come back as
 * `{status: 'unavailable', reason}` with the per-tier reasons in `attempts`. It
 * never serves an all-`null` field as `status: 'ok'`.
 *
 * On the HF-radar path it projects the fetched vectors onto the tangent plane,
 * withholds {@link DEFAULT_HOLDOUT_FRACTION} of them, runs `barnesVector` at
 * the dataset's own length scale, and reports the holdout RMSE and the resulting
 * coverage.
 *
 * The three outcomes, in the order they are decided:
 *
 * - HF fills >= {@link HFR_SATURATION_COVERAGE} of the water: `hfr`, and the
 *   global request is never issued.
 * - HF fills something less than that: the global field is fetched, resampled
 *   onto the HF lattice and merged cell by cell — `composite` when both ended up
 *   contributing, `hfr` when the fill added nothing or could not be fetched.
 * - HF produced nothing, fewer than {@link MIN_HFR_OBSERVATIONS} vectors, or
 *   less than {@link MIN_HFR_CONTRIBUTION} of the water: `global` on its own
 *   axes, with `provenance.fallbackFrom = 'hfr'` and the reason in `attempts`.
 *
 * @param {Object} options
 * @param {{latMin: number, lonMin: number, latMax: number, lonMax: number}} options.box - View rectangle, degrees.
 * @param {number} [options.atMs] - Valid time wanted, ms since epoch; defaults to now.
 * @param {number} [options.targetCells] - Analysis-grid cell budget.
 * @param {Function} [options.fetchImpl] - Fetch passed through to the tier fetchers.
 * @param {Object} [options.deps] - Injected `{fetchHfrField, fetchGlobalCurrents, barnesVector, validateAnalysis}`; anything absent is imported from the sibling modules.
 * @param {boolean} [options.allowHfr] - Hard-disable the HF-radar tier.
 * @param {number} [options.holdoutFraction] - Cross-validation withhold fraction.
 * @param {number} [options.seed] - Holdout RNG seed; fixed by default so responses are reproducible.
 * @param {boolean} [options.validate] - Run holdout cross-validation (a second Barnes pass); default true.
 * @returns {Promise<Object>} A `gev-ocean-field` v1 payload (see the `@file` block).
 */
export async function buildFieldPayload({
  box,
  atMs = Date.now(),
  targetCells = DEFAULT_TARGET_CELLS,
  fetchImpl,
  deps = {},
  allowHfr = true,
  holdoutFraction = DEFAULT_HOLDOUT_FRACTION,
  seed = DEFAULT_HOLDOUT_SEED,
  validate = true,
} = {}) {
  const requestedAtMs = Number.isFinite(atMs) ? atMs : Date.now();
  const attempts = [];

  let normalized;
  let grid;
  try {
    normalized = normalizeBox(box);
    grid = buildTargetGrid(normalized, targetCells);
  } catch (error) {
    return unavailablePayload({
      box,
      requestedAtMs,
      attempts,
      reason: `unusable view box: ${describeError(error)}`,
    });
  }

  const tier = chooseTier(normalized, { allowHfr });
  let fallbackFrom = null;
  let hfr = null;

  if (tier.id === TIERS.hfr.id) {
    let outcome;
    try {
      outcome = await runHfrTier({
        box: normalized,
        grid,
        requestedAtMs,
        fetchImpl,
        deps,
        holdoutFraction,
        seed,
        validate,
      });
    } catch (error) {
      outcome = { component: null, reason: describeError(error) };
    }
    if (outcome.component) {
      hfr = outcome.component;
    } else {
      attempts.push({ tier: TIERS.hfr.id, reason: outcome.reason });
      fallbackFrom = TIERS.hfr.id;
    }
  }

  // Cost control, one: an analysis that already covers essentially all the water
  // leaves the global tier nothing to fill, so the round trip is not made.
  if (hfr && hfr.coverage >= HFR_SATURATION_COVERAGE) {
    return hfrOnlyPayload({ box: normalized, requestedAtMs, hfr, attempts, globalReason: null });
  }

  let globalOutcome;
  try {
    globalOutcome = await fetchGlobalField({
      box: normalized,
      targetCells: grid.nLat * grid.nLon,
      requestedAtMs,
      fetchImpl,
      deps,
    });
  } catch (error) {
    globalOutcome = { field: null, reason: describeError(error) };
  }

  if (hfr) {
    // The radar analysis is never thrown away for being partial: either the
    // global field fills the rest of the water or those cells stay no-data.
    if (globalOutcome.field) {
      return compositePayload({
        box: normalized,
        grid,
        requestedAtMs,
        hfr,
        globalField: globalOutcome.field,
        attempts,
      });
    }
    return hfrOnlyPayload({
      box: normalized, requestedAtMs, hfr, attempts, globalReason: globalOutcome.reason,
    });
  }

  if (globalOutcome.field) {
    const built = await buildGlobalPayload({
      globalField: globalOutcome.field,
      box: normalized,
      requestedAtMs,
      deps,
      fallbackFrom,
      fallbackReason: attempts.length ? attempts[attempts.length - 1].reason : null,
    });
    if (built.payload) {
      built.payload.attempts = attempts;
      return built.payload;
    }
    globalOutcome = built;
  }
  attempts.push({ tier: TIERS.global.id, reason: globalOutcome.reason });

  return unavailablePayload({
    box: normalized,
    requestedAtMs,
    attempts,
    reason: `no ocean-current tier could serve this view (${attempts.map((a) => `${a.tier}: ${a.reason}`).join('; ')})`,
  });
}

/* ------------------------------------------------------------------ *
 * Tier builders
 * ------------------------------------------------------------------ */

/**
 * Run the HF-radar tier: fetch, project, split, analyse, validate, score
 * coverage. Returns the analysed COMPONENT — the packed field on the target
 * lattice plus everything the legend needs to describe it — rather than a
 * finished payload, because the caller may still merge a global fill into it.
 *
 * Returns `{component: null, reason}` when the tier contributed nothing worth
 * compositing: no vectors, too few to analyse ({@link MIN_HFR_OBSERVATIONS},
 * checked BEFORE the Barnes pass so a hopeless view costs no analysis), no
 * length scale, a lattice `barnesVector` cannot accept, or an analysis below
 * {@link MIN_HFR_CONTRIBUTION} of the water.
 *
 * @param {Object} args - Internal call shape; see {@link buildFieldPayload}.
 * @returns {Promise<{component: ?{grid: Object, u: Array<?number>, v: Array<?number>,
 *   finite: number, water: ?Object, coverage: number, waterRelative: boolean,
 *   caveats: string[], metrics: Object, lengthScaleM: number, used: number,
 *   usedVerb: string, resolutionKm: ?number, ageMs: ?number, ageLabel: string,
 *   stale: boolean, gridSpacingKm: Object}, reason?: string}>}
 *   The analysed component — `u`/`v` are the wire arrays on the target lattice,
 *   already land-blanked, and `water` is the lattice's classification so a
 *   composite does not load the mask twice — or a demotion reason.
 */
async function runHfrTier({ box, grid, requestedAtMs, fetchImpl, deps, holdoutFraction, seed, validate }) {
  const fetchHfrField = await resolveDep('fetchHfrField', deps);
  const fetched = await fetchHfrField({ box: plainBox(box), atMs: requestedAtMs, fetchImpl });
  const observations = Array.isArray(fetched?.observations) ? fetched.observations : [];
  if (!fetched || observations.length === 0) {
    return { component: null, reason: 'no HF-radar vectors in view' };
  }
  if (observations.length < MIN_HFR_OBSERVATIONS) {
    return {
      component: null,
      reason: `only ${observations.length} HF-radar vectors in view (need ${MIN_HFR_OBSERVATIONS})`,
    };
  }
  const lengthScaleM = fetched.lengthScaleM;
  if (!Number.isFinite(lengthScaleM) || lengthScaleM <= 0) {
    // The 2 km and 6 km products use L = 10 km and 18 km — ratios of 5 and 3 —
    // so there is no single defensible ratio to guess one from the other.
    return { component: null, reason: 'HF-radar fetch reported no Barnes length scale' };
  }

  const projection = createTangentProjection(box);
  const projected = [];
  for (const o of observations) {
    if (!o || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) continue;
    if (!Number.isFinite(o.u) || !Number.isFinite(o.v)) continue;
    const { x, y } = projection.project(o.lat, o.lon);
    projected.push({ x, y, u: o.u, v: o.v, quality: observationQuality(o) });
  }
  if (projected.length < MIN_HFR_OBSERVATIONS) {
    return {
      component: null,
      reason: `only ${projected.length} HF-radar vectors survived shape checks (need ${MIN_HFR_OBSERVATIONS})`,
    };
  }

  // Separable axes: columns are longitude, rows are latitude, both strictly
  // increasing in metres. barnesVector's row sweep requires exactly this.
  const nodeCount = grid.nLat * grid.nLon;
  const xs = new Float64Array(grid.nLon);
  for (let j = 0; j < grid.nLon; j += 1) xs[j] = projection.projectLon(grid.lons[j]);
  const ys = new Float64Array(grid.nLat);
  for (let i = 0; i < grid.nLat; i += 1) ys[i] = projection.projectLat(grid.lats[i]);
  // Check the precondition here rather than letting barnesVector's own RangeError
  // surface as the tier's public `reason`. Two ways to break it, both real: a
  // 360 deg-wide box (the projection's wrap puts the last column back on the
  // first — see createTangentProjection), and a box so narrow at such a high
  // latitude that adjacent columns collapse onto one double.
  const xFault = firstNonIncreasing(xs);
  const yFault = firstNonIncreasing(ys);
  if (xFault >= 0 || yFault >= 0) {
    const axis = xFault >= 0 ? 'longitude' : 'latitude';
    return {
      component: null,
      reason: `the view box does not project to a separable Barnes lattice (${axis} axis stops increasing at index ${xFault >= 0 ? xFault : yFault})`,
    };
  }

  const caveats = [];
  const barnesVector = await resolveDep('barnesVector', deps);
  // Analysed over ALL observations: cross-validation below measures this field,
  // it does not replace it. barnesVector returns k = iy*nx + ix, which is this
  // module's latIndex * nLon + lonIndex.
  const analysis = barnesVector(projected, xs, ys, lengthScaleM);
  const au = analysis?.u;
  const av = analysis?.v;
  if (!au || !av || au.length !== nodeCount || av.length !== nodeCount) {
    throw new Error(`barnesVector returned ${au?.length ?? 'no'} u / ${av?.length ?? 'no'} v values for ${nodeCount} grid nodes`);
  }

  const packed = packField(au, av, nodeCount, FIELD_SANITY_MAX_MS);
  const { u, v } = packed;
  // Coverage is measured over cells that COULD hold a current. Counting land
  // against the analysis penalises exactly the coastal boxes where HF radar
  // exists: measured 2026-09-01, one radar hour scored 20% over a 1°×1° box
  // centred on Monterey Bay (half of it is the Santa Cruz range and the Salinas
  // valley) and 99.9% over the same hour offshore. The first was demoted to the
  // 0.25° global tier for having land in view.
  const water = await classifyWaterCellsFromBundle(grid, deps);
  // Barnes extrapolates up to 3L, so it can put a vector inland. Blank those
  // before measuring or serving — a current drawn over dry land is the most
  // obviously wrong thing this layer could render.
  blankLandCells(u, v, water);
  const { coverage, waterRelative } = waterCoverage(u, water);
  const finite = u.reduce((count, value) => count + (value == null ? 0 : 1), 0);
  // The only coverage this can fail is "essentially nothing" — a partial
  // analysis is composited rather than discarded. See MIN_HFR_CONTRIBUTION.
  if (coverage < MIN_HFR_CONTRIBUTION) {
    const denominator = waterRelative ? 'the water in view' : 'the view';
    return {
      component: null,
      reason: `HF-radar analysis filled ${(coverage * 100).toFixed(0)}% of ${denominator}, below the ${(MIN_HFR_CONTRIBUTION * 100).toFixed(0)}% worth compositing`,
    };
  }
  if (!waterRelative) {
    caveats.push('Coverage is measured over the whole view: the land/sea mask was unavailable.');
  }

  // Cross-validation costs a second Barnes pass (validateAnalysis re-analyses
  // the training set), so the handler can switch it off under load.
  let metrics = EMPTY_METRICS;
  if (validate) {
    const validateAnalysis = await resolveDepOptional('validateAnalysis', deps);
    metrics = safeValidate(validateAnalysis, projected, xs, ys, lengthScaleM, {
      holdoutFrac: holdoutFraction,
      seed,
    });
  }
  if (metrics.rmseMs == null) {
    caveats.push('No holdout cross-validation is available for this analysis.');
  }

  const source = fetched.source ?? null;
  const validAtMs = firstFinite(fetched.validAtMs, source?.validAtMs);
  const ageMs = resolveAgeMs(fetched.ageMs ?? source?.ageMs, validAtMs, requestedAtMs);
  const resolutionKm = firstFinite(fetched.resolutionKm, source?.resolutionKm);
  const spacing = gridSpacingKm(grid, box.midLat);
  const stale = Number.isFinite(ageMs) && ageMs > HFR_STALE_MS;
  if (stale) caveats.push(`Newest HF-radar hour in view is ${formatAge(ageMs)}.`);

  // `analysis.used` counts the vectors that actually deposited pass-1 weight into
  // a grid cell; `projected.length` counts the ones OFFERED to the kernel, which
  // additionally includes any lying more than 3L outside the grid. They are two
  // different populations, so when the kernel does not report the first (the real
  // barnesVector always does; only an injected stand-in can omit it) the note
  // says "offered to" rather than passing the looser count off as the tighter one.
  const used = Number.isFinite(analysis.used) ? analysis.used : projected.length;
  const usedVerb = Number.isFinite(analysis.used) ? 'of' : 'offered to';

  return {
    component: {
      grid,
      u,
      v,
      finite,
      water,
      coverage,
      waterRelative,
      caveats,
      metrics,
      lengthScaleM,
      used,
      usedVerb,
      rejected: Number.isFinite(fetched.rejected) ? fetched.rejected : null,
      datasetId: fetched.datasetId ?? source?.id ?? null,
      label: source?.label ?? source?.name ?? TIERS.hfr.label,
      url: source?.url ?? null,
      attribution: source?.attribution ?? null,
      license: source?.license ?? null,
      sourceNote: source?.note ?? null,
      validAtMs: Number.isFinite(validAtMs) ? validAtMs : null,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      ageLabel: formatAge(ageMs),
      stale,
      resolutionKm: Number.isFinite(resolutionKm) ? resolutionKm : null,
      gridSpacingKm: spacing,
    },
  };
}

/**
 * The `provenance.sources` entry for an HF-radar component.
 *
 * @param {Object} hfr - Component from {@link runHfrTier}.
 * @param {number} cells - Finite served cells this source supplied.
 * @param {number} share - `cells / stats.finite`, already rounded.
 * @returns {Object} One `sources[]` entry; see the `@file` block.
 */
function hfrSourceEntry(hfr, cells, share) {
  return {
    tier: TIERS.hfr.id,
    kind: 'observed',
    label: hfr.label,
    datasetId: hfr.datasetId,
    validAtMs: hfr.validAtMs,
    ageMs: hfr.ageMs,
    ageLabel: hfr.ageLabel,
    stale: hfr.stale,
    resolutionKm: hfr.resolutionKm,
    cells,
    cellShare: share,
    url: hfr.url,
    attribution: hfr.attribution,
    license: hfr.license,
  };
}

/**
 * The HF-radar half of a provenance block: every field that describes the Barnes
 * analysis rather than the served mixture. Shared by the `hfr` and `composite`
 * responses so a composite's skill numbers cannot drift from a single-tier one's.
 *
 * @param {Object} hfr - Component from {@link runHfrTier}.
 * @returns {Object} Partial provenance.
 */
function hfrProvenanceFields(hfr) {
  return {
    datasetId: hfr.datasetId,
    label: hfr.label,
    url: hfr.url,
    sourceNote: hfr.sourceNote,
    validAtMs: hfr.validAtMs,
    ageMs: hfr.ageMs,
    ageLabel: hfr.ageLabel,
    stale: hfr.stale,
    resolutionKm: hfr.resolutionKm,
    gridSpacingKm: hfr.gridSpacingKm,
    observations: hfr.used,
    rejected: hfr.rejected,
    holdoutCount: hfr.metrics.holdoutCount,
    rmseMs: roundOrNull(hfr.metrics.rmseMs, FIELD_DECIMALS),
    maeMs: roundOrNull(hfr.metrics.maeMs, FIELD_DECIMALS),
    biasUMs: roundOrNull(hfr.metrics.biasUMs, FIELD_DECIMALS),
    biasVMs: roundOrNull(hfr.metrics.biasVMs, FIELD_DECIMALS),
    meanSigmaMs: roundOrNull(hfr.metrics.meanSigmaMs, FIELD_DECIMALS),
    lengthScaleM: hfr.lengthScaleM,
  };
}

/**
 * Assemble a response whose every drawn cell came from the HF-radar analysis:
 * either the fill was unnecessary ({@link HFR_SATURATION_COVERAGE}), the global
 * fetch failed, or the resampled fill happened to add no cell.
 *
 * The analysis is served whatever its coverage. Refusing a partial radar field
 * when there is no fill to be had would leave the user with nothing at all
 * rather than with the real observations plus honest voids, and the voids are
 * already `null` — never zero vectors — so the renderer draws them as absent.
 *
 * @param {Object} args - `{box, requestedAtMs, hfr, attempts, globalReason}`.
 * @returns {Object} A `gev-ocean-field` v1 payload with `provenance.tier = 'hfr'`.
 */
function hfrOnlyPayload({ box, requestedAtMs, hfr, attempts, globalReason }) {
  const caveats = [...hfr.caveats];
  const water = hfr.waterRelative ? 'the water in view' : 'the view';
  if (globalReason) {
    // The reason is quoted verbatim: it is a parenthetical, not a subordinate
    // clause, so lower-casing its first letter would mangle "ERDDAP 504".
    caveats.push(
      `The blended global field that would have filled the rest of ${water} is unavailable `
      + `(${globalReason}), so cells outside radar coverage are blank rather than modelled.`,
    );
  }
  const note = `Two-pass Barnes objective analysis (L = ${(hfr.lengthScaleM / 1000).toFixed(1)} km) `
    + `${hfr.usedVerb} ${hfr.used} quality-controlled HF-radar total vectors; `
    + `${Math.round(hfr.coverage * 100)}% of ${water} has a vector.`;
  return okPayload({
    box,
    requestedAtMs,
    grid: hfr.grid,
    u: hfr.u,
    v: hfr.v,
    finite: hfr.finite,
    attempts,
    provenance: {
      tier: TIERS.hfr.id,
      tierLabel: TIERS.hfr.label,
      ...hfrProvenanceFields(hfr),
      kind: 'observed',
      method: 'two-pass Barnes objective analysis of HF-radar total vectors',
      attribution: hfr.attribution,
      license: hfr.license,
      coverage: roundTo(hfr.coverage, 4),
      fallbackFrom: null,
      note,
      caveats,
      sources: [hfrSourceEntry(hfr, hfr.finite, 1)],
    },
  });
}

/**
 * Merge an HF-radar analysis with the global field resampled onto its lattice.
 *
 * Every drawn cell keeps ONE provenance: the radar value where the analysis has
 * one, the resampled blended value where it does not, `null` where neither does.
 * The two are never averaged — a mean of a 1 h-old 2 km observation and a
 * 2 day-old 28 km model value would be a number no instrument measured and no
 * model produced, and nothing downstream could say which it was.
 *
 * Degrades to the `hfr` naming when the fill turns out to add no cell at all, so
 * `provenance.tier` and `provenance.sources` always agree with the field. The
 * converse cannot arise: a component only exists above
 * {@link MIN_HFR_CONTRIBUTION}, and radar cells win every cell they occupy, so
 * an HF component always contributes to the merge it entered.
 *
 * @param {Object} args - `{box, grid, requestedAtMs, hfr, globalField, attempts}`.
 * @returns {Object} A `gev-ocean-field` v1 payload.
 */
function compositePayload({ box, grid, requestedAtMs, hfr, globalField, attempts }) {
  // Resample in degrees onto the analysis lattice, then blank land ONCE, here:
  // masking the 0.25 deg source first would erase a whole source cell's worth of
  // legitimately wet target cells around every land-centred cell, and the GSHHG
  // mask is 1/8 deg — finer than the source it would be censoring.
  const resampled = resampleBilinearOntoGrid(globalField.grid, globalField.u, globalField.v, grid);
  const merged = mergeComponents(hfr.u, hfr.v, resampled.u, resampled.v, hfr.water);

  if (merged.globalCells === 0) {
    return hfrOnlyPayload({
      box,
      requestedAtMs,
      hfr,
      attempts,
      globalReason: 'the blended global field has no data over the water this analysis leaves empty',
    });
  }

  const finite = merged.finite;
  const hfrShare = roundTo(merged.hfrCells / finite, 4);
  // The last share takes the remainder so the column sums to 1 exactly at the
  // reported precision, rather than to 0.9999 because both halves rounded down.
  const globalShare = roundTo(1 - hfrShare, 4);
  const { coverage, waterRelative } = waterCoverage(merged.u, hfr.water);
  const water = waterRelative ? 'the water in view' : 'the view';

  const caveats = [
    `${percent(hfrShare)} of drawn cells are ${describeResolution(hfr.resolutionKm)} HF radar `
    + `(${hfr.ageLabel}); the other ${percent(globalShare)} is `
    + `${describeResolution(globalField.resolutionKm)} ${globalField.fillLabel} (${globalField.ageLabel}).`,
    ...hfr.caveats,
    ...globalField.caveats.map((caveat) => `Global fill — ${lowerFirst(caveat)}`),
  ];

  // `fillLabel`, not a hardcoded product name: the fill can be HYCOM or the
  // altimetry fallback, and the split line above already uses it. Naming the
  // altimetry product here made a HYCOM-filled composite describe itself as a
  // blended analysis in the same payload that reported `kind: 'modeled'`.
  const note = `Two-pass Barnes objective analysis (L = ${(hfr.lengthScaleM / 1000).toFixed(1)} km) `
    + `${hfr.usedVerb} ${hfr.used} quality-controlled HF-radar total vectors over ${percent(hfrShare)} `
    + `of the drawn cells, with the remaining ${percent(globalShare)} bilinearly resampled from the `
    + `${globalField.fillLabel}; ${Math.round(coverage * 100)}% of ${water} has a vector.`;

  return okPayload({
    box,
    requestedAtMs,
    grid,
    u: merged.u,
    v: merged.v,
    finite,
    attempts,
    provenance: {
      tier: TIERS.composite.id,
      tierLabel: TIERS.composite.label,
      // The scalar fields keep describing the HF-radar component: they are its
      // dataset, its age and its cross-validated skill, and there is no
      // meaningful average of them with a gridded model product.
      ...hfrProvenanceFields(hfr),
      kind: 'mixed',
      method: 'two-pass Barnes objective analysis of HF-radar total vectors, with the remaining '
        + `water cells bilinearly resampled from the ${globalField.fillLabel} (one provenance per cell)`,
      // Credit lines are the exception: both products are drawn, so both are
      // credited here as well as in `sources`.
      attribution: joinUnique([hfr.attribution, globalField.attribution]),
      license: joinUnique([hfr.license, globalField.license]),
      coverage: roundTo(coverage, 4),
      fallbackFrom: null,
      note,
      caveats,
      sources: [
        hfrSourceEntry(hfr, merged.hfrCells, hfrShare),
        globalSourceEntry(globalField, merged.globalCells, globalShare),
      ],
    },
  });
}

/**
 * Fetch the blended global product and validate it into a field on ITS OWN
 * axes: oriented south-to-north and west-to-east, packed to the wire's
 * `null`-for-no-data convention, with the source metadata and the caveats that
 * are properties of the product itself (publication lag, staleness, striding,
 * a served time other than the requested one).
 *
 * Land is deliberately NOT blanked here and coverage is not scored, because the
 * two consumers need different lattices: {@link buildGlobalPayload} serves this
 * grid verbatim and masks it in place, while {@link compositePayload} resamples
 * it onto the HF-radar lattice and masks it there. An all-no-data field is
 * refused here, since neither consumer has any use for it.
 *
 * Non-uniform axes are treated as upstream shape drift and fail the tier rather
 * than being smoothed over.
 *
 * @param {Object} args - `{box, targetCells, requestedAtMs, fetchImpl, deps}`.
 * @returns {Promise<{field: ?Object, reason?: string}>} Field or failure reason.
 */
async function fetchGlobalField({ box, targetCells, requestedAtMs, fetchImpl, deps }) {
  const fetchGlobalCurrents = await resolveDep('fetchGlobalCurrents', deps);
  // `nowMs` is the reference the fetcher measures its own `source.ageMs` against.
  // Leaving it to default to Date.now() would report an age against the wall
  // clock while this payload's `ageMs` is documented as requestedAtMs - validAtMs
  // — the same number only while the caller asks for "now".
  const fetched = await fetchGlobalCurrents({
    box: plainBox(box), targetCells, fetchImpl, nowMs: requestedAtMs,
  });
  if (!fetched) return { field: null, reason: 'global current field unavailable' };

  // Axes and fields arrive as typed arrays (Float64Array/Float32Array), so
  // every check here is ArrayLike, never Array.isArray.
  const { lats, lons, u: srcU, v: srcV } = fetched;
  if (!isNonEmptyArrayLike(lats) || !isNonEmptyArrayLike(lons)) {
    return { field: null, reason: 'global current field returned no axes' };
  }
  const expected = lats.length * lons.length;
  if (!isIndexable(srcU, expected) || !isIndexable(srcV, expected)) {
    return {
      field: null,
      reason: `global current field has ${srcU?.length ?? 'no'} u values for a ${lats.length}x${lons.length} grid`,
    };
  }
  const latAxis = uniformAxis(lats);
  const lonAxis = uniformAxis(lons);
  if (!latAxis) return { field: null, reason: `global current field ${axisFault(lats, 'latitude')}` };
  if (!lonAxis) return { field: null, reason: `global current field ${axisFault(lons, 'longitude')}` };

  // Serve south-to-north, west-to-east regardless of the source's axis order,
  // so the client's sampler never has to branch on the sign of dLat/dLon.
  const nLat = latAxis.n;
  const nLon = lonAxis.n;
  const oriented = new Float64Array(expected);
  const orientedV = new Float64Array(expected);
  for (let i = 0; i < nLat; i += 1) {
    const si = latAxis.descending ? nLat - 1 - i : i;
    for (let j = 0; j < nLon; j += 1) {
      const sj = lonAxis.descending ? nLon - 1 - j : j;
      oriented[i * nLon + j] = toFiniteOrNaN(srcU[si * nLon + sj]);
      orientedV[i * nLon + j] = toFiniteOrNaN(srcV[si * nLon + sj]);
    }
  }

  const globalPacked = packField(oriented, orientedV, expected, GLOBAL_FIELD_SANITY_MAX_MS);
  const { u, v, finite } = globalPacked;
  if (finite === 0) {
    return { field: null, reason: 'global current field is entirely no-data over this view' };
  }

  const source = fetched.source ?? null;
  // A single-point axis exhibits no spacing of its own, and the wire format
  // promises a strictly positive dLat/dLon because a client divides by them. Take
  // the missing step from the fetcher's own report of what it SERVED
  // (`source.resolutionDeg`, which globalCurrents measures off the returned axis
  // and only falls back to its request plan for exactly this degenerate case) —
  // and refuse the tier when even that is absent, rather than shipping a zero
  // spacing or inventing a cell size around a single value.
  const reportedStepDeg = Number.isFinite(source?.resolutionDeg) && source.resolutionDeg > 0
    ? source.resolutionDeg
    : Number.NaN;
  const dLat = latAxis.step > 0 ? latAxis.step : reportedStepDeg;
  const dLon = lonAxis.step > 0 ? lonAxis.step : reportedStepDeg;
  if (!(dLat > 0) || !(dLon > 0)) {
    return {
      field: null,
      reason: `global current field returned a ${nLat}x${nLon} grid with no cell size to go with it`,
    };
  }

  const grid = { lat0: latAxis.first, lon0: lonAxis.first, dLat, dLon, nLat, nLon };
  const validAtMs = firstFinite(fetched.validAtMs, source?.validAtMs);
  const ageMs = resolveAgeMs(fetched.ageMs ?? source?.ageMs, validAtMs, requestedAtMs);
  // Evaluate the metric cell size at the SERVED grid's own centre latitude, not
  // the requested box's: ERDDAP snaps a constraint to its axis, so the two can
  // differ by up to a cell and the box centre is not a property of what is shipped.
  const gridMidLat = grid.lat0 + (nLat - 1) * dLat / 2;
  const spacing = gridSpacingKm(grid, gridMidLat);
  // One convention for `resolutionKm` on both branches: the cell's MERIDIONAL
  // height. The zonal width is reported separately as gridSpacingKm.lon and
  // collapses as cos(lat), so averaging the two would make a 0.25 deg product
  // read as "finer" at 60 N than TIERS.global.minResolutionKm claims is possible.
  const resolutionKm = firstFinite(
    Number.isFinite(reportedStepDeg) ? reportedStepDeg * metresPerDegLat(gridMidLat) / 1000 : Number.NaN,
    spacing.lat,
  );
  const stale = Number.isFinite(ageMs) && ageMs > GLOBAL_STALE_MS;
  const forecast = resolveForecast(source, ageMs);

  const caveats = [];
  // A served time later than the requested one has two DIFFERENT causes on this
  // tier and they need different sentences.
  //   - The altimetry fetcher always probes `time[(last)]`: it serves the
  //     dataset's newest step and cannot honour a historical `atMs`.
  //   - HYCOM is a forecast. `chooseHycomTimeIndex` picks the step NEAREST the
  //     requested instant out of an axis running -10 d to +5 d, so a future
  //     valid time is the model's own prediction, not a publication limit.
  // Saying "only the newest published step is available" over a forecast would
  // be false about the mechanism AND would omit the word the viewer needs.
  // The 60 s slack absorbs ordinary clock skew rather than flagging it.
  if (Number.isFinite(validAtMs) && validAtMs > requestedAtMs + 60_000) {
    caveats.push(forecast.isForecast
      ? 'This is a FORECAST step, not an analysis of the present: the field is valid '
        + `${new Date(validAtMs).toISOString()}`
        + `${Number.isFinite(forecast.forecastLeadMs) ? `, ${formatSpan(forecast.forecastLeadMs)} ahead of the requested time` : ''}.`
      : 'Only the newest published step is available, so this is not the time that was requested: '
        + `the field is valid ${new Date(validAtMs).toISOString()}.`);
  }
  if (Number.isFinite(ageMs) && ageMs >= 86400_000) {
    caveats.push(`Published with a multi-day lag: this analysis is ${formatAge(ageMs)}.`);
  }
  if (stale) caveats.push('Beyond the usual publication lag — the upstream feed may be behind.');
  // A strided request is a subsample, not the native field. Say so.
  if (Number.isFinite(source?.stride) && source.stride > 1) {
    const native = Number.isFinite(source?.nativeResolutionDeg) ? `${source.nativeResolutionDeg} deg` : 'native';
    caveats.push(`Subsampled every ${source.stride} cells from the ${native} grid to fit the view budget.`);
  }

  return {
    field: {
      grid,
      u,
      v,
      finite,
      spacing,
      caveats,
      datasetId: source?.datasetId ?? fetched.datasetId ?? null,
      label: source?.label ?? TIERS.global.label,
      url: source?.url ?? null,
      attribution: source?.attribution ?? null,
      license: source?.license ?? null,
      sourceNote: source?.note ?? null,
      // Physics description travels WITH the source: this tier can be served
      // by a primitive-equation model that carries tides and wind, or by a
      // purely geostrophic altimetric analysis that carries neither, and the
      // legend must state which the viewer is actually looking at.
      kind: source?.kind ?? null,
      // Short human name for the composite split line. HYCOM and the
      // altimetry fallback are different products; the caveat used to say
      // 'blended global currents' whichever served.
      fillLabel: source?.kind === 'modeled'
        ? 'HYCOM global forecast currents'
        : 'blended altimetric geostrophic currents',
      method: source?.method ?? null,
      fallbackFrom: source?.fallbackFrom ?? null,
      validAtMs: Number.isFinite(validAtMs) ? validAtMs : null,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      ageLabel: formatAge(ageMs),
      // Travels with the field so every downstream consumer — the global
      // payload, the composite split line, and each `sources[]` entry — can say
      // "forecast" without re-deriving it from the sign of `ageMs`.
      isForecast: forecast.isForecast,
      forecastLeadMs: forecast.forecastLeadMs,
      stale,
      resolutionKm: Number.isFinite(resolutionKm) ? roundTo(resolutionKm, 2) : null,
    },
  };
}

/**
 * The `provenance.sources` entry for the blended global field.
 *
 * `resolutionKm` is the SOURCE's own meridional cell height (~27.8 km at 0.25
 * deg), not the lattice the values were resampled onto — a composite draws these
 * cells at the HF-radar spacing, and reporting that spacing here would claim a
 * resolution the product does not have.
 *
 * @param {Object} field - Field from {@link fetchGlobalField}.
 * @param {number} cells - Finite served cells this source supplied.
 * @param {number} share - `cells / stats.finite`, already rounded.
 * @returns {Object} One `sources[]` entry; see the `@file` block.
 */
function globalSourceEntry(field, cells, share) {
  return {
    tier: TIERS.global.id,
    kind: field.kind ?? 'derived',
    label: field.label,
    datasetId: field.datasetId,
    validAtMs: field.validAtMs,
    ageMs: field.ageMs,
    ageLabel: field.ageLabel,
    isForecast: field.isForecast ?? false,
    forecastLeadMs: field.forecastLeadMs ?? null,
    stale: field.stale,
    resolutionKm: field.resolutionKm,
    cells,
    cellShare: share,
    url: field.url,
    attribution: field.attribution,
    license: field.license,
    // The physics actually served, and — when the preferred source did not —
    // why. `globalTier.describe()` records both; every builder above this used
    // to drop them, so a silent degradation from tide-and-wind-carrying
    // primitive equations to geostrophic-only altimetry left no trace at all.
    //
    // Deliberately NOT called `fallbackFrom`: at provenance level that name
    // already means "which TIER this stood in for" and holds a tier id, while
    // this holds a prose reason about a source WITHIN the tier. One name over
    // two meanings is how the reason got lost in the first place.
    method: field.method ?? null,
    preferredSourceUnavailable: field.fallbackFrom ?? null,
  };
}

/**
 * Serve the global field alone, on ITS OWN axes. The field is deliberately not
 * resampled onto the target grid on this path — upsampling a 0.25 deg product
 * would ship invented intermediate values, and the fetcher already sized its
 * stride to the cell budget. (A COMPOSITE has no such choice: two sources have
 * to share one lattice, so there {@link compositePayload} resamples and says so
 * in the legend.)
 *
 * @param {Object} args - `{globalField, box, requestedAtMs, deps, fallbackFrom, fallbackReason}`.
 * @returns {Promise<{payload: ?Object, reason?: string}>} Payload or failure reason.
 */
async function buildGlobalPayload({ globalField, box, requestedAtMs, deps, fallbackFrom, fallbackReason }) {
  const { grid, u, v } = globalField;
  // 0.25° cells straddle coastlines, so the blended analysis carries values on
  // cells that are mostly land. Blank those and measure coverage over the water,
  // for the same reason the HF-radar tier does. Done here rather than in
  // fetchGlobalField because the composite masks the RESAMPLED copy instead.
  const water = await classifyWaterCellsFromBundle(grid, deps);
  const finite = globalField.finite - blankLandCells(u, v, water);
  if (finite === 0) {
    return { payload: null, reason: 'global current field covers no water in this view' };
  }
  const coverage = waterCoverage(u, water);

  const caveats = [...globalField.caveats];
  if (fallbackFrom && fallbackReason) {
    caveats.push(`Shown instead of HF radar because ${lowerFirst(fallbackReason)}.`);
  }
  // A degradation WITHIN the tier changes the physics, not just the resolution:
  // the altimetry fallback carries no Ekman drift and no tides at all. That is
  // the kind of substitution this payload exists to announce, so it goes in the
  // legend rather than staying in a field nothing reads.
  if (globalField.fallbackFrom) {
    caveats.push(`${globalField.fallbackFrom}. This field is geostrophic only — no wind drift, no tides.`);
  }

  return {
    payload: okPayload({
      box,
      requestedAtMs,
      grid,
      u,
      v,
      finite,
      provenance: {
        tier: TIERS.global.id,
        tierLabel: TIERS.global.label,
        datasetId: globalField.datasetId,
        label: globalField.label,
        // Source-driven, not hardcoded: the global tier can be served by more
        // than one product (a primitive-equation model that carries tides and
        // wind, or a purely geostrophic altimetric analysis that carries
        // neither), and the legend must state which physics the user is looking
        // at. A source that declares neither falls back to the altimetry
        // description, which is what this tier used to be unconditionally.
        kind: globalField.kind ?? 'derived',
        method: globalField.method
          ?? 'absolute geostrophic velocity from multi-mission altimetry (f-plane, beta-plane at the equator); NO Ekman or wind-driven component',
        url: globalField.url,
        attribution: globalField.attribution,
        license: globalField.license,
        sourceNote: globalField.sourceNote,
        validAtMs: globalField.validAtMs,
        ageMs: globalField.ageMs,
        ageLabel: globalField.ageLabel,
        isForecast: globalField.isForecast ?? false,
        forecastLeadMs: globalField.forecastLeadMs ?? null,
        stale: globalField.stale,
        resolutionKm: globalField.resolutionKm,
        gridSpacingKm: globalField.spacing,
        coverage: roundTo(coverage.coverage, 4),
        observations: null, // a gridded analysis, not a set of point observations
        rejected: null,
        holdoutCount: 0,
        rmseMs: null,
        maeMs: null,
        biasUMs: null,
        biasVMs: null,
        meanSigmaMs: null,
        lengthScaleM: null,
        fallbackFrom: fallbackFrom ?? null,
        // Derived the same way `fillLabel` is, for the same reason: this tier
        // has two possible products and they are not the same thing. The note
        // used to name the altimetry product unconditionally, so a HYCOM-served
        // response shipped `kind: 'modeled'` beside a sentence calling it a
        // blended derived analysis.
        note: globalField.kind === 'modeled'
          ? 'Global ocean forecast — a primitive-equation model carrying tides and wind drift, not a direct current measurement.'
          : 'Blended global surface currents — a derived model product, not a direct current measurement.',
        caveats,
        sources: [globalSourceEntry(globalField, finite, 1)],
      },
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Compositing: resample, then merge
 * ------------------------------------------------------------------ */

/**
 * Resample a coarse source field onto a finer target lattice by BILINEAR
 * interpolation in degrees, component-wise on u and v.
 *
 * Bilinear rather than nearest-neighbour, deliberately. The source is 0.25 deg
 * (~27.8 km) and the target lattice is 1–2 km, so every source cell covers on
 * the order of 100–400 target cells: nearest-neighbour would draw the fill as
 * visible 28 km blocks with a velocity discontinuity at every block edge, and
 * the layer's streaklines integrate that field — particles would kink at each
 * seam. Bilinear is C0 with piecewise-constant gradients, which is not
 * physically exact either, but it is the cheapest choice whose discontinuities
 * are in the derivative rather than the value. Interpolating u and v separately
 * is the right decomposition here because both are components in one fixed ENU
 * frame over a view a few hundred km wide; it is NOT valid for speed/direction
 * pairs, which is why this takes the components.
 *
 * NO-DATA IS REFUSED, NEVER SUBSTITUTED. A target cell whose interpolation needs
 * a `null` source corner stays `null` — treating a void as zero would draw
 * "still water" where the product says "no value", the single failure this whole
 * module exists to prevent. Only corners carrying NONZERO weight are required:
 * a target node landing exactly on a source node takes that node's value even if
 * a neighbour is void, since the neighbour contributes nothing to the sum. The
 * cost of the rule is a halo up to one source cell wide around every void, which
 * on a composite is mostly nearshore — precisely where the HF-radar analysis it
 * is filling around has data.
 *
 * Target nodes outside the source's outermost CENTRES are admitted up to
 * {@link RESAMPLE_EDGE_CELLS} of a cell (the clamped fraction degenerates the
 * weights onto the edge cell); beyond that they are `null` rather than
 * extrapolated. Longitudes are compared modulo 360, so an antimeridian-crossing
 * target lattice (whose axis may run past +180) meets a source axis in any
 * frame, as long as the source spans less than 360 deg — which the global
 * fetcher's per-view request always does.
 *
 * Values are rounded to {@link FIELD_DECIMALS}, like every other served number.
 * No magnitude gate is applied: a bilinear combination is a convex combination,
 * so it cannot leave the envelope the source's own corners already passed.
 *
 * @param {{lat0: number, lon0: number, dLat: number, dLon: number, nLat: number, nLon: number}} srcGrid
 *   Source lattice, ascending, `dLat`/`dLon` in degrees and strictly positive.
 * @param {Array<?number>} srcU - Source eastward field, row-major, `null` for no data.
 * @param {Array<?number>} srcV - Source northward field, same indexing.
 * @param {{lats: number[], lons: number[], nLat: number, nLon: number}} target - Target lattice.
 * @returns {{u: Array<?number>, v: Array<?number>, finite: number}} The field on
 *   the target lattice, row-major as `latIndex * target.nLon + lonIndex`.
 */
export function resampleBilinearOntoGrid(srcGrid, srcU, srcV, target) {
  const n = target.nLat * target.nLon;
  const u = new Array(n).fill(null);
  const v = new Array(n).fill(null);
  let finite = 0;
  const lonSpanDeg = (srcGrid.nLon - 1) * srcGrid.dLon;

  // Column brackets do not depend on the row, so they are computed once.
  const columns = new Array(target.nLon);
  for (let j = 0; j < target.nLon; j += 1) {
    const f = axisFraction(wrapEastward(target.lons[j] - srcGrid.lon0, lonSpanDeg), srcGrid.dLon, srcGrid.nLon);
    columns[j] = Number.isFinite(f) ? bracketFraction(f, srcGrid.nLon) : null;
  }

  for (let i = 0; i < target.nLat; i += 1) {
    const fy = axisFraction(target.lats[i] - srcGrid.lat0, srcGrid.dLat, srcGrid.nLat);
    if (!Number.isFinite(fy)) continue;
    const row = bracketFraction(fy, srcGrid.nLat);
    for (let j = 0; j < target.nLon; j += 1) {
      const col = columns[j];
      if (!col) continue;
      const wu = bilinearSample(srcU, srcGrid.nLon, row, col);
      if (wu == null) continue;
      const wv = bilinearSample(srcV, srcGrid.nLon, row, col);
      if (wv == null) continue;
      const k = i * target.nLon + j;
      u[k] = roundTo(wu, FIELD_DECIMALS);
      v[k] = roundTo(wv, FIELD_DECIMALS);
      finite += 1;
    }
  }
  return { u, v, finite };
}

/**
 * One bilinear sample, or `null` if any corner carrying weight is no-data.
 *
 * @param {Array<?number>} field - Source component, row-major.
 * @param {number} nLon - Source column count (the row stride).
 * @param {{i0: number, i1: number, t: number}} row - Row bracket and fraction.
 * @param {{i0: number, i1: number, t: number}} col - Column bracket and fraction.
 * @returns {?number} The interpolated value, or null.
 */
function bilinearSample(field, nLon, row, col) {
  const weights = [
    [row.i0 * nLon + col.i0, (1 - row.t) * (1 - col.t)],
    [row.i0 * nLon + col.i1, (1 - row.t) * col.t],
    [row.i1 * nLon + col.i0, row.t * (1 - col.t)],
    [row.i1 * nLon + col.i1, row.t * col.t],
  ];
  let sum = 0;
  for (const [index, weight] of weights) {
    if (weight === 0) continue; // a corner the sample does not actually need
    const value = field[index];
    if (value == null) return null; // refuse; never substitute zero
    sum += weight * value;
  }
  return sum;
}

/**
 * Fractional index of a coordinate on a uniform ascending axis, or NaN when it
 * lies further than {@link RESAMPLE_EDGE_CELLS} outside the axis endpoints. The
 * returned fraction is clamped into `[0, n-1]`, so a coordinate inside that
 * half-cell margin resolves onto the edge cell rather than being extrapolated.
 *
 * @param {number} delta - Coordinate minus the axis origin, degrees.
 * @param {number} step - Axis spacing, degrees, strictly positive.
 * @param {number} n - Axis length.
 * @returns {number} Fractional index in [0, n-1], or NaN.
 */
function axisFraction(delta, step, n) {
  const f = delta / step;
  if (!(f >= -RESAMPLE_EDGE_CELLS) || !(f <= n - 1 + RESAMPLE_EDGE_CELLS)) return Number.NaN;
  return Math.min(n - 1, Math.max(0, f));
}

/**
 * Bracket a fractional index between two adjacent nodes.
 *
 * @param {number} f - Fractional index in [0, n-1].
 * @param {number} n - Axis length; a one-point axis brackets onto itself with weight 1.
 * @returns {{i0: number, i1: number, t: number}} Lower node, upper node, and the
 *   fraction of the way from the first to the second.
 */
function bracketFraction(f, n) {
  if (n < 2) return { i0: 0, i1: 0, t: 0 };
  const i0 = Math.min(Math.floor(f), n - 2);
  return { i0, i1: i0 + 1, t: f - i0 };
}

/**
 * Reduce a longitude difference into the source axis's own frame, modulo 360.
 * Differences land in `[0, 360)` and anything more than 180 deg past the axis's
 * eastern end is read as the corresponding negative offset, which is what lets a
 * target lattice numbered 179..181 meet a source numbered -180..-179.
 *
 * @param {number} deltaDeg - Target longitude minus source origin, degrees.
 * @param {number} spanDeg - Longitude extent of the source axis, degrees.
 * @returns {number} The difference in the source's frame, degrees.
 */
function wrapEastward(deltaDeg, spanDeg) {
  const d = ((deltaDeg % 360) + 360) % 360;
  return d > spanDeg + 180 ? d - 360 : d;
}

/**
 * Merge an HF-radar field with a resampled global field on one lattice.
 *
 * Precedence is absolute: the radar value wins wherever it exists, the fill is
 * used only where it does not, and a cell neither one covers is `null`. Nothing
 * is blended — see {@link compositePayload} for why a cell may not have two
 * provenances at once. Land is blanked last, through the shared
 * `blankLandCells` helper, so the counts describe exactly what is served.
 *
 * @param {Array<?number>} hfrU - HF-radar eastward field (already land-blanked).
 * @param {Array<?number>} hfrV - HF-radar northward field.
 * @param {Array<?number>} fillU - Resampled global eastward field, same lattice.
 * @param {Array<?number>} fillV - Resampled global northward field.
 * @param {?{eligible: Uint8Array}} water - Water classification of the lattice.
 * @returns {{u: Array<?number>, v: Array<?number>, finite: number,
 *            hfrCells: number, globalCells: number}} Merged field and the
 *   per-source cell counts, which sum to `finite`.
 */
function mergeComponents(hfrU, hfrV, fillU, fillV, water) {
  const n = hfrU.length;
  const u = new Array(n);
  const v = new Array(n);
  for (let k = 0; k < n; k += 1) {
    if (hfrU[k] != null) {
      u[k] = hfrU[k];
      v[k] = hfrV[k];
    } else if (fillU[k] != null) {
      u[k] = fillU[k];
      v[k] = fillV[k];
    } else {
      u[k] = null;
      v[k] = null;
    }
  }
  blankLandCells(u, v, water);
  let finite = 0;
  let hfrCells = 0;
  let globalCells = 0;
  for (let k = 0; k < n; k += 1) {
    if (u[k] == null) continue;
    finite += 1;
    if (hfrU[k] != null) hfrCells += 1;
    else globalCells += 1;
  }
  return { u, v, finite, hfrCells, globalCells };
}

/* ------------------------------------------------------------------ *
 * Payload assembly
 * ------------------------------------------------------------------ */

/**
 * Assemble a successful payload and its speed statistics.
 *
 * @param {Object} args - Grid, packed field, the provenance block, and the
 *   `attempts` recorded before this response was assembled (default none).
 * @returns {Object} A `gev-ocean-field` v1 payload with `status: 'ok'`.
 */
function okPayload({ box, requestedAtMs, grid, u, v, finite, provenance, attempts = [] }) {
  const cells = u.length;
  return {
    status: 'ok',
    format: FIELD_FORMAT,
    version: FIELD_FORMAT_VERSION,
    generatedAtMs: Date.now(),
    requestedAtMs,
    box: plainBox(box),
    grid: {
      lat0: grid.lat0,
      lon0: grid.lon0,
      dLat: grid.dLat,
      dLon: grid.dLon,
      nLat: grid.nLat,
      nLon: grid.nLon,
    },
    u,
    v,
    stats: { cells, finite, ...speedStats(u, v) },
    provenance,
    attempts,
    reason: null,
  };
}

/**
 * Assemble the refusal payload. Geometry and field are `null`, never empty
 * arrays: a client that forgets to check `status` should fail loudly rather
 * than render a blank ocean as if it were a calm one.
 *
 * @param {Object} args - The box (possibly malformed), timing, and reasons.
 * @returns {Object} A `gev-ocean-field` v1 payload with `status: 'unavailable'`.
 */
function unavailablePayload({ box, requestedAtMs, attempts, reason }) {
  return {
    status: 'unavailable',
    format: FIELD_FORMAT,
    version: FIELD_FORMAT_VERSION,
    generatedAtMs: Date.now(),
    requestedAtMs,
    box: plainBox(box),
    grid: null,
    u: null,
    v: null,
    stats: null,
    provenance: null,
    attempts,
    reason,
  };
}

/* ------------------------------------------------------------------ *
 * Dependency resolution
 * ------------------------------------------------------------------ */

/**
 * Import one sibling module by a literal specifier so bundlers can still see
 * the graph. Node caches module instances, so repeat calls are free.
 *
 * @param {string} name - Dependency export name.
 * @returns {Promise<Object>} The module namespace.
 */
function importDepModule(name) {
  switch (name) {
    case 'fetchHfrField': return import('./hfradar.js');
    // The global tier is source-SELECTED (HYCOM preferred, altimetry fallback);
    // see server/ocean/globalTier for why those are different physics.
    case 'fetchGlobalCurrents': return import('./globalTier.js');
    default: return import('./barnes.js'); // barnesVector, validateAnalysis
  }
}

/**
 * Resolve a required dependency: the injected function if present, else the
 * sibling module's export.
 *
 * @param {string} name - Export name.
 * @param {Object} overrides - Injected dependency map.
 * @returns {Promise<Function>} The resolved function.
 * @throws {Error} If neither an injection nor a module export supplies it.
 */
async function resolveDep(name, overrides) {
  const injected = overrides?.[name];
  if (typeof injected === 'function') return injected;
  const mod = await importDepModule(name);
  const fn = mod?.[name];
  if (typeof fn !== 'function') throw new Error(`ocean tier dependency ${name}() is missing`);
  return fn;
}

/**
 * Resolve a diagnostic dependency, returning `null` instead of throwing when it
 * cannot be found — losing cross-validation must not lose the field.
 *
 * @param {string} name - Export name.
 * @param {Object} overrides - Injected dependency map.
 * @returns {Promise<?Function>} The function, or null.
 */
async function resolveDepOptional(name, overrides) {
  try {
    return await resolveDep(name, overrides);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** @const {Object} Metrics stand-in when cross-validation did not run. */
const EMPTY_METRICS = Object.freeze({
  holdoutCount: 0,
  rmseMs: null,
  maeMs: null,
  biasUMs: null,
  biasVMs: null,
  meanSigmaMs: null,
});

/**
 * Run holdout cross-validation, returning {@link EMPTY_METRICS} rather than
 * throwing if the dependency is absent or returns an unexpected shape — a lost
 * diagnostic must never cost the user the field it was diagnosing. Bias fields
 * are read under both `barnes.js`'s names (`biasU`) and the reference project's
 * `ValidationMetrics` names (`holdoutBiasU`), so either sibling reports numbers.
 *
 * @param {?Function} validateAnalysis - `(obs, xs, ys, L, opts) -> metrics`.
 * @param {Array<Object>} obs - Projected observations, metres.
 * @param {Float64Array} xs - Column axis, metres.
 * @param {Float64Array} ys - Row axis, metres.
 * @param {number} lengthScaleM - Barnes pass-1 length scale, metres.
 * @param {{holdoutFrac: number, seed: number}} opts - Split controls.
 * @returns {{holdoutCount: number, rmseMs: ?number, maeMs: ?number,
 *            biasUMs: ?number, biasVMs: ?number, meanSigmaMs: ?number}} Metrics.
 */
function safeValidate(validateAnalysis, obs, xs, ys, lengthScaleM, opts) {
  if (typeof validateAnalysis !== 'function') return EMPTY_METRICS;
  let raw;
  try {
    raw = validateAnalysis(obs, xs, ys, lengthScaleM, opts);
  } catch {
    return EMPTY_METRICS;
  }
  if (!raw || typeof raw !== 'object') return EMPTY_METRICS;
  const finiteOr = (...values) => {
    for (const value of values) if (Number.isFinite(value)) return value;
    return null;
  };
  return {
    holdoutCount: finiteOr(raw.holdoutCount, raw.count) ?? 0,
    rmseMs: finiteOr(raw.rmseMs, raw.holdoutRmseMs),
    maeMs: finiteOr(raw.maeMs, raw.holdoutMaeMs),
    biasUMs: finiteOr(raw.biasU, raw.biasUMs, raw.holdoutBiasU),
    biasVMs: finiteOr(raw.biasV, raw.biasVMs, raw.holdoutBiasV),
    meanSigmaMs: finiteOr(raw.meanSigmaMs),
  };
}

/**
 * Per-observation Barnes weight. Prefers a `quality` the fetcher already
 * computed; otherwise derives one from HDOP as `1/(1+HDOP)`, the reference
 * project's form (`ingest/hfradar.ts` + `reconstruct.ts`, HDOP defaulting to
 * 0.4 when absent — the same default the sibling `./hfradar.js` exports as
 * `HFR_DEFAULT_HDOP`, so the two must move together). This fallback is dead
 * weight against the real fetcher, which sets `quality` on every observation; it
 * only fires for a hand-built or third-party vector set. A strict
 * inverse-variance weight would be HDOP^-2, since
 * the total-vector error scales as HDOP times the radial error, but that lets
 * one low-HDOP cell dominate a whole Barnes neighbourhood — and the fetcher's
 * QC already rejects HDOP > 1.6, so the surviving spread is narrow. We keep the
 * softer form deliberately.
 *
 * @param {{hdop?: ?number, quality?: number}} observation - One HF-radar vector.
 * @returns {number} A weight multiplier in (0, 1].
 */
function observationQuality(observation) {
  if (Number.isFinite(observation.quality) && observation.quality > 0) {
    return Math.min(1, observation.quality);
  }
  const hdop = Number.isFinite(observation.hdop) && observation.hdop > 0 ? observation.hdop : 0.4;
  return 1 / (1 + hdop);
}

/**
 * Convert analysis arrays into the wire field: rounded plain numbers, `null`
 * wherever either component is missing or implausible, and a count of the
 * cells that survived.
 *
 * @param {ArrayLike<number>} au - Eastward analysis values (NaN in voids).
 * @param {ArrayLike<number>} av - Northward analysis values.
 * @param {number} n - Cell count.
 * @param {number} maxMs - Per-component magnitude gate for THIS tier, m/s
 *   ({@link FIELD_SANITY_MAX_MS} or {@link GLOBAL_FIELD_SANITY_MAX_MS}).
 *   Required, not defaulted: a single default would silently apply one tier's
 *   envelope to the other's data.
 * @returns {{u: Array<?number>, v: Array<?number>, finite: number}} Wire arrays and coverage count.
 */
function packField(au, av, n, maxMs) {
  const u = new Array(n);
  const v = new Array(n);
  let finite = 0;
  for (let k = 0; k < n; k += 1) {
    const a = au[k];
    const b = av[k];
    if (!Number.isFinite(a) || !Number.isFinite(b)
      || Math.abs(a) > maxMs || Math.abs(b) > maxMs) {
      u[k] = null;
      v[k] = null;
      continue;
    }
    u[k] = roundTo(a, FIELD_DECIMALS);
    v[k] = roundTo(b, FIELD_DECIMALS);
    finite += 1;
  }
  return { u, v, finite };
}

/**
 * Speed statistics over the finite cells only, for the renderer's color scale.
 * The p95 is nearest-rank (no interpolation), so it is always an attained value.
 *
 * @param {Array<?number>} u - Eastward wire field.
 * @param {Array<?number>} v - Northward wire field.
 * @returns {{speedMeanMs: ?number, speedP95Ms: ?number, speedMaxMs: ?number}} Rounded speeds, null when empty.
 */
function speedStats(u, v) {
  const speeds = [];
  let sum = 0;
  for (let k = 0; k < u.length; k += 1) {
    if (u[k] == null || v[k] == null) continue;
    const s = Math.hypot(u[k], v[k]);
    speeds.push(s);
    sum += s;
  }
  if (speeds.length === 0) return { speedMeanMs: null, speedP95Ms: null, speedMaxMs: null };
  speeds.sort((a, b) => a - b);
  const p95 = speeds[Math.min(speeds.length - 1, Math.max(0, Math.ceil(0.95 * speeds.length) - 1))];
  return {
    speedMeanMs: roundTo(sum / speeds.length, FIELD_DECIMALS),
    speedP95Ms: roundTo(p95, FIELD_DECIMALS),
    speedMaxMs: roundTo(speeds[speeds.length - 1], FIELD_DECIMALS),
  };
}

/**
 * Check that a source axis is a uniform lattice and report its orientation.
 *
 * Tolerance on the fit is the larger of 0.1% of the step and
 * {@link FLOAT32_COORD_TOL_DEG} — sources round or Float32-quantise their axis
 * values, so exact equality would reject valid grids, while anything looser
 * would let a genuinely irregular axis through. Both bounds are still two to
 * three orders of magnitude finer than a step, so no irregularity large enough
 * to misplace a cell can pass.
 *
 * A one-point axis is accepted with `step: 0`: it IS a lattice, it simply
 * exhibits no spacing, and the caller — not this predicate — decides what to do
 * about that. Two identical values are rejected, since that is a collapsed axis
 * rather than a coarse one.
 *
 * @param {ArrayLike<number>} axis - Coordinate values, ascending or descending.
 * @returns {?{first: number, step: number, n: number, descending: boolean}} Axis
 *   description with `first`/`step` already oriented ascending (`step >= 0`), or
 *   null if the axis is non-finite or non-uniform.
 */
function uniformAxis(axis) {
  const n = axis.length;
  for (let i = 0; i < n; i += 1) if (!Number.isFinite(axis[i])) return null;
  if (n === 1) return { first: axis[0], step: 0, n: 1, descending: false };
  const rawStep = (axis[n - 1] - axis[0]) / (n - 1);
  if (rawStep === 0) return null;
  const tol = Math.max(Math.abs(rawStep) * 1e-3, FLOAT32_COORD_TOL_DEG);
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(axis[i] - (axis[0] + i * rawStep)) > tol) return null;
  }
  const descending = rawStep < 0;
  return {
    first: descending ? axis[n - 1] : axis[0],
    step: Math.abs(rawStep),
    n,
    descending,
  };
}

/**
 * Describe why {@link uniformAxis} rejected an axis, so the tier's `reason`
 * names the actual fault instead of blaming every failure on non-uniform
 * spacing. Only ever called on the failure path, so the second scan is free.
 *
 * @param {ArrayLike<number>} axis - The rejected axis.
 * @param {string} name - `'latitude'` or `'longitude'`.
 * @returns {string} A clause to append to the tier's failure reason.
 */
function axisFault(axis, name) {
  for (let i = 0; i < axis.length; i += 1) {
    if (!Number.isFinite(axis[i])) {
      return `${name} axis has a non-finite value at index ${i} (${String(axis[i])})`;
    }
  }
  if (axis.length >= 2 && axis[axis.length - 1] === axis[0]) {
    return `${name} axis of ${axis.length} points spans no range at all`;
  }
  return `${name} axis of ${axis.length} points is not uniformly spaced`;
}

/**
 * Served cell size in kilometres, evaluated at the box's centre latitude.
 *
 * @param {{dLat: number, dLon: number}} grid - Grid spacing in degrees.
 * @param {number} midLat - Centre latitude, degrees.
 * @returns {{lat: number, lon: number}} Cell size, km, rounded to 3 decimals (1 m).
 */
function gridSpacingKm(grid, midLat) {
  return {
    lat: roundTo(grid.dLat * metresPerDegLat(midLat) / 1000, 3),
    lon: roundTo(grid.dLon * metresPerDegLon(midLat) / 1000, 3),
  };
}

/**
 * Age of a field: the fetcher's own `ageMs` when it gave one, else derived from
 * the valid time.
 *
 * THE TWO BRANCHES MEASURE AGAINST DIFFERENT CLOCKS, and that is why only one
 * of them keeps its sign.
 *
 *   - `reported` comes from the fetcher and is measured against **now**
 *     (`hycomCurrents` computes `nowMs - validAtMs`). Its sign is meaningful:
 *     negative means the step is valid in the future, i.e. a forecast. It is
 *     passed through untouched. This function used to clamp it with
 *     `Math.max(0, …)`, which made a five-day HYCOM forecast render as
 *     `just now` with `stale: false` — the exact substitution
 *     `hycomCurrents.js`'s `@file` block calls "the one thing a freshness
 *     number must never do".
 *   - The derived fallback is measured against **the requested instant**, which
 *     the caller may have set in the past. A negative value there does not mean
 *     forecast; it means the tier could only serve a step later than the one
 *     asked for — the altimetry fetcher probes `time[(last)]` and cannot honour
 *     a historical `atMs`. That mismatch is already reported as its own caveat,
 *     so the number itself clamps at zero rather than claiming a lead it does
 *     not have.
 *
 * Ordinary clock skew is not this function's problem: {@link formatAge} reads
 * anything inside ±60 s as "just now".
 *
 * @param {?number} reported - `ageMs` from the fetcher, measured against now.
 * @param {?number} validAtMs - Valid time, ms since epoch.
 * @param {number} requestedAtMs - The time the field was requested for.
 * @returns {number} Age in ms — negative only for a reported forecast — or NaN.
 */
function resolveAgeMs(reported, validAtMs, requestedAtMs) {
  if (Number.isFinite(reported)) return reported;
  if (Number.isFinite(validAtMs)) return Math.max(0, requestedAtMs - validAtMs);
  return Number.NaN;
}

/**
 * Whether a field is valid ahead of NOW, and by how much.
 *
 * Reads only the fetcher's own declaration. It deliberately does NOT infer
 * forecast-ness from the sign of `ageMs`: on the derived branch that sign is
 * relative to the requested instant, so a historical request served with the
 * newest available analysis would be labelled a forecast when it is nothing of
 * the kind. A source that does not declare itself is treated as an analysis.
 *
 * @param {?Object} source - The fetcher's `source` descriptor, if any.
 * @param {number} ageMs - Signed age from {@link resolveAgeMs}.
 * @returns {{isForecast: boolean, forecastLeadMs: ?number}}
 */
function resolveForecast(source, ageMs) {
  if (source?.isForecast !== true) return { isForecast: false, forecastLeadMs: null };
  const lead = firstFinite(source?.forecastLeadMs, Number.isFinite(ageMs) ? -ageMs : Number.NaN);
  return { isForecast: true, forecastLeadMs: Number.isFinite(lead) && lead > 0 ? lead : null };
}

/**
 * Echo a view box as four plain numbers, tolerating a malformed input so the
 * refusal payload can still say what was asked for. A non-finite bound becomes
 * `null` (it is reporting what the caller sent, not repairing it) and a signed
 * zero collapses to `+0`, which is what keeps the echo `deepStrictEqual` to its
 * own JSON round trip.
 *
 * @param {*} box - Any candidate box.
 * @returns {?{latMin: ?number, lonMin: ?number, latMax: ?number, lonMax: ?number}} JSON-safe echo, or null.
 */
function plainBox(box) {
  if (!box || typeof box !== 'object') return null;
  const n = (value) => (Number.isFinite(value) ? value + 0 : null);
  return { latMin: n(box.latMin), lonMin: n(box.lonMin), latMax: n(box.latMax), lonMax: n(box.lonMax) };
}

/**
 * Round to `decimals` places, collapsing -0 to 0 so the payload survives a
 * `JSON` round trip under `deepStrictEqual` (which distinguishes the two).
 *
 * @param {number} value - Any finite number.
 * @param {number} decimals - Decimal places.
 * @returns {number} The rounded value.
 */
function roundTo(value, decimals) {
  const scale = 10 ** decimals;
  const r = Math.round(value * scale) / scale;
  return r === 0 ? 0 : r;
}

/** @param {?number} value @param {number} decimals @returns {?number} Rounded, or null if not finite. */
function roundOrNull(value, decimals) {
  return Number.isFinite(value) ? roundTo(value, decimals) : null;
}

/** @param {...*} values @returns {number} The first finite argument, else NaN. */
function firstFinite(...values) {
  for (const value of values) if (Number.isFinite(value)) return value;
  return Number.NaN;
}

/** @param {*} value @returns {number} The number, or NaN for anything non-finite (null included). */
function toFiniteOrNaN(value) {
  return Number.isFinite(value) ? value : Number.NaN;
}

/** @param {*} array @param {number} length @returns {boolean} True if indexable with exactly `length` entries. */
function isIndexable(array, length) {
  return Boolean(array) && typeof array.length === 'number' && array.length === length;
}

/** @param {*} array @returns {boolean} True for a non-empty Array or TypedArray. */
function isNonEmptyArrayLike(array) {
  return Boolean(array) && typeof array.length === 'number' && array.length > 0;
}

/**
 * Index of the first entry that does not strictly exceed its predecessor — the
 * precondition `barnesVector` imposes on both of its axes.
 *
 * @param {ArrayLike<number>} axis - Candidate axis, metres.
 * @returns {number} The offending index, or -1 when the axis is strictly increasing.
 */
function firstNonIncreasing(axis) {
  for (let i = 1; i < axis.length; i += 1) {
    if (!(axis[i] > axis[i - 1])) return i;
  }
  return -1;
}

/** @param {number} value @param {number} lo @param {number} hi @returns {number} `value` clamped to [lo, hi]. */
function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** @param {*} error @returns {string} A one-line message safe to put in a payload. */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim() || 'unknown error';
}

/** @param {string} text @returns {string} `text` with its first character lowercased. */
function lowerFirst(text) {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

/**
 * Render a share as a whole percentage for the legend. Whole percent because the
 * number it describes — how much of the drawn field came from which instrument —
 * is a proportion of cells whose exact value moves with the lattice size.
 *
 * @param {number} share - Fraction in [0, 1].
 * @returns {string} e.g. `'68%'`.
 */
function percent(share) {
  return `${Math.round(share * 100)}%`;
}

/**
 * Render a native resolution for the legend: one decimal below 10 km (the
 * HF-radar products are 1, 2 and 6 km, where 0.1 km matters) and whole
 * kilometres above it (28 km, not 27.75 km, which would imply the blended
 * product's cell size is known to 10 m — it is a 0.25 deg cell whose ground
 * height varies with latitude).
 *
 * @param {?number} km - Native spacing, kilometres.
 * @returns {string} e.g. `'2 km'`, `'28 km'`, or `'unknown-resolution'`.
 */
function describeResolution(km) {
  if (!Number.isFinite(km)) return 'unknown-resolution';
  return km < 10 ? `${roundTo(km, 1)} km` : `${Math.round(km)} km`;
}

/**
 * Join distinct non-empty strings for a credit or licence line, or `null` when
 * there are none. Deduplicated because two tiers under the same licence must
 * read "public domain", not "public domain; public domain".
 *
 * @param {Array<?string>} values - Candidate strings.
 * @returns {?string} The joined line, or null.
 */
function joinUnique(values) {
  const kept = [];
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && !kept.includes(value)) kept.push(value);
  }
  return kept.length > 0 ? kept.join('; ') : null;
}
