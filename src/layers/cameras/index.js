import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  CAMERA_DEFAULTS,
  COCKPIT_REFUSAL,
  DEFAULT_TARGET_SIZE_M,
  FRAME_FRACTION_LIMITS,
  autoFovRad,
  chaseOffsetEnu,
  orbitOffsetEnu,
  placedGroundCamera,
  smoothingAlpha,
} from './policy.js';

export const CAMERAS_LAYER_ID = 'virtual-cameras';
export const CAMERAS_LAYER_NAME = 'Virtual Cameras';
/** Chips the target switch offers before the list gets unwieldy. */
const MAX_TARGET_CHIPS = 7;
const FREE_ITEM = 'free';
const PLACE_ITEM = 'place';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The Virtual Cameras layer: tripod, chase and orbit cameras aimed at
 * simulation targets. Selecting a camera claims the view through the shell's
 * navigation authority (so Cockpit can refuse and other owners are released),
 * then writes the camera pose once per frame on `scene.preUpdate` from the
 * target's current sample. A pointer or wheel gesture on the globe, another
 * owner taking the camera, or picking "Free" hands the view back and restores
 * the field of view.
 *
 * @param {object} [options]
 * @param {object} [options.services]
 * @param {{holdContinuousRender:Function, releaseContinuousRender:Function, governorRequestRender?:Function}|null} [options.services.render]
 * @param {{cachedGroundFloor:Function, warmGroundFloor?:Function}|null} [options.services.groundFloor] Ellipsoidal ground height cache for tripod cameras.
 * @param {{ensureGeoidReady:Function, geoidHeight:Function}|null} [options.services.geoid] Fallback sea-level datum while the ground is cold.
 * @param {() => object[]} [options.targets] This frame's targets (`simulation.getTargets()`).
 * @param {() => object[]} [options.scenarioCameras] Cameras the loaded scenario declares.
 * @param {(listener:Function)=>Function} [options.subscribeScenario] Scenario change subscription.
 * @param {() => number} [options.scenarioTimeS] Scenario clock, for orbits.
 * @param {typeof Cesium} [options.cesium] Injectable for tests without WebGL.
 * @param {() => number} [options.now] Wall clock, ms.
 */
