import { DOT_FADE_MS } from './retention.js';
import { flowBucket, flowSpeedScale } from '../../data/trafficFlowStyle.js';
import { lerpInto } from '../../geo/vector.js';
import { findFrame } from '../../render/rendererOf.js';
import { queuePlatoons, locateAlongRoad } from '../../data/trafficQueue.js';
import {
  SPEED_MPS,
  MAX_DOTS,
  JAM_DOT_FAR_SCALE,
  CREEP_MOVE_MS,
  CREEP_STOP_MS,
  CREEP_BURST,
} from './policy.js';

export function createAnimation({
  state: layerState,
  services,
  parts,
  source,
}) {
  /** The dots' point items, gathered once a frame for one upsert. */
  const frameItems = [];

  /**
   * Send every dot's point item to the draw set: the set moves and
   * restyles the points it has, and adds the new ones, in place.
   */
  function flushDots() {
    const dots = layerState._dots;
    frameItems.length = dots.length;
    for (let i = 0; i < dots.length; i++) frameItems[i] = dots[i].point;
    layerState._dotSet?.upsert(frameItems);
  }

  function syncRenderDemand() {
    const needed = Boolean(
      layerState._enabled &&
      (layerState._dots.length || parts.rendering.heatPulsing?.()),
    );
    // Height easing only runs in a held frame. Settle it before releasing, so
    // a population emptied mid-correction cannot report loading forever.
    if (!needed && layerState._heightPending) parts.retention.finishHeights();
    if (needed === Boolean(layerState._renderHeld)) return;
    layerState._renderHeld = needed;
    if (needed) {
      layerState._lastAnimTime = 0;
      services.render.holdContinuousRender('traffic');
      findFrame(layerState._viewer)?.requestRender('traffic');
    } else services.render.releaseContinuousRender('traffic');
  }

  /**
   * Spawn animated dot primitives along a single road.
   *
   * Each dot is placed at a random position along the road, assigned a
   * randomized speed (base +/-30%), and given a direction (alternating
   * forward/backward to simulate two-way traffic).
   *
   * @param {{waypoints:Array<{x:number, y:number, z:number}>, segmentDist:number[], type:string, coords:number[][]}} road
   *   Parsed road object with pre-computed waypoints.
   * @param {number} altitude      - Camera altitude (used if budgetCount is null).
   * @param {number|null} [budgetCount=null] - Pre-allocated dot count. Falls back
   *   to `computeDotCount` when null.
   */

  function spawnDotsForRoad(road, altitude, budgetCount = null) {
    // Live flow styling (`road.flow` only exists in live mode; keyless path is
    // byte-identical): closures spawn nothing, congestion colors/slows dots.
    const flow = layerState._liveMode ? road.flow : null;
    if (flow?.closure) return;
    if (layerState._liveMode && !flow && layerState._uncoveredMode === 'hide')
      return;

    const count = Number.isFinite(budgetCount)
      ? Math.max(0, Math.floor(budgetCount))
      : parts.model.computeDotCount(road, altitude);
    const numSegments = road.waypoints.length - 1;
    if (numSegments < 1 || count <= 0) return;

    const baseMps = SPEED_MPS[road.type] || 5;
    const bucket = flow ? flowBucket(flow.level) : null;
    // Jam dots get +1px: a red queue should read as a queue at a glance.
    // Preset-aware styling adds its own size delta and floors the base (0 /
    // no floor under the normal profile) so NVG/FLIR/CRT dots stay PRESENT.
    const pixelSize =
      parts.style.baseDotSize(road.type, bucket) +
      (bucket === 'jam' ? 1 : 0) +
      parts.style.activeSizeDelta(bucket);
    // Dark-halo outline under styled presets (null = shipped no-outline).
    const outline = bucket ? parts.style.outlineOf(bucket) : null;
    const flowSpeed = flow ? flowSpeedScale(flow.level) : 1;
    const now = Date.now();

    // Jam-viz density prototype: jam-road dots spawn as bumper-to-bumper
    // platoons (one shared direction per queue) instead of uniform scatter.
    // Unreachable in sim mode — `bucket` requires flow.
    let placements = null;
    if (bucket === 'jam' && parts.style.jamDensityOn()) {
      let totalLen = 0;
      for (const d of road.segmentDist) totalLen += d;
      const platoons = queuePlatoons(totalLen, count);
      if (platoons.length) {
        placements = [];
        for (let p = 0; p < platoons.length; p++) {
          const dir = road.oneway ? road.oneway : p % 2 === 0 ? 1 : -1;
          for (const s of platoons[p]) {
            const { segIdx, t } = locateAlongRoad(road.segmentDist, s);
            placements.push({ segIdx, t, direction: dir });
          }
        }
      }
    }

    const spawned = [];
    for (let i = 0; i < count; i++) {
      if (layerState._dots.length >= MAX_DOTS) break;

      // Random start position: pick a random segment and offset within it —
      // unless this is a queued jam dot with a platoon placement.
      const segIdx = placements
        ? placements[i].segIdx
        : Math.floor(Math.random() * numSegments);
      const t = placements ? placements[i].t : Math.random();

      // Speed noise: base speed +/-30% for organic variation. baseMps (noise
      // included, flow excluded) is kept on the dot so a late-arriving flow
      // match can rescale speed in place (recolorDotsInPlace).
      const noisedMps =
        baseMps * layerState._speedScale * (0.7 + Math.random() * 0.6);
      const mps = noisedMps * flowSpeed;

      // One-way roads flow only their legal direction; two-way alternates
      // (per platoon in queue mode — a queue moves as one).
      const direction = placements
        ? placements[i].direction
        : road.oneway
          ? road.oneway
          : i % 2 === 0
            ? 1
            : -1;

      // Grounded traffic respects building/terrain occlusion. The former
      // depth override made distant roads look like vehicles crossing roofs.
      const jamProminent = bucket === 'jam' && parts.style.jamDensityOn();
      const id = layerState._nextDotId++;
      // The dot's point item, kept and changed in place: its draw id stays
      // while the dot's vehicle identity (`id`) is renewed at each recycle.
      const point = {
        id: `dot:${id}`,
        // Its initial position, by linear interpolation.
        pos: lerpInto(road.waypoints[segIdx], road.waypoints[segIdx + 1], t, {
          x: 0,
          y: 0,
          z: 0,
        }),
        pixelSize,
        // No flow data → today's exact simulated white.
        color: parts.style.dotColor(bucket),
        // Frozen, as the colours are: the draw port then tells them
        // unchanged by identity when the dots move each frame.
        scaleByDistance: Object.freeze({
          near: 100,
          nearValue: 1.5,
          far: layerState._fadeScaleFar,
          farValue: jamProminent ? JAM_DOT_FAR_SCALE : 0.3,
        }),
        fadeByDistance: Object.freeze({
          near: 100,
          nearValue: 1.0,
          far: layerState._fadeTransFar,
          farValue: 0.0,
        }),
        // Respect the sampled mesh at every viewing distance.
        disableDepthTest: 0,
        // Preset dark halo (only when present — the keyless/normal path
        // passes the shipped look).
        ...outline,
      };
      spawned.push(point);
      layerState._bucketCounts[bucket || 'sim'] += 1;

      layerState._motion.added++;
      layerState._dots.push({
        id,
        index: layerState._dots.length,
        born: now,
        retiring: 0,
        nominalSize: pixelSize,
        recycle: false,
        point,
        road,
        bucket, // flow bucket at spawn (null = sim) — drives preset restyle/pulse
        waypoints: road.waypoints,
        segmentDist: road.segmentDist,
        numSegments,
        segIdx,
        t,
        mps, // meters per second (flow-scaled)
        baseMps: noisedMps, // pre-flow speed, for in-place flow rescale
        direction,
        stoppedUntil: 0,
        // Stop-and-go creep state (jam-viz density prototype): jam dots
        // alternate move-bursts and stops. Null in sim mode and for non-jam.
        creep:
          bucket === 'jam' && parts.style.jamDensityOn()
            ? { moving: Math.random() < 0.4, until: now + Math.random() * 2000 }
            : null,
      });
    }
    // Drawn at once, as they join; each frame moves them on.
    if (spawned.length) layerState._dotSet?.upsert(spawned);
    syncRenderDemand();
  }

  /**
   * Per-frame animation callback registered on `scene.preRender`.
   *
   * For every active dot:
   *  1. Ease heights and fade arrivals/departures, including paused dots.
   *  2. Convert speed (m/s) to a parametric t-delta relative to the current
   *     segment's Cartesian distance.
   *  3. Advance t in the dot's travel direction, handling segment boundary
   *     crossings and faded end-of-road departures.
   *  4. Linearly interpolate between the two bounding waypoints and update the
   *     point primitive's position.
   *
   * Delta time is capped at 100 ms to prevent large jumps after background tabs.
   */

  function animate() {
    syncRenderDemand();
    if (!layerState._renderHeld) return;
    const now = Date.now();
    // Delta time in seconds, capped to avoid jumps when returning from background tab
    const dt = layerState._lastAnimTime
      ? Math.min((now - layerState._lastAnimTime) / 1000, 0.1)
      : 0.016;
    layerState._lastAnimTime = now;

    parts.retention.easeHeights(dt);
    for (let i = 0; i < layerState._dots.length; i++) {
      const dot = layerState._dots[i];
      if (dot.recycle) {
        // A road-end departure is a new simulated vehicle at the entry, never
        // a teleport attributed to the departed vehicle's stable identity.
        dot.id = layerState._nextDotId++;
        dot.segIdx = dot.direction > 0 ? 0 : dot.numSegments - 1;
        dot.t = dot.direction > 0 ? 0 : 1;
        dot.born = now;
        dot.recycle = false;
        layerState._motion.recycled++;
      }
      const remaining =
        dot.direction > 0
          ? dot.segIdx === dot.numSegments - 1
            ? (1 - dot.t) * dot.segmentDist[dot.segIdx]
            : Infinity
          : dot.segIdx === 0
            ? dot.t * dot.segmentDist[0]
            : Infinity;
      const endpointFade = Math.min(1, remaining / Math.max(1, dot.mps * 0.25));
      dot.point.pixelSize =
        dot.nominalSize *
        Math.max(
          0,
          Math.min(
            1,
            (now - dot.born) / DOT_FADE_MS,
            dot.retiring ? 1 - (now - dot.retiring) / DOT_FADE_MS : 1,
            endpointFade,
          ),
        );

      // Stop-and-go creep (jam-viz density prototype, live jam dots only):
      // alternate short forward bursts with stops. The burst multiplier keeps
      // the long-run average near the honest TomTom crawl speed.
      let burst = now < dot.stoppedUntil ? 0 : 1;
      if (dot.creep) {
        if (now >= dot.creep.until) {
          dot.creep.moving = !dot.creep.moving;
          const [lo, hi] = dot.creep.moving ? CREEP_MOVE_MS : CREEP_STOP_MS;
          dot.creep.until = now + lo + Math.random() * (hi - lo);
        }
        if (!dot.creep.moving) burst = 0;
        else burst *= CREEP_BURST;
      }

      // Carry metres across bends, not a t fraction from a differently sized
      // segment. Short segments cannot turn a slow car into a large jump.
      let travel = dot.mps * burst * dt;
      while (travel > 0) {
        const length = Math.max(0.001, dot.segmentDist[dot.segIdx]);
        const available = (dot.direction > 0 ? 1 - dot.t : dot.t) * length;
        if (travel < available) {
          dot.t += (travel / length) * dot.direction;
          break;
        }
        travel -= available;
        const next = dot.segIdx + dot.direction;
        if (next < 0 || next >= dot.numSegments) {
          dot.t = dot.direction > 0 ? 1 : 0;
          dot.point.pixelSize = 0;
          dot.recycle = true;
          break;
        }
        dot.segIdx = next;
        dot.t = dot.direction > 0 ? 0 : 1;
        maybeStopLight(dot, now);
        if (now < dot.stoppedUntil) break;
      }

      // Lerp between pre-computed ECEF waypoints (no trig needed), into the
      // point item's own position: the draw set copies it.
      const a = dot.waypoints[dot.segIdx];
      const b = dot.waypoints[dot.segIdx + 1];
      lerpInto(a, b, dot.t, dot.point.pos);
    }
    flushDots();

    // Jam heat-lines throb (~1.6 s period); none outside live heatline mode.
    parts.rendering.pulseHeatLines?.(now);

    layerState._animFrame++;
  }

  /**
   * Randomly pause a dot near road endpoints to simulate stop-light behaviour.
   *
   * Only triggers within the first 2 or last 2 segments of the road, and only
   * with a very low per-frame probability (0.8%) to keep traffic flowing.
   *
   * @param {Object} dot - The dot state object.
   * @param {number} now - Current timestamp in milliseconds.
   */

  function maybeStopLight(dot, now) {
    const nearEnd = dot.segIdx <= 1 || dot.segIdx >= dot.numSegments - 2;
    if (nearEnd && Math.random() < 0.008) {
      // Pause for 2–6 seconds
      dot.stoppedUntil = now + 2000 + Math.random() * 4000;
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────

  /** Remove all point primitives and reset dot/road arrays and counters. */

  function clearDots() {
    services.credits?.hideOsmCredit?.(layerState._viewer, 'traffic');
    parts.retention.clear();
    if (layerState._dots.length) layerState._motion.rebuilds++;
    layerState._dotSet?.clear();
    parts.rendering.removeHeatLines();
    layerState._dots = [];
    layerState._roads = [];
    layerState._count = 0;
    layerState._bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
    layerState._closedRoads = 0;
    syncRenderDemand();
  }
  return {
    spawnDotsForRoad,
    animate,
    maybeStopLight,
    clearDots,
    syncRenderDemand,
    flushDots,
  };
}
