import * as Cesium from 'cesium';
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
  VIEWPORT_PRIORITY_MARGIN,
  MIN_CENTER_SHIFT_KM,
} from './policy.js';

export function createModel({ state: layerState, services, parts, source }) {
  /** Build scene waypoints from source records; thinning and terrain remain rendering policy. */
  function parseRoads(roadData) {
    if (!roadData || !roadData.roads) {
      return [];
    }

    const roads = [];
    for (const road of roadData.roads) {
      if (!road.coordinates || road.coordinates.length < 2) continue;

      const rawCoords = road.coordinates;

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

      const type = road.type;
      const oneway = road.oneway;

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
   * @const {number} Degrees — floor on the margin ring, using the same flat
   * 111 km per degree this module already assumes. Allocation only re-runs on
   * the load path, and `onCameraChanged` skips that path entirely while the
   * view still overlaps and the center has moved less than
   * MIN_CENTER_SHIFT_KM. A pan shorter than that therefore reveals roads whose
   * budgets were fixed before they were in frame, so the ring must be at least
   * as wide as the move the layer tolerates in silence. The proportional ring
   * alone falls under it below roughly 2 km at a near-nadir pitch — which is
   * where the cap binds hardest.
   */

  const MIN_RING_DEG = (MIN_CENTER_SHIFT_KM * 1000) / 111000;

  /**
   * Flag the roads the camera can reach, for dot-budget priority.
   *
   * The test is each road's bounding box against the view rectangle grown by
   * the margin ring. A box overlaps for some diagonal roads whose geometry
   * does not, which over-includes; that is the safe direction, since the worst
   * case is the demand-only split this replaced.
   *
   * A rectangle without positive spans yields `null` and the caller then
   * allocates exactly as it did before viewport priority existed. The
   * `east > west` half of that test is belt-and-braces rather than load
   * bearing: for the wrapped form Cesium reports across the antimeridian the
   * margin is negative, so the interval is empty and every road already falls
   * outside it — which allocates the same way. It is kept because a later
   * reader normalizing the wrap is likelier to reach for `Math.abs` than to
   * notice that.
   *
   * @param {Array} roads - Parsed road objects, `coords` in degrees.
   * @param {{south:number, west:number, north:number, east:number}|null} viewBounds
   *   Current camera rectangle in degrees, or null when unavailable.
   * @returns {boolean[]|null} Per-road reachability, or null to opt out.
   */

  function roadsWithinView(roads, viewBounds) {
    if (!viewBounds) return null;
    const { south, west, north, east } = viewBounds;
    if (!(north > south) || !(east > west)) return null;
    // A degree of longitude shrinks away from the equator, so the flat
    // conversion above would under-cover the floor there. The floor is a
    // guarantee, so widen it by the rectangle's own latitude.
    const lonFloor =
      MIN_RING_DEG /
      Math.max(0.2, Math.cos((((south + north) / 2) * Math.PI) / 180));
    const latMargin = Math.max(
      (north - south) * VIEWPORT_PRIORITY_MARGIN,
      MIN_RING_DEG,
    );
    const lonMargin = Math.max(
      (east - west) * VIEWPORT_PRIORITY_MARGIN,
      lonFloor,
    );
    const minLat = south - latMargin;
    const maxLat = north + latMargin;
    const minLon = west - lonMargin;
    const maxLon = east + lonMargin;

    return roads.map((road) => {
      const coords = road.coords;
      if (!coords?.length) return false;
      let roadMinLon = Infinity;
      let roadMaxLon = -Infinity;
      let roadMinLat = Infinity;
      let roadMaxLat = -Infinity;
      for (const [lon, lat] of coords) {
        if (lon < roadMinLon) roadMinLon = lon;
        if (lon > roadMaxLon) roadMaxLon = lon;
        if (lat < roadMinLat) roadMinLat = lat;
        if (lat > roadMaxLat) roadMaxLat = lat;
      }
      return (
        roadMaxLon >= minLon &&
        roadMinLon <= maxLon &&
        roadMaxLat >= minLat &&
        roadMinLat <= maxLat
      );
    });
  }

  /**
   * Distribute a fixed dot budget fairly across all visible roads.
   *
   * Algorithm:
   *  1. Compute ideal dot count per road via `computeDotCount`.
   *  2. Seed one dot to every road that wants at least one (fairness pass),
   *     taking roads the camera can reach before the rest.
   *  3. Distribute remaining budget proportionally to each road's ideal count,
   *     filling the roads in frame before any road outside it.
   *  4. Assign leftover dots (from floor rounding) to roads with the highest
   *     fractional residuals (largest-remainder method).
   *
   * This prevents high-density motorways from starving smaller residential roads
   * when the global MAX_DOTS cap is reached. Fairness alone, however, is fair
   * across the FETCHED tile rather than the visible part of it: the tile is
   * centred on the look-at ground point while the frame is the camera
   * rectangle, and at an oblique pitch those two rectangles are offset, so a
   * low shallow-pitch camera over a dense core reaches the cap with much of
   * the budget spent behind or beside the frame. Viewport priority keeps that
   * fairness inside the tier the user is looking at.
   *
   * Without `viewBounds` — no viewer, or a rectangle that cannot be used — the
   * allocation is identical to the demand-only one in every respect.
   *
   * @param {Array} roads    - Parsed road objects.
   * @param {number} altitude - Camera altitude in meters (affects spacing).
   * @param {number} dotCap   - Maximum total dots to allocate.
   * @param {{south:number, west:number, north:number, east:number}|null} [viewBounds=null]
   *   Current camera rectangle in degrees; omit to allocate on demand alone.
   * @returns {number[]} Per-road dot budgets, same length as `roads`.
   */

  function allocateRoadDotBudgets(roads, altitude, dotCap, viewBounds = null) {
    const planned = roads.map((road) => computeDotCount(road, altitude));
    const budgets = new Array(roads.length).fill(0);
    let remaining = Math.max(0, dotCap);
    const withinView = roadsWithinView(roads, viewBounds);

    // Pass 1 — fairness seed: give one dot to every road (highest-demand
    // first), and to the roads in frame before the ones outside it, so a cap
    // exhausted mid-pass starves what is off screen rather than whatever the
    // Overpass response happened to list last.
    const firstPassOrder = planned
      .map((count, index) => ({ count, index }))
      .sort((a, b) =>
        withinView && withinView[a.index] !== withinView[b.index]
          ? withinView[a.index]
            ? -1
            : 1
          : b.count - a.count,
      );

    for (const entry of firstPassOrder) {
      if (remaining <= 0) break;
      if (entry.count <= 0) continue;
      budgets[entry.index] = 1;
      remaining -= 1;
    }

    if (remaining <= 0) return budgets;

    /**
     * Pass 2 and 3 over one tier of roads: proportional distribution of the
     * available budget, then largest-remainder rounding.
     *
     * @param {number[]} indices  - Road indices forming this tier.
     * @param {number} available - Dots this tier may consume.
     * @returns {number} Dots left over for the next tier.
     */
    const distribute = (indices, available) => {
      if (available <= 0) return 0;
      let totalRemainder = 0;
      for (const i of indices) {
        totalRemainder += Math.max(0, planned[i] - budgets[i]);
      }
      if (totalRemainder <= 0) return available;

      const residuals = [];
      let assigned = 0;
      for (const i of indices) {
        const cap = Math.max(0, planned[i] - budgets[i]);
        if (cap <= 0) continue;
        const ideal = (cap / totalRemainder) * available;
        const add = Math.min(cap, Math.floor(ideal));
        budgets[i] += add;
        assigned += add;
        residuals.push({ index: i, residual: ideal - add });
      }

      let leftover = available - assigned;
      if (leftover > 0 && residuals.length > 0) {
        residuals.sort((a, b) => b.residual - a.residual);
        let cursor = 0;
        while (leftover > 0) {
          const idx = residuals[cursor % residuals.length].index;
          if (budgets[idx] < planned[idx]) {
            budgets[idx] += 1;
            leftover -= 1;
          }
          cursor += 1;
          // Safety valve: every road in this tier is already at its ideal
          if (cursor > residuals.length * 3) break;
        }
      }
      return leftover;
    };

    if (withinView) {
      const inFrame = [];
      const outOfFrame = [];
      for (let i = 0; i < roads.length; i++) {
        (withinView[i] ? inFrame : outOfFrame).push(i);
      }
      // Roads in frame reach their ideal count first; only what survives that
      // spills outward, so an off-screen road can no longer take a dot from
      // one the user is looking at.
      remaining = distribute(inFrame, remaining);
      distribute(outOfFrame, remaining);
    } else {
      distribute(
        planned.map((_, index) => index),
        remaining,
      );
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
          ? 'syncing LIVE traffic flow'
          : `LIVE · TomTom flow · ${coveragePct}% cov`,
      };
    }
    // Keyless simulation — one terse line that names the mode and the remedy
    // (owner's copy shape). The chip's own progress text carries "working";
    // this line must never imply a live feed.
    return {
      mode,
      error: null,
      loadingLabel: statusUnavailable
        ? 'SIMULATED — traffic service unreachable'
        : 'SIMULATED — add TomTom key for live',
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