export function createVirtualCamerasLayer({
  services = {},
  targets = () => [],
  scenarioCameras = () => [],
  subscribeScenario = null,
  scenarioTimeS = () => 0,
  cesium = Cesium,
  now = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
} = {}) {
  const render = services.render || null;
  const groundFloor = services.groundFloor || null;
  const geoid = services.geoid || null;

  let viewer = null;
  let enabled = false;
  let shell = null;
  let cameras = [];
  let sessionCameras = [];
  let activeId = null;
  let params = {
    target: 'auto',
    frameFraction: CAMERA_DEFAULTS.ground.frameFraction,
  };
  let claimError = null;
  let removePreUpdate = null;
  let removeHandoff = null;
  let removeInput = null;
  let unsubscribeScenario = null;
  let holding = false;
  let originalFov = null;
  let lastFrameMs = null;
  let lastPose = null;
  let rowControlsListener = null;
  /** @type {Map<string, {floorM:number|null, warmed:boolean}>} */
  const ground = new Map();
  const smooth = { position: null, direction: null, fov: null };

  function requestRender() {
    if (render?.governorRequestRender)
      render.governorRequestRender(CAMERAS_LAYER_ID);
    else viewer?.scene?.requestRender?.();
  }

  function notify() {
    rowControlsListener?.();
  }

  function syncHold() {
    const wanted = enabled && Boolean(activeId);
    if (wanted && !holding) {
      render?.holdContinuousRender?.(CAMERAS_LAYER_ID);
      holding = true;
    } else if (!wanted && holding) {
      render?.releaseContinuousRender?.(CAMERAS_LAYER_ID);
      holding = false;
    }
  }

  function refreshCameras() {
    let declared = [];
    try {
      declared = scenarioCameras() || [];
    } catch {
      declared = [];
    }
    cameras = [...declared, ...sessionCameras];
    ground.clear();
    if (activeId && !cameras.some((camera) => camera.id === activeId))
      release('camera-removed');
    notify();
  }

  function activeCamera() {
    return cameras.find((camera) => camera.id === activeId) || null;
  }

  function resolveTarget(camera) {
    const list = targets() || [];
    const wanted = params.target !== 'auto' ? params.target : camera?.target;
    return (
      list.find((target) => target.id === wanted) ||
      (wanted ? null : list[0] || null)
    );
  }

  /** Ellipsoidal height of a tripod: ground cache first, geoid while cold. */
  function groundHeightM(camera) {
    if (camera.altitudeReference === 'ellipsoid') return camera.heightM;
    const entry = ground.get(camera.id) || { floorM: null, warmed: false };
    if (entry.floorM === null) {
      const floor = groundFloor?.cachedGroundFloor?.(camera.lat, camera.lon);
      if (Number.isFinite(floor)) entry.floorM = floor;
      else if (!entry.warmed) {
        entry.warmed = true;
        try {
          groundFloor?.warmGroundFloor?.([
            { lat: camera.lat, lon: camera.lon },
          ]);
        } catch {
          /* best effort */
        }
      }
    }
    ground.set(camera.id, entry);
    if (entry.floorM !== null) return entry.floorM + camera.heightM;
    // The flat-ellipsoid fallback globe (no terrain, Google 3D off) has its
    // ground at ellipsoid zero; everywhere else the sea-level datum stands in.
    const Ellipsoid = cesium.EllipsoidTerrainProvider;
    const flatGlobe =
      viewer?.scene?.globe?.show !== false &&
      typeof Ellipsoid === 'function' &&
      viewer?.terrainProvider instanceof Ellipsoid;
    if (flatGlobe) return camera.heightM;
    let n = 0;
    try {
      n = geoid?.geoidHeight ? geoid.geoidHeight(camera.lat, camera.lon) : 0;
    } catch {
      n = 0;
    }
    return (Number.isFinite(n) ? n : 0) + camera.heightM;
  }

  function enuPoint(origin, offset) {
    const frame = cesium.Transforms.eastNorthUpToFixedFrame(origin);
    return cesium.Matrix4.multiplyByPoint(
      frame,
      new cesium.Cartesian3(offset.east, offset.north, offset.up),
      new cesium.Cartesian3(),
    );
  }

  /** Where the camera should be this frame, before smoothing. */
  function desiredPosition(camera, target) {
    if (camera.type === 'ground')
      return cesium.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        groundHeightM(camera),
      );
    if (camera.type === 'chase')
      return enuPoint(
        target.position,
        chaseOffsetEnu({
          headingDeg: target.headingDeg,
          distanceM: camera.distanceM,
          heightOffsetM: camera.heightOffsetM,
          lateralM: camera.lateralM,
        }),
      );
    return enuPoint(
      target.position,
      orbitOffsetEnu({
        timeS: scenarioTimeS(),
        periodS: camera.periodS,
        radiusM: camera.radiusM,
        heightOffsetM: camera.heightOffsetM,
        phaseDeg: camera.phaseDeg,
      }),
    );
  }

  function blend(previous, next, alpha, normalize) {
    if (!previous) return next;
    const out = cesium.Cartesian3.lerp(
      previous,
      next,
      alpha,
      new cesium.Cartesian3(),
    );
    return normalize ? cesium.Cartesian3.normalize(out, out) : out;
  }

  /** Aim the viewer at the target from the active camera. */
  function frame() {
    const camera = activeCamera();
    if (!camera || !viewer?.camera) return;
    const target = resolveTarget(camera);
    if (!target?.position) return;
    const nowMs = now();
    const dtS = lastFrameMs === null ? 0 : (nowMs - lastFrameMs) / 1000;
    lastFrameMs = nowMs;
    const alpha = smoothingAlpha(dtS, camera.smoothingS);
    const wanted = desiredPosition(camera, target);
    const position =
      camera.type === 'ground'
        ? wanted
        : blend(smooth.position, wanted, alpha, false);
    const toTarget = cesium.Cartesian3.subtract(
      target.position,
      position,
      new cesium.Cartesian3(),
    );
    const distanceM = cesium.Cartesian3.magnitude(toTarget);
    if (!(distanceM > 0.5)) return;
    const aim = cesium.Cartesian3.normalize(toTarget, toTarget);
    const direction = blend(smooth.direction, aim, alpha, true);
    const up = cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      position,
      new cesium.Cartesian3(),
    );
    const fovWanted = autoFovRad({
      distanceM,
      targetSizeM: target.sizeM || DEFAULT_TARGET_SIZE_M,
      frameFraction:
        camera.type === 'ground' ? params.frameFraction : camera.frameFraction,
      fixedFovDeg: camera.fovDeg,
    });
    const fov =
      smooth.fov === null
        ? fovWanted
        : smooth.fov + (fovWanted - smooth.fov) * alpha;
    smooth.position = position;
    smooth.direction = direction;
    smooth.fov = fov;
    viewer.camera.setView({
      destination: position,
      orientation: { direction, up },
    });
    const frustum = viewer.camera.frustum;
    if (frustum && 'fov' in frustum) frustum.fov = fov;
    lastPose = {
      cameraId: camera.id,
      targetId: target.id,
      distanceM,
      fovDeg: (fov * 180) / Math.PI,
    };
  }

  function attachOwnership() {
    const scene = viewer?.scene;
    removePreUpdate?.();
    removePreUpdate =
      scene?.preUpdate?.addEventListener?.(() => frame()) || null;
    const canvas = scene?.canvas;
    const yieldCamera = () => release('manual-input');
    if (canvas?.addEventListener) {
      for (const event of ['pointerdown', 'wheel'])
        canvas.addEventListener(event, yieldCamera, { passive: true });
      removeInput = () => {
        for (const event of ['pointerdown', 'wheel'])
          canvas.removeEventListener(event, yieldCamera);
      };
    }
    const off = shell?.subscribeCameraHandoff?.(() =>
      release('camera-handoff'),
    );
    removeHandoff = typeof off === 'function' ? off : null;
  }

  function detachOwnership() {
    removePreUpdate?.();
    removePreUpdate = null;
    removeInput?.();
    removeInput = null;
    removeHandoff?.();
    removeHandoff = null;
  }

  function release(reason) {
    if (!activeId) return;
    activeId = null;
    detachOwnership();
    const frustum = viewer?.camera?.frustum;
    if (frustum && originalFov !== null && 'fov' in frustum)
      frustum.fov = originalFov;
    originalFov = null;
    smooth.position = smooth.direction = smooth.fov = null;
    lastFrameMs = null;
    lastPose = { released: reason };
    syncHold();
    requestRender();
    notify();
  }

  /** Claim the view for a camera; false when Cockpit or the shell refuses. */
  function activate(id) {
    const camera = cameras.find((entry) => entry.id === id);
    if (!camera || !viewer) return false;
    if (shell?.isCockpitActive?.()) {
      claimError = COCKPIT_REFUSAL;
      notify();
      return false;
    }
    if (activeId && activeId !== id) {
      detachOwnership();
    } else if (activeId === id) {
      return true;
    }
    const claimed =
      typeof shell?.runNavigation === 'function'
        ? shell.runNavigation(() => true)
        : true;
    if (claimed === false) {
      claimError = COCKPIT_REFUSAL;
      activeId = null;
      syncHold();
      notify();
      return false;
    }
    claimError = null;
    activeId = id;
    if (originalFov === null) {
      const frustum = viewer.camera?.frustum;
      originalFov = frustum && 'fov' in frustum ? frustum.fov : null;
    }
    smooth.position = smooth.direction = smooth.fov = null;
    lastFrameMs = null;
    attachOwnership();
    syncHold();
    frame();
    requestRender();
    notify();
    return true;
  }

  function placeHere() {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return false;
    const camera = activeCamera();
    const current = camera ? resolveTarget(camera) : (targets() || [])[0];
    const placed = placedGroundCamera(
      {
        lat: cesium.Math.toDegrees(carto.latitude),
        lon: cesium.Math.toDegrees(carto.longitude),
        heightM: carto.height,
      },
      current?.id || null,
      sessionCameras.length + 1,
      t('Camera {n}', { n: sessionCameras.length + 1 }),
    );
    sessionCameras = [...sessionCameras, placed];
    refreshCameras();
    return activate(placed.id);
  }

  function typeLabel(type) {
    return (
      { ground: t('Tripod'), chase: t('Chase'), orbit: t('Orbit') }[type] ||
      type
    );
  }

  return {
    id: CAMERAS_LAYER_ID,
    name: CAMERAS_LAYER_NAME,
    icon: '🎥',
    source: 'Scenario cameras · SYNTHETIC',
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
    },
    /** Navigation authority, handoff channel and Cockpit state from the shell. */
    attachShellServices(services) {
      shell = services || null;
    },
    enable() {
      enabled = true;
      refreshCameras();
      unsubscribeScenario?.();
      const off = subscribeScenario?.(() => refreshCameras());
      unsubscribeScenario = typeof off === 'function' ? off : null;
      return true;
    },
    disable() {
      release('disabled');
      enabled = false;
      claimError = null;
      unsubscribeScenario?.();
      unsubscribeScenario = null;
      notify();
      return true;
    },
    update() {
      return true;
    },
    getParams() {
      return { ...params };
    },
    /** `camera` selects or frees, `place` adds a tripod here; both are actions. */
    setParams(patch = {}) {
      if (Object.hasOwn(patch, 'frameFraction')) {
        const value = Number(patch.frameFraction);
        if (Number.isFinite(value))
          params.frameFraction = clamp(value, ...FRAME_FRACTION_LIMITS);
      }
      if (Object.hasOwn(patch, 'target'))
        params.target = patch.target ? String(patch.target) : 'auto';
      if (patch.place) placeHere();
      if (Object.hasOwn(patch, 'camera')) {
        if (patch.camera === FREE_ITEM || !patch.camera) release('free');
        else activate(String(patch.camera));
      }
      // An active camera re-aims on the next frame; selection framed already.
      requestRender();
      notify();
      return true;
    },
    getRowControls() {
      const list = targets() || [];
      const active = activeCamera();
      const activeTarget = active ? resolveTarget(active) : null;
      const callsignOf = (id) =>
        list.find((target) => target.id === id)?.callsign ||
        id ||
        t('first aircraft');
      return {
        list: {
          ariaLabel: t('Virtual cameras'),
          items: [
            {
              id: FREE_ITEM,
              ordinal: 0,
              lead: t('Free'),
              text: t('Release the view'),
              active: !activeId,
              params: { camera: FREE_ITEM },
            },
            {
              id: PLACE_ITEM,
              ordinal: 0,
              lead: '+',
              text: t('Place a tripod here'),
              params: { place: true },
            },
            ...cameras.map((camera, index) => ({
              id: camera.id,
              ordinal: index + 1,
              lead: camera.title,
              text: `${typeLabel(camera.type)} · ${callsignOf(camera.target)}`,
              active: camera.id === activeId,
              params: { camera: camera.id },
            })),
          ],
        },
        segmented: {
          id: 'camera-target',
          label: t('Target'),
          ariaLabel: t('Camera target'),
          options: [
            {
              id: 'target-auto',
              label: t('Auto'),
              title: t("Each camera's own target"),
              active: params.target === 'auto',
              params: { target: 'auto' },
            },
            ...list.slice(0, MAX_TARGET_CHIPS).map((target) => ({
              id: `target-${target.id}`,
              label: target.callsign,
              active: params.target === target.id,
              params: { target: target.id },
            })),
          ],
        },
        slider: {
          id: 'frame-fill',
          label: t('Target size in frame'),
          ariaLabel: t(
            'Share of the frame height a tripod camera gives its target',
          ),
          valueText: `${Math.round(params.frameFraction * 100)}%`,
          min: Math.round(FRAME_FRACTION_LIMITS[0] * 100),
          max: Math.round(FRAME_FRACTION_LIMITS[1] * 100),
          step: 1,
          value: Math.round(params.frameFraction * 100),
          params: (value) => ({ frameFraction: Number(value) / 100 }),
        },
        info: claimError
          ? t(claimError)
          : active
            ? `${active.title} → ${activeTarget?.callsign || t('no target')}`
            : t('Pick a camera'),
      };
    },
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    getStats() {
      return { count: cameras.length, error: claimError, loading: false };
    },
    /** Active camera, cameras and the last written pose, for tests and gates. */
    diagnostics() {
      return {
        enabled,
        activeId,
        cameras: cameras.map((camera) => camera.id),
        claimError,
        holding,
        lastPose,
        params: { ...params },
      };
    },
    destroy() {
      this.disable();
      sessionCameras = [];
      cameras = [];
      shell = null;
      viewer = null;
      rowControlsListener = null;
    },
  };
}
