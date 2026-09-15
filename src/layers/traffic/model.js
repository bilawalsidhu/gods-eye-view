import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  flowDensityMult,
  flowBucket,
  flowSpeedScale,
} from '../../data/trafficFlowStyle.js';
import {
  MAX_WAYPOINTS_PER_ROAD,
  DOT_HEIGHT_OFFSET,
  DENSITY_MULT,
  JAM_DOT_FAR_SCALE,
  JAM_DOT_DEPTH_PUNCH,
} from './policy.js';

export function createModel({ state: layerState, services, parts, source }) {
  // ─── Overpass API ──────────────────────────────────────────

  /**
   * Build an Overpass QL query string to fetch road ways within a bounding box.
   *
   * The query uses a highway tag regex filter. When `majorOnly` is true, only
   * motorway/trunk/primary/secondary are included; otherwise all drivable road
   * classes are fetched. The `out geom qt;` suffix returns inline geometry
   * (lat/lon per node) sorted by quadtile for faster server response.
   *
   * @param {number} south - Southern latitude bound (degrees).
   * @param {number} west  - Western longitude bound (degrees).
   * @param {number} north - Northern latitude bound (degrees).
   * @param {number} east  - Eastern longitude bound (degrees).
   * @param {Object}  [opts]
   * @param {boolean} [opts.majorOnly=false] - Restrict to major highway classes only.
   * @param {number}  [opts.timeoutSec=25]   - Overpass server-side timeout.
   * @returns {string} Overpass QL query body.
   */

  /**
   * Parse an Overpass `out geom;` JSON response into internal road objects.
   *
   * Each OSM `way` element carries an inline `geometry` array of `{lat, lon}`
   * objects, so no separate node look-up or osmtogeojson conversion is needed.
   *
   * Processing per way:
   *  1. Extract [lon, lat] coordinate pairs.
   *  2. Sub-sample long polylines to at most MAX_WAYPOINTS_PER_ROAD vertices.
   *  3. Sample terrain height once at the first vertex (avoids per-vertex cost).
   *  4. Convert to Cartesian3 waypoints and pre-compute inter-vertex distances.
   *
   * @param {Object} overpassData - Raw JSON response from the Overpass API.
   * @param {Array}  overpassData.elements - Array of OSM elements.
   * @returns {Array<{coords:number[][], type:string, waypoints:Cesium.Cartesian3[], segmentDist:number[]}>}
   *   Parsed road objects ready for dot spawning.
   */

  function parseRoads(overpassData) {
    if (!overpassData || !overpassData.elements) return [];

    const roads = [];
    for (const el of overpassData.elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;

      const rawCoords = el.geometry.map((g) => [g.lon, g.lat]);

      // Sub-sample long polylines: keep every Nth vertex to stay within budget
      const simplifyStep =
        rawCoords.length > MAX_WAYPOINTS_PER_ROAD
          ? Math.ceil(rawCoords.length / MAX_WAYPOINTS_PER_ROAD)
          : 1;
      const coords = [];
      for (let i = 0; i < rawCoords.length; i += simplifyStep) {
        coords.push(rawCoords[i]);
      }

      // Ensure the original endpoint is always preserved
      const last = rawCoords[rawCoords.length - 1];
      const tail = coords[coords.length - 1];
      if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) {
        coords.push(last);
      }

      if (coords.length < 2) continue;

      const type = el.tags?.highway || 'unclassified';
      // One-way capture (field-test round 1: "a car would never go in
      // reverse"): dots on one-way roads all travel the legal direction.
      // OSM: oneway=yes/1/true → digitization order; '-1' → reversed;
      // roundabouts are one-way by definition. 0 = two-way (alternate).
      const onewayTag = el.tags?.oneway;
      const oneway =
        onewayTag === 'yes' ||
        onewayTag === '1' ||
        onewayTag === 'true' ||
        el.tags?.junction === 'roundabout'
          ? 1
          : onewayTag === '-1'
            ? -1
            : 0;

      // Sample terrain height once at the road start to avoid per-vertex cost
      let baseHeight = 0;
      const firstCoord = coords[0];
      if (layerState._viewer?.scene?.sampleHeightSupported && firstCoord) {
        const carto = Cesium.Cartographic.fromDegrees(
          firstCoord[0],
          firstCoord[1],
        );
        const sampled = layerState._viewer.scene.sampleHeight(carto);
        if (Number.isFinite(sampled)) baseHeight = sampled;
      }

      // Pre-compute Cartesian3 waypoints (lon, lat, height) for fast lerp animation
      const waypoints = coords.map(([lng, lat]) => {
        const h = baseHeight + DOT_HEIGHT_OFFSET;
        return Cesium.Cartesian3.fromDegrees(lng, lat, h);
      });

      // Pre-compute segment distances in meters for speed-to-t conversion
      const segmentDist = [];
      for (let i = 0; i < waypoints.length - 1; i++) {
        segmentDist.push(
          Cesium.Cartesian3.distance(waypoints[i], waypoints[i + 1]),
        );
      }

      roads.push({ coords, type, oneway, waypoints, segmentDist });
    }

    return roads;
  }

  // ─── Road Length Estimation ────────────────────────────────

  /**
   * Estimate the total length of a road in meters from its degree-based coordinates.
   *
   * Uses Euclidean distance in degree-space then multiplies by the equatorial
   * approximation of 111 km per degree. Accurate enough for dot density spacing
   * but not for navigation.
   *
   * @param {number[][]} coords - Array of [lon, lat] pairs.
   * @returns {number} Approximate road length in meters.
   */

  function estimateRoadLengthDeg(coords) {
    let len = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const dx = coords[i + 1][0] - coords[i][0];
      const dy = coords[i + 1][1] - coords[i][1];
      len += Math.sqrt(dx * dx + dy * dy);
    }
    // Rough conversion: 1 degree ~ 111,000 meters at equator
    return len * 111000;
  }

  // ─── Dot Spawning ──────────────────────────────────────────

  /**
   * Compute the ideal number of dots for a single road at a given camera altitude.
   *
   * Spacing increases with altitude so fewer dots are rendered when zoomed out.
   * The result is further scaled by the road-type density multiplier and the
   * user-adjustable `_densityScale`.
   *
   * @param {{coords:number[][], type:string}} road - Parsed road object.
   * @param {number} altitude - Current camera altitude in meters.
   * @returns {number} Ideal dot count (minimum 1).
   */

  function computeDotCount(road, altitude) {
    // Live flow: closed roads carry zero traffic; congestion packs more dots.
    // `road.flow` is only ever set in live mode, so the keyless path is
    // untouched (flow stays undefined → multiplier 1, identical output).
    const flow = layerState._liveMode ? road.flow : null;
    if (flow?.closure) return 0;
    // Strict data-integrity view: uncovered roads spawn nothing when hidden.
    if (layerState._liveMode && !flow && layerState._uncoveredMode === 'hide')
      return 0;

    const lengthM = estimateRoadLengthDeg(road.coords);

    // Altitude-adaptive spacing: closer camera = denser dots
    let spacing;
    if (altitude < 1000) spacing = 30;
    else if (altitude < 3000) spacing = 80;
    else if (altitude < 5000) spacing = 150;
    else spacing = 250;

    const mult =
      (DENSITY_MULT[road.type] || 1) *
      layerState._densityScale *
      (flow
        ? flowDensityMult(flow.level, { jamBoost: parts.style.jamDensityOn() })
        : 1);
    return Math.max(1, Math.floor((lengthM / spacing) * mult));
  }

  /**
   * Distribute a fixed dot budget fairly across all visible roads.
   *
   * Algorithm:
   *  1. Compute ideal dot count per road via `computeDotCount`.
   *  2. Seed one dot to every road that wants at least one (fairness pass).
   *  3. Distribute remaining budget proportionally to each road's ideal count.
   *  4. Assign leftover dots (from floor rounding) to roads with the highest
   *     fractional residuals (largest-remainder method).
   *
   * This prevents high-density motorways from starving smaller residential roads
   * when the global MAX_DOTS cap is reached.
   *
   * @param {Array} roads    - Parsed road objects.
   * @param {number} altitude - Camera altitude in meters (affects spacing).
   * @param {number} dotCap   - Maximum total dots to allocate.
   * @returns {number[]} Per-road dot budgets, same length as `roads`.
   */

  function allocateRoadDotBudgets(roads, altitude, dotCap) {
    const planned = roads.map((road) => computeDotCount(road, altitude));
    const budgets = new Array(roads.length).fill(0);
    let remaining = Math.max(0, dotCap);

    // Pass 1 — fairness seed: give one dot to every road (highest-demand first)
    const firstPassOrder = planned
      .map((count, index) => ({ count, index }))
      .sort((a, b) => b.count - a.count);

    for (const entry of firstPassOrder) {
      if (remaining <= 0) break;
      if (entry.count <= 0) continue;
      budgets[entry.index] = 1;
      remaining -= 1;
    }

    if (remaining <= 0) return budgets;

    // Pass 2 — proportional distribution of the remaining budget
    let totalRemainder = 0;
    for (let i = 0; i < planned.length; i++) {
      totalRemainder += Math.max(0, planned[i] - budgets[i]);
    }
    if (totalRemainder <= 0) return budgets;

    const residuals = [];
    let assigned = 0;
    for (let i = 0; i < planned.length; i++) {
      const cap = Math.max(0, planned[i] - budgets[i]);
      if (cap <= 0) continue;
      const ideal = (cap / totalRemainder) * remaining;
      const add = Math.min(cap, Math.floor(ideal));
      budgets[i] += add;
      assigned += add;
      residuals.push({ index: i, residual: ideal - add });
    }

    // Pass 3 — largest-remainder: hand out leftover dots from floor rounding
    let leftover = remaining - assigned;
    if (leftover > 0 && residuals.length > 0) {
      residuals.sort((a, b) => b.residual - a.residual);
      let cursor = 0;
      while (leftover > 0 && residuals.length > 0) {
        const idx = residuals[cursor % residuals.length].index;
        if (budgets[idx] < planned[idx]) {
          budgets[idx] += 1;
          leftover -= 1;
        }
        cursor += 1;
        // Safety valve: avoid infinite loop if all roads are already at their ideal
        if (cursor > residuals.length * 3 && leftover > 0) break;
      }
    }

    return budgets;
  }

  /**
   * Derive the layer's honest feed presentation from its live-flow state.
   *
   * The three states a user can be in, and what each must read as:
   *  - keyless → `mode:'sim'` (the manager maps that to a FALLBACK chip) with a
   *    label that never claims live data;
   *  - live and healthy → LIVE with real coverage;
   *  - live but flow-down → an `error` string, so the chip degrades and says
   *    the colors on screen are simulated. Never a stale "LIVE · N% cov".
   *
   * @param {Object} [input]
   * @param {boolean} [input.liveMode] - `/api/tomtom/status` reported a key.
   * @param {boolean} [input.fetching] - A viewport load is in flight.
   * @param {string|null} [input.flowError] - `deriveTrafficFlowError` result, if any.
   * @param {number} [input.coveragePct] - Matched-road coverage, 0–100.
   * @param {boolean} [input.statusUnavailable] - The status probe itself failed.
   * @returns {{mode:'live'|'sim', error:string|null, loadingLabel:string}}
   */

  function trafficFeedPresentation({
    liveMode = false,
    fetching = false,
    flowError = null,
    coveragePct = 0,
    statusUnavailable = false,
  } = {}) {
    // `mode` is the CONFIGURED source (live key present vs keyless), not this
    // instant's health — health rides on `error`. The qa-traffic harness pins
    // that meaning.
    const mode = liveMode ? 'live' : 'sim';
    if (liveMode && flowError) {
      // One string for both fields. The manager's meta line renders `error` and
      // drops `loadingLabel` in its error branch, so the owner's SIMULATED copy
      // has to BE the error text or the steady state reverts to a bare
      // "TomTom daily budget reached" that never says what is on screen.
      const degraded = `SIMULATED — ${flowError}`;
      return { mode, error: degraded, loadingLabel: degraded };
    }
    if (liveMode) {
      return {
        mode,
        error: null,
        loadingLabel: fetching
          ? t('layers.traffic.loadingSyncing')
          : t('layers.traffic.liveCoverage', { percent: coveragePct }),
      };
    }
    // Keyless simulation — one terse line that names the mode and the remedy
    // (owner's copy shape). The chip's own progress text carries "working";
    // this line must never imply a live feed.
    return {
      mode,
      error: null,
      loadingLabel: statusUnavailable
        ? t('layers.traffic.simUnavailable')
        : t('layers.traffic.simKeyless'),
    };
  }

  /**
   * Apply late-arriving flow data to already-rendered dots without a respawn:
   * color, jam size, and speed update in place; closed roads' dots hide.
   * Density bunching intentionally waits for the next natural re-render —
   * color and speed are the live signal, dot count is a refinement.
   * @param {string} label - Render log label (for the console trace).
   */

  function recolorDotsInPlace(label) {
    if (!layerState._liveMode || !layerState._dots.length) return;
    layerState._bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
    let closedDots = 0;
    const now = Date.now();
    for (const dot of layerState._dots) {
      const flow = dot.road ? dot.road.flow : null;
      if (flow?.closure) {
        dot.point.show = false;
        closedDots += 1;
        continue;
      }
      const bucket = flow ? flowBucket(flow.level) : null;
      dot.bucket = bucket;
      dot.point.color = bucket
        ? layerState._activeBucketColors[bucket]
        : Cesium.Color.WHITE.withAlpha(0.85);
      if (bucket === 'jam') {
        dot.point.pixelSize =
          parts.style.baseDotSize(dot.road?.type, bucket) +
          1 +
          parts.style.activeSizeDelta('jam');
      } else if (bucket && parts.style.presetProfileActive()) {
        // Preset profiles size-floor every bucket; the shipped normal path
        // keeps its jam-only size touch (byte-identical behavior).
        dot.point.pixelSize =
          parts.style.baseDotSize(dot.road?.type, bucket) +
          parts.style.activeSizeDelta(bucket);
      }
      // Late flow can move a dot between buckets — keep the preset halo in
      // step (no-op writes under the normal profile, whose dots have none).
      if (parts.style.presetProfileActive())
        parts.style.applyOutline(dot.point, bucket);
      dot.mps = dot.baseMps * (flow ? flowSpeedScale(flow.level) : 1);
      // Late flow tags/untags stop-and-go creep + city-scale prominence the
      // same way it rescales speed. Queue *positions* wait for the next
      // natural re-render, like density bunching.
      if (bucket === 'jam' && parts.style.jamDensityOn()) {
        if (!dot.creep)
          dot.creep = {
            moving: Math.random() < 0.4,
            until: now + Math.random() * 2000,
          };
        dot.point.scaleByDistance = new Cesium.NearFarScalar(
          100,
          1.5,
          layerState._fadeScaleFar,
          JAM_DOT_FAR_SCALE,
        );
        dot.point.disableDepthTestDistance = JAM_DOT_DEPTH_PUNCH;
      } else {
        dot.creep = null;
      }
      layerState._bucketCounts[bucket || 'sim'] += 1;
    }
    layerState._closedRoads = layerState._roads.reduce(
      (n, r) => n + (r.flow?.closure ? 1 : 0),
      0,
    );
    parts.rendering.rebuildHeatLines(
      parts.rendering.visibleRoadsForAltitude(
        layerState._roads,
        layerState._lastRenderAltitude,
      ),
    );
    console.log(
      `[Data:Traffic] Flow recolor (${label}): ${layerState._dots.length} dots, closedDots=${closedDots}`,
    );
  }
  return {
    parseRoads,
    estimateRoadLengthDeg,
    computeDotCount,
    allocateRoadDotBudgets,
    trafficFeedPresentation,
    recolorDotsInPlace,
  };
}
