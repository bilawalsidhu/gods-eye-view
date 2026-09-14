import { flowBucket, flowSpeedScale } from '../../data/trafficFlowStyle.js';
import { presetDotOutline } from '../../data/trafficPresetStyle.js';
import * as Cesium from 'cesium';
import { queuePlatoons, locateAlongRoad } from '../../data/trafficQueue.js';
import {
  SPEED_MPS,
  MAX_DOTS,
  JAM_DOT_FAR_SCALE,
  JAM_DOT_DEPTH_PUNCH,
  CREEP_MOVE_MS,
  CREEP_STOP_MS,
  CREEP_BURST,
  HEAT_JAM_BASE_ALPHA,
  HEAT_JAM_PULSE_ALPHA,
} from './policy.js';

export function createAnimation({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Spawn animated dot primitives along a single road.
   *
   * Each dot is placed at a random position along the road, assigned a
   * randomized speed (base +/-30%), and given a direction (alternating
   * forward/backward to simulate two-way traffic).
   *
   * @param {{waypoints:Cesium.Cartesian3[], segmentDist:number[], type:string, coords:number[][]}} road
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
    const flowColor = bucket ? layerState._activeBucketColors[bucket] : null;
    // Dark-halo outline under styled presets (null = shipped no-outline).
    const outlineSpec =
      bucket && layerState._presetDots === 'on'
        ? presetDotOutline(layerState._stylePreset, bucket)
        : null;
    const outlineColor = outlineSpec
      ? new Cesium.Color(
          outlineSpec.rgba[0] / 255,
          outlineSpec.rgba[1] / 255,
          outlineSpec.rgba[2] / 255,
          outlineSpec.rgba[3],
        )
      : null;
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

    for (let i = 0; i < count; i++) {
      if (layerState._dots.length >= MAX_DOTS) return;

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

      // Compute initial Cartesian3 position via linear interpolation
      Cesium.Cartesian3.lerp(
        road.waypoints[segIdx],
        road.waypoints[segIdx + 1],
        t,
        layerState._scratchLerp,
      );

      // Jam-viz density prototype: jam dots stay visible at city scale — a
      // longer depth-test punch-through (single-sample road heights sit under
      // the mesh at oblique views) and a higher far-scale floor. Sim dots and
      // other buckets keep the shipped values.
      const jamProminent = bucket === 'jam' && parts.style.jamDensityOn();
      const point = layerState._pointCollection.add({
        position: Cesium.Cartesian3.clone(layerState._scratchLerp),
        pixelSize,
        // No flow data → today's exact simulated white.
        color: flowColor || Cesium.Color.WHITE.withAlpha(0.85),
        scaleByDistance: new Cesium.NearFarScalar(
          100,
          1.5,
          layerState._fadeScaleFar,
          jamProminent ? JAM_DOT_FAR_SCALE : 0.3,
        ),
        translucencyByDistance: new Cesium.NearFarScalar(
          100,
          1.0,
          layerState._fadeTransFar,
          0.0,
        ),
        // visible through tiles only when very close (jam: city-scale punch)
        disableDepthTestDistance: jamProminent ? JAM_DOT_DEPTH_PUNCH : 2000,
        // Preset dark halo (spread only when present — the keyless/normal
        // path passes the exact shipped option set).
        ...(outlineSpec
          ? { outlineColor, outlineWidth: outlineSpec.width }
          : {}),
      });
      layerState._bucketCounts[bucket || 'sim'] += 1;

      layerState._dots.push({
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
  }

  /**
   * Per-frame animation callback registered on `scene.preRender`.
   *
   * For every active dot:
   *  1. Skip if currently paused by a simulated stop-light.
   *  2. Convert speed (m/s) to a parametric t-delta relative to the current
   *     segment's Cartesian distance.
   *  3. Advance t in the dot's travel direction, handling segment boundary
   *     crossings and end-of-road reversals.
   *  4. Linearly interpolate between the two bounding waypoints and update the
   *     point primitive's position.
   *
   * Delta time is capped at 100 ms to prevent large jumps after background tabs.
   */

  function animate() {
    const now = Date.now();
    // Delta time in seconds, capped to avoid jumps when returning from background tab
    const dt = layerState._lastAnimTime
      ? Math.min((now - layerState._lastAnimTime) / 1000, 0.1)
      : 0.016;
    layerState._lastAnimTime = now;

    for (let i = 0; i < layerState._dots.length; i++) {
      const dot = layerState._dots[i];

      // Simulated stop-light pause — skip movement while timer is active
      if (now < dot.stoppedUntil) continue;

      // Stop-and-go creep (jam-viz density prototype, live jam dots only):
      // alternate short forward bursts with stops. The burst multiplier keeps
      // the long-run average near the honest TomTom crawl speed.
      let burst = 1;
      if (dot.creep) {
        if (now >= dot.creep.until) {
          dot.creep.moving = !dot.creep.moving;
          const [lo, hi] = dot.creep.moving ? CREEP_MOVE_MS : CREEP_STOP_MS;
          dot.creep.until = now + lo + Math.random() * (hi - lo);
        }
        if (!dot.creep.moving) continue;
        burst = CREEP_BURST;
      }

      // Convert m/s speed to parametric t-delta for the current segment length
      const segLen = dot.segmentDist[dot.segIdx] || 1;
      const tDelta = (dot.mps * burst * dt) / segLen;

      // Advance parametric position along the road in the current direction
      dot.t += tDelta * dot.direction;

      // Handle forward segment boundary crossing (t >= 1.0)
      if (dot.t >= 1.0) {
        dot.t -= 1.0;
        dot.segIdx++;
        if (dot.segIdx >= dot.numSegments) {
          // End of road: recycle to the road's entry with a small stagger —
          // cars don't reverse at the end of a street (field-test round 1).
          // Direction is preserved, so one-way flow stays legal.
          dot.segIdx = 0;
          dot.t = Math.random() * 0.3;
        }
        maybeStopLight(dot, now);
      } else if (dot.t <= 0.0) {
        // Handle backward segment boundary crossing (t <= 0.0)
        dot.t += 1.0;
        dot.segIdx--;
        if (dot.segIdx < 0) {
          // Start of road (traveling backward): recycle to the far end.
          dot.segIdx = dot.numSegments - 1;
          dot.t = 1.0 - Math.random() * 0.3;
        }
        maybeStopLight(dot, now);
      }

      // Lerp between pre-computed Cartesian3 waypoints (no trig needed).
      // Pass the scratch directly: PointPrimitive's position setter clones the
      // value into its own storage (and skips the VBO dirty flag when equal), so
      // the extra defensive clone here allocated 360–720k Cartesian3/s of pure
      // garbage across 6000 dots. (perf item 5)
      const a = dot.waypoints[dot.segIdx];
      const b = dot.waypoints[dot.segIdx + 1];
      Cesium.Cartesian3.lerp(a, b, dot.t, layerState._scratchLerp);
      dot.point.position = layerState._scratchLerp;
    }

    // Jam heat-lines throb (~1.6 s period) — one shared material uniform for
    // the whole jam batch, no geometry rebuild. Null outside live heatline mode.
    if (layerState._heatJamPrim?.appearance) {
      layerState._heatJamPrim.appearance.material.uniforms.color.alpha =
        HEAT_JAM_BASE_ALPHA + HEAT_JAM_PULSE_ALPHA * Math.sin(now / 260);
    }

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
    if (layerState._pointCollection) layerState._pointCollection.removeAll();
    parts.rendering.removeHeatLines();
    layerState._dots = [];
    layerState._roads = [];
    layerState._count = 0;
    layerState._bucketCounts = { free: 0, slow: 0, jam: 0, sim: 0 };
    layerState._closedRoads = 0;
  }
  return { spawnDotsForRoad, animate, maybeStopLight, clearDots };
}
