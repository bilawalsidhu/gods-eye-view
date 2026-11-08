import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { civilAircraftModelSpec } from '../flights/modelSpec.js';
import { MODEL_HEADING_OFFSET_DEG, MODEL_MIN_PX } from '../flights/policy.js';
import { RATE_OPTIONS, createSimulationClock } from './clock.js';
import {
  DEFAULT_SCENARIO_ID,
  buildTimeline,
  normalizeScenario,
  pathPositions,
  routePositions,
  sampleTimeline,
  scenarioDurationS,
} from './scenario.js';

export const SIMULATION_LAYER_ID = 'simulation';
export const SIMULATION_LAYER_NAME = 'Simulation';

/** Trail length behind each aircraft, seconds of flight, and its limits. */
export const DEFAULT_TRAIL_S = 90;
export const MAX_TRAIL_S = 600;
/** Trail sampling step; 1 s at 200 m/s is a 200 m segment. */
export const TRAIL_STEP_S = 1;
/** Scenario ids are file names under /scenarios/. */
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DEFAULT_PARAMS = Object.freeze({
  scenario: DEFAULT_SCENARIO_ID,
  playing: true,
  rate: 1,
  trailS: DEFAULT_TRAIL_S,
  routes: true,
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatClock(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The Simulation layer: aircraft flying authored waypoint scenarios with a
 * play/pause/rate/seek clock, 3D models from the shared hangar, a glowing
 * trail behind each aircraft and a faint route line ahead. Positions are
 * sampled once per frame on `scene.preUpdate`, so every visual and the
 * targets handed to the camera engine agree on where an aircraft is.
 *
 * @param {object} [options]
 * @param {object} [options.services]
 * @param {{holdContinuousRender:Function, releaseContinuousRender:Function, governorRequestRender?:Function}|null} [options.services.render]
 * @param {(url:string)=>string} [options.resolveAsset] Asset URL resolver.
 * @param {(id:string, options:{signal:AbortSignal})=>Promise<object>} [options.loadScenario] Scenario document loader; defaults to fetching `/scenarios/<id>.json`.
 * @param {typeof Cesium} [options.cesium] Injectable for tests without WebGL.
 * @param {() => number} [options.now] Wall clock, ms.
 */
export function createSimulationLayer({
  services = {},
  resolveAsset = (url) => url,
  loadScenario = null,
  cesium = Cesium,
  now = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
} = {}) {
  const render = services.render || null;
  const fetchScenario =
    loadScenario ||
    (async (id, { signal } = {}) => {
      const response = await fetch(resolveAsset(`/scenarios/${id}.json`), {
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });

  let viewer = null;
  let enabled = false;
  let params = { ...DEFAULT_PARAMS };
  let scenario = null;
  let loading = false;
  let loadError = null;
  let abort = null;
  let generation = 0;
  let removePreUpdate = null;
  let holding = false;
  let focusedId = null;
  let rowControlsListener = null;
  const clock = createSimulationClock({ now });
  /** @type {Map<string, object>} aircraft id -> runtime record */
  const fleet = new Map();

  function requestRender() {
    if (render?.governorRequestRender)
      render.governorRequestRender(SIMULATION_LAYER_ID);
    else viewer?.scene?.requestRender?.();
  }

  function notifyRowControls() {
    rowControlsListener?.();
  }

  function syncHold() {
    const wanted = enabled && params.playing && fleet.size > 0;
    if (wanted && !holding) {
      render?.holdContinuousRender?.(SIMULATION_LAYER_ID);
      holding = true;
    } else if (!wanted && holding) {
      render?.releaseContinuousRender?.(SIMULATION_LAYER_ID);
      holding = false;
    }
    requestRender();
  }

  function cartesian(sample) {
    return cesium.Cartesian3.fromDegrees(sample.lon, sample.lat, sample.altM);
  }

  /** Sample every aircraft at the clock time and refresh its cached visuals. */
  function frame() {
    if (!enabled || fleet.size === 0) return;
    const tS = clock.timeS();
    for (const record of fleet.values()) {
      const sample = sampleTimeline(record.timeline, tS);
      record.sample = sample;
      record.position = cartesian(sample);
      record.orientation = cesium.Transforms.headingPitchRollQuaternion(
        record.position,
        new cesium.HeadingPitchRoll(
          cesium.Math.toRadians(sample.headingDeg + MODEL_HEADING_OFFSET_DEG),
          cesium.Math.toRadians(sample.pitchDeg),
          0,
        ),
      );
      const trail = pathPositions(
        record.timeline,
        tS - params.trailS,
        tS,
        TRAIL_STEP_S,
      );
      // Newest first, so the glow material tapers towards the oldest end.
      record.trail = trail.reverse().map(cartesian);
    }
  }

  function removeEntities(record) {
    const entities = viewer?.entities;
    for (const key of ['entity', 'trailEntity', 'routeEntity']) {
      const entity = record[key];
      if (entity && entities) {
        try {
          entities.remove(entity);
        } catch {
          /* viewer torn down */
        }
      }
      record[key] = null;
    }
  }

  function clearFleet() {
    for (const record of fleet.values()) removeEntities(record);
    fleet.clear();
  }

  function labelGraphics(aircraft) {
    return {
      text: aircraft.callsign,
      font: '12px "JetBrains Mono", monospace',
      fillColor: cesium.Color.WHITE,
      outlineColor: cesium.Color.BLACK,
      outlineWidth: 2,
      style: cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new cesium.Cartesian2(0, -26),
      verticalOrigin: cesium.VerticalOrigin.BOTTOM,
      scaleByDistance: new cesium.NearFarScalar(2000, 1, 80000, 0.55),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    };
  }

  /** Create the model, trail and route entities for one aircraft. */
  function addAircraft(aircraft) {
    const timeline = buildTimeline(aircraft);
    const spec = civilAircraftModelSpec(aircraft.klass);
    const color = cesium.Color.fromCssColorString(aircraft.color);
    const record = {
      aircraft,
      timeline,
      spec,
      color,
      sample: null,
      position: null,
      orientation: null,
      trail: [],
      entity: null,
      trailEntity: null,
      routeEntity: null,
    };
    const prefix = `${SIMULATION_LAYER_ID}:${aircraft.id}`;
    record.entity = viewer.entities.add({
      id: prefix,
      position: new cesium.CallbackProperty(() => record.position, false),
      orientation: new cesium.CallbackProperty(() => record.orientation, false),
      model: {
        uri: resolveAsset(spec.url),
        scale: spec.scale,
        minimumPixelSize: MODEL_MIN_PX,
        color,
        colorBlendMode: cesium.ColorBlendMode.MIX,
        colorBlendAmount: spec.blendAmount,
      },
      label: labelGraphics(aircraft),
    });
    record.trailEntity = viewer.entities.add({
      id: `${prefix}:trail`,
      polyline: {
        positions: new cesium.CallbackProperty(() => record.trail, false),
        width: 6,
        material: new cesium.PolylineGlowMaterialProperty({
          color: color.withAlpha(0.9),
          glowPower: 0.22,
          taperPower: 0.6,
        }),
        arcType: cesium.ArcType.NONE,
      },
    });
    record.routeEntity = viewer.entities.add({
      id: `${prefix}:route`,
      show: params.routes,
      polyline: {
        positions: routePositions(timeline).map(cartesian),
        width: 1.5,
        material: new cesium.PolylineDashMaterialProperty({
          color: color.withAlpha(0.35),
          dashLength: 24,
        }),
        arcType: cesium.ArcType.NONE,
      },
    });
    fleet.set(aircraft.id, record);
  }

  async function load(id) {
    const token = ++generation;
    abort?.abort();
    abort =
      typeof AbortController === 'function' ? new AbortController() : null;
    loading = true;
    loadError = null;
    clearFleet();
    notifyRowControls();
    let next = null;
    try {
      const json = await fetchScenario(id, { signal: abort?.signal });
      next = normalizeScenario(json);
    } catch (error) {
      if (token !== generation) return false;
      loading = false;
      loadError = `Scenario "${id}" failed: ${error?.message || error}`;
      notifyRowControls();
      requestRender();
      return false;
    }
    if (token !== generation || !enabled || !viewer) return false;
    scenario = next;
    for (const aircraft of next.aircraft) addAircraft(aircraft);
    const timelines = [...fleet.values()].map((record) => record.timeline);
    const allLoop = next.aircraft.every((aircraft) => aircraft.loop);
    clock.setDuration(scenarioDurationS(timelines), allLoop);
    clock.seek(0);
    clock.setRate(params.rate);
    if (params.playing) clock.play();
    else clock.pause();
    loading = false;
    frame();
    syncHold();
    notifyRowControls();
    return true;
  }

  function attachViewer() {
    const scene = viewer?.scene;
    removePreUpdate?.();
    removePreUpdate =
      scene?.preUpdate?.addEventListener?.(() => frame()) || null;
  }

  function detachViewer() {
    removePreUpdate?.();
    removePreUpdate = null;
  }

  function focusAircraft(id) {
    const record = fleet.get(id);
    if (!record?.position || !viewer?.camera) return;
    focusedId = id;
    const headingRad = cesium.Math.toRadians(
      (record.sample?.headingDeg ?? 0) + 150,
    );
    viewer.camera.flyToBoundingSphere?.(
      new cesium.BoundingSphere(record.position, 400),
      {
        duration: 1.5,
        offset: new cesium.HeadingPitchRange(
          headingRad,
          cesium.Math.toRadians(-18),
          1800,
        ),
      },
    );
  }

  function applyParams(patch = {}) {
    const next = { ...params };
    if (Object.hasOwn(patch, 'scenario')) {
      const id = String(patch.scenario || '');
      if (SCENARIO_ID_PATTERN.test(id)) next.scenario = id;
    }
    if (Object.hasOwn(patch, 'playing')) next.playing = Boolean(patch.playing);
    if (Object.hasOwn(patch, 'rate') && Number.isFinite(Number(patch.rate)))
      next.rate = clamp(Number(patch.rate), 0.1, 16);
    if (Object.hasOwn(patch, 'trailS') && Number.isFinite(Number(patch.trailS)))
      next.trailS = clamp(Number(patch.trailS), 0, MAX_TRAIL_S);
    if (Object.hasOwn(patch, 'routes')) next.routes = Boolean(patch.routes);
    const scenarioChanged = next.scenario !== params.scenario;
    params = next;
    clock.setRate(params.rate);
    if (params.playing) clock.play();
    else clock.pause();
    if (Object.hasOwn(patch, 'timeS') && Number.isFinite(Number(patch.timeS)))
      clock.seek(Number(patch.timeS));
    for (const record of fleet.values())
      if (record.routeEntity) record.routeEntity.show = params.routes;
    if (Object.hasOwn(patch, 'focus')) focusAircraft(String(patch.focus));
    if (enabled && scenarioChanged) void load(params.scenario);
    else if (enabled) {
      frame();
      syncHold();
    }
    notifyRowControls();
  }

  return {
    id: SIMULATION_LAYER_ID,
    name: SIMULATION_LAYER_NAME,
    icon: '🛩',
    source: 'Authored scenario · SYNTHETIC',
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
    },
    async enable() {
      enabled = true;
      attachViewer();
      return load(params.scenario);
    },
    disable() {
      generation += 1;
      abort?.abort();
      abort = null;
      enabled = false;
      loading = false;
      clock.pause();
      detachViewer();
      clearFleet();
      scenario = null;
      focusedId = null;
      syncHold();
      return true;
    },
    update() {
      return true;
    },
    getParams() {
      return { ...params };
    },
    /** `timeS` seeks and `focus` flies to an aircraft; neither is stored. */
    setParams(patch = {}) {
      applyParams(patch);
      return true;
    },
    getRowControls() {
      const snap = clock.snapshot();
      const duration = Math.max(1, Math.round(snap.durationS));
      return {
        slider: {
          id: 'scenario-time',
          label: t('Scenario time'),
          ariaLabel: t('Scenario time, seconds from start'),
          valueText: `${formatClock(snap.timeS)} / ${formatClock(snap.durationS)}`,
          min: 0,
          max: duration,
          step: 1,
          value: Math.round(clamp(snap.timeS, 0, duration)),
          params: (value) => ({ timeS: Number(value) }),
        },
        segmented: {
          id: 'playback',
          label: t('Playback'),
          ariaLabel: t('Scenario playback'),
          options: [
            {
              id: 'pause',
              label: t('Pause'),
              active: !params.playing,
              params: { playing: false },
            },
            ...RATE_OPTIONS.map((rate) => ({
              id: `rate-${rate}`,
              label: `${rate}×`,
              title: t('Play at {rate}× speed', { rate }),
              active: params.playing && params.rate === rate,
              params: { playing: true, rate },
            })),
          ],
        },
        list: {
          ariaLabel: t('Simulated aircraft'),
          items: [...fleet.values()].map((record, index) => {
            const sample = record.sample;
            const altFt = sample ? Math.round(sample.altM / 0.3048) : 0;
            const kt = sample ? Math.round(sample.speedMps / 0.514444) : 0;
            return {
              id: record.aircraft.id,
              ordinal: index + 1,
              lead: record.aircraft.callsign,
              text: `${record.aircraft.typeCode || record.aircraft.klass} · ${altFt} ft · ${kt} kt${sample?.done ? ` · ${t('Landed')}` : ''}`,
              accent: record.aircraft.color,
              active: record.aircraft.id === focusedId,
              params: { focus: record.aircraft.id },
            };
          }),
        },
        info: scenario ? scenario.title : '',
      };
    },
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    getStats() {
      return {
        count: fleet.size,
        error: loadError,
        loading,
      };
    },
    /**
     * Current targets for cameras and other followers: one per aircraft, with
     * the position, attitude and speed sampled this frame.
     * @returns {{id:string, callsign:string, position:object, headingDeg:number, pitchDeg:number, speedMps:number, altM:number, done:boolean}[]}
     */
    getTargets() {
      return [...fleet.values()]
        .filter((record) => record.sample && record.position)
        .map((record) => ({
          id: record.aircraft.id,
          callsign: record.aircraft.callsign,
          position: record.position,
          headingDeg: record.sample.headingDeg,
          pitchDeg: record.sample.pitchDeg,
          speedMps: record.sample.speedMps,
          altM: record.sample.altM,
          done: record.sample.done,
        }));
    },
    /** Where an aircraft is at any scenario time, for planning cameras ahead. */
    sampleAt(id, tS) {
      const record = fleet.get(id);
      return record ? sampleTimeline(record.timeline, tS) : null;
    },
    getClock() {
      return clock.snapshot();
    },
    getScenario() {
      return scenario;
    },
    /** Loaded aircraft and clock, for tests and live gates. */
    diagnostics() {
      return {
        enabled,
        loading,
        error: loadError,
        scenario: scenario?.id || null,
        aircraft: [...fleet.keys()],
        clock: clock.snapshot(),
        holding,
        params: { ...params },
      };
    },
    destroy() {
      this.disable();
      viewer = null;
      rowControlsListener = null;
    },
  };
}
