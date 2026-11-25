import { flowBucket } from '../../data/trafficFlowStyle.js';
import { trafficStyleProfile } from '../../data/trafficPresetStyle.js';
import {
  FLOW_BUCKET_COLORS,
  FLOW_LINE_ALPHA,
  FLOW_LINE_CAP,
  FLOW_LINE_WIDTH,
  HEAT_LINE_CAP,
  HEAT_JAM_COLOR,
  HEAT_SLOW_COLOR,
  HEAT_LINE_JAM_WIDTH,
  HEAT_JAM_BASE_ALPHA,
  HEAT_JAM_PULSE_ALPHA,
  HEAT_LINE_SLOW_WIDTH,
  TRAFFIC_TIMING_ENABLED,
} from './policy.js';
import { distance } from '../../geo/vector.js';
import { findCamera } from '../../render/rendererOf.js';

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * At high altitude only major roads render — shared by the render pass and
   * the late-flow heat-line rebuild so lines never mark roads without dots.
   * @param {Array} roads    - Parsed road objects.
   * @param {number} altitude - Camera altitude in meters.
   * @returns {Array} The roads visible at this altitude.
   */

  function visibleRoadsForAltitude(roads, altitude) {
    return altitude > 5000
      ? roads.filter(
          (r) =>
            r.type === 'motorway' || r.type === 'trunk' || r.type === 'primary',
        )
      : roads;
  }

  /** Take every road line (heat-lines or flow lines) down. */

  function removeHeatLines() {
    if (layerState._heatLineCount) {
      layerState._heatSet?.clear();
      layerState._heatOverSet?.clear();
    }
    layerState._heatJam = [];
    layerState._heatLineCount = 0;
    parts.animation.syncRenderDemand?.();
  }

  /**
   * Rebuild the road-line underlay drawn from live flow, in one of two looks,
   * as lines of the layer's heat-line draw set:
   *
   * - Flow lines (the `lines` row toggle): every road with flow drapes a
   *   steady line in its bucket color — green free-flow, amber slow, red
   *   jam — on the terrain and the 3D tiles alike. Capped at FLOW_LINE_CAP.
   * - Heat-lines (jam-viz `heatline` prototype): only slow/jam roads, draped
   *   on the 3D tiles: a glowing red for jam, pulsing together
   *   (`pulseHeatLines`), and a faint flat amber for slow. Capped at
   *   HEAT_LINE_CAP.
   *
   * Kept roads are jam first, then slow, then free, longest first; overflow
   * is logged. The set swaps its whole contents at once, so a rebuild never
   * blinks. No-op in sim mode or when both looks are off. Where the renderer
   * cannot drape, it draws them over the surface instead (the draw port's
   * `overlay`).
   *
   * One build runs at a time. A city loads in progressive paints, each asking
   * for a rebuild, and every build drapes up to the cap of polylines
   * asynchronously. A rebuild asked for while lines are building only replaces
   * the one waiting, which retireHeatLines starts when the build finishes, so
   * the scene never holds more than the lines drawn and the lines building.
   * Turning the lines off is never deferred.
   *
   * @param {Array} roads - Road objects visible in the current render.
   */

  function rebuildHeatLines(roads) {
    if (
      !layerState._viewer ||
      !layerState._heatSet ||
      !layerState._liveMode ||
      !parts.style.heatlineOn()
    ) {
      removeHeatLines();
      return;
    }
    const flowLines = layerState._showLines;
    const cap = flowLines ? FLOW_LINE_CAP : HEAT_LINE_CAP;
    const rank = { jam: 0, slow: 1, free: 2 };
    const candidates = [];
    for (const road of roads) {
      const flow = road.flow;
      if (!flow || flow.closure) continue;
      const bucket = flowBucket(flow.level);
      if (bucket === 'free' && !flowLines) continue;
      let len = 0;
      for (const d of road.segmentDist) len += d;
      candidates.push({ road, bucket, len });
    }
    candidates.sort((a, b) =>
      a.bucket === b.bucket ? b.len - a.len : rank[a.bucket] - rank[b.bucket],
    );
    const kept = candidates.slice(0, cap);

    // Mono presets (NVG/FLIR/noir) discard hue — lines re-encode in
    // luminance like the dots: jam = white, slow = gray, free = dim gray.
    const mono =
      layerState._presetDots === 'on' &&
      trafficStyleProfile(layerState._stylePreset) === 'mono';
    const gray = (level, alpha) => [level, level, level, alpha];
    let styleFor;
    let widthFor;
    if (flowLines) {
      // Lines take the dots' active (preset-aware) colors, steady.
      const dotColor = (bucket) =>
        layerState._activeBucketColors?.[bucket] || FLOW_BUCKET_COLORS[bucket];
      const level = { jam: 1, slow: 0.7, free: 0.45 };
      const styles = {};
      for (const bucket of ['jam', 'slow', 'free']) {
        const rgb = mono
          ? gray(level[bucket], 1)
          : dotColor(bucket).slice(0, 3);
        styles[bucket] = {
          kind: 'solid',
          color: [rgb[0], rgb[1], rgb[2], FLOW_LINE_ALPHA],
        };
      }
      styleFor = (bucket) => styles[bucket];
      widthFor = () => FLOW_LINE_WIDTH;
    } else {
      layerState._heatJamRgb = mono ? [1, 1, 1] : HEAT_JAM_COLOR.slice(0, 3);
      const jamStyle = jamLineStyle(HEAT_JAM_BASE_ALPHA);
      const slowStyle = {
        kind: 'solid',
        color: mono ? gray(0.7, HEAT_SLOW_COLOR[3]) : HEAT_SLOW_COLOR,
      };
      styleFor = (bucket) => (bucket === 'jam' ? jamStyle : slowStyle);
      widthFor = (bucket) =>
        bucket === 'jam' ? HEAT_LINE_JAM_WIDTH : HEAT_LINE_SLOW_WIDTH;
    }

    // Drawn in the order the per-bucket primitives were added: flow lines
    // free, slow, then jam on top, in one set (in the order of its items);
    // heat-lines jam, then slow over it, in a set of their own made after
    // the jam lines' (a set draws its glow lines after its solid ones).
    const order = flowLines ? ['free', 'slow', 'jam'] : ['jam', 'slow'];
    const byBucket = { jam: [], slow: [], free: [] };
    const over = [];
    const jam = [];
    for (let i = 0; i < kept.length; i++) {
      const { road, bucket } = kept[i];
      const item = {
        id: `heat:${i}`,
        // A snapshot of the waypoints, as the renderer's points.
        positions: road.waypoints.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        widthPx: widthFor(bucket),
        mode: 'draped',
        // Flow lines drape on terrain or tiles; heat-lines on the tiles.
        clampTo: flowLines ? 'both' : 'tiles',
        style: styleFor(bucket),
      };
      if (bucket === 'slow' && !flowLines && layerState._heatOverSet)
        over.push(item);
      else byBucket[bucket].push(item);
      // The steady flow lines never pulse.
      if (bucket === 'jam' && !flowLines) jam.push(item);
    }
    const items = order.flatMap((bucket) => byBucket[bucket]);
    if (items.length || layerState._heatLineCount)
      layerState._heatSet.set(items);
    if (over.length || layerState._heatOverSet?.size())
      layerState._heatOverSet.set(over);
    layerState._heatJam = jam;

    layerState._heatLineCount = kept.length;
    parts.animation.syncRenderDemand?.();
    if (candidates.length > kept.length) {
      console.log(
        `[Data:Traffic] ${flowLines ? 'Flow lines' : 'Heat-lines'} capped at ${cap} (${candidates.length} roads in view)`,
      );
    }
  }

  /** The jam heat-lines' glow at `alpha`. */
  const jamLineStyle = (alpha) => ({
    kind: 'glow',
    color: [...layerState._heatJamRgb, alpha],
    power: 0.25,
  });

  /** Whether jam heat-lines are drawn, which pulse every frame. */
  const heatPulsing = () => Boolean(layerState._heatJam?.length);

  /**
   * Throb the jam heat-lines (~1.6 s period): one colour for them all,
   * each line recoloured where it is, no geometry rebuilt.
   * @param {number} now - Epoch ms.
   */
  function pulseHeatLines(now) {
    const jam = layerState._heatJam;
    if (!jam?.length || !layerState._heatSet) return;
    const style = jamLineStyle(
      HEAT_JAM_BASE_ALPHA + HEAT_JAM_PULSE_ALPHA * Math.sin(now / 260),
    );
    for (const item of jam) item.style = style;
    layerState._heatSet.upsert(jam);
  }

  /**
   * Reconcile road populations without respawning retained dots.
   *
   * When zoomed out (>5 km), only major road types are rendered to reduce clutter.
   * Dot budgets are allocated fairly across visible roads via `allocateRoadDotBudgets`.
   *
   * @param {Array} roads    - Parsed road objects to render.
   * @param {number} altitude - Camera altitude in meters.
   * @param {string} label    - Logging label (e.g. "Cache full", "Loaded major").
   * @param {Object|null} [trace=null] - Development-only correlated load trace.
   */

  function renderRoadsForAltitude(
    roads,
    altitude,
    label,
    trace = null,
    replace = true,
  ) {
    const state =
      TRAFFIC_TIMING_ENABLED && trace
        ? parts.timing.trafficTimingRenderState(trace, label)
        : null;
    const renderId = state ? ++trace.renderSequence : null;

    layerState._lastPaintStage = label;
    layerState._lastRenderAltitude = altitude;

    // At high altitude, drop minor roads to reduce visual noise
    const filteredRoads = visibleRoadsForAltitude(roads, altitude);

    // Closed roads spawn zero dots (computeDotCount/spawnDotsForRoad) — count
    // them here so the closure signal is visible in stats even at zero dots.
    layerState._closedRoads = layerState._liveMode
      ? filteredRoads.reduce((n, r) => n + (r.flow?.closure ? 1 : 0), 0)
      : 0;

    // Fade distances must track the camera-to-AREA distance, not assume a
    // nadir view: oblique pitches put the loaded roads many km away even at
    // low altitude. Probe three roads and stretch the curves accordingly.
    let areaDist = altitude;
    const eye = filteredRoads.length
      ? findCamera(layerState._viewer)?.pose()?.position
      : null;
    if (eye) {
      const probes = [
        filteredRoads[0],
        filteredRoads[Math.floor(filteredRoads.length / 2)],
        filteredRoads[filteredRoads.length - 1],
      ];
      for (const probe of probes) {
        const wp = probe?.waypoints?.[0];
        if (wp) areaDist = Math.max(areaDist, distance(eye, wp));
      }
    }
    layerState._fadeScaleFar = Math.max(8000, areaDist * 1.5);
    layerState._fadeTransFar = Math.max(10000, areaDist * 1.8);

    const dotStart = state
      ? parts.timing.trafficTimingMark(state, 'dot-construction-start', {
          renderId,
          renderLabel: label,
          roadCount: roads.length,
          visibleRoadCount: filteredRoads.length,
        })
      : null;
    parts.retention.reconcile(filteredRoads, altitude, replace);
    if (layerState._dots.length && filteredRoads.some((r) => !r.directFlow))
      services.credits?.showOsmCredit?.(layerState._viewer, 'traffic', {
        openMapTiles: true,
      });
    else services.credits?.hideOsmCredit?.(layerState._viewer, 'traffic');
    parts.model.recolorDotsInPlace(label);

    const renderMetrics = state
      ? {
          renderId,
          renderLabel: label,
          roadCount: roads.length,
          visibleRoadCount: filteredRoads.length,
          dotCount: layerState._dots.length,
        }
      : null;
    if (state) {
      const dotEnd = parts.timing.trafficTimingMark(
        state,
        'dot-construction-end',
        renderMetrics,
      );
      parts.timing.trafficTimingMeasure(
        'dot-construction',
        state,
        dotStart,
        dotEnd,
        renderMetrics,
      );
    }

    const heatStart = state
      ? parts.timing.trafficTimingMark(
          state,
          'rebuild-heat-lines-start',
          renderMetrics,
        )
      : null;
    // The flow recolor above already rebuilt the lines from every retained
    // road; without dots to recolor, rebuild them here.
    if (
      !label.includes('tile') &&
      !(layerState._liveMode && layerState._dots.length)
    )
      rebuildHeatLines(visibleRoadsForAltitude(layerState._roads, altitude));
    if (state) {
      const heatEnd = parts.timing.trafficTimingMark(
        state,
        'rebuild-heat-lines-end',
        {
          ...renderMetrics,
          heatLineCount: layerState._heatLineCount,
        },
      );
      parts.timing.trafficTimingMeasure(
        'rebuild-heat-lines',
        state,
        heatStart,
        heatEnd,
        {
          ...renderMetrics,
          heatLineCount: layerState._heatLineCount,
        },
      );
    }

    parts.retention.refreshCounts();
    layerState._lastUpdate = Date.now();
    console.log(
      `[Data:Traffic] ${label}: ${layerState._count} dots (roads=${roads.length}, alt=${Math.round(altitude)}m)`,
    );
    if (state) {
      const renderEnd = parts.timing.trafficTimingMark(
        state,
        'render-return',
        renderMetrics,
      );
      parts.timing.scheduleTrafficTimingPostRender(
        state,
        renderEnd,
        renderId,
        renderMetrics,
      );
    }
  }
  return {
    heatPulsing,
    pulseHeatLines,
    visibleRoadsForAltitude,
    removeHeatLines,
    rebuildHeatLines,
    renderRoadsForAltitude,
  };
}
