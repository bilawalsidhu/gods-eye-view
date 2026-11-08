import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  DEFAULT_PARAMS,
  GRANULARITY_DEG,
  PARAM_LIMITS,
  WATER_LAYER_ID,
  WATER_LAYER_NAME,
  WAVE_REPEAT,
  hiddenReason,
  needsRebuild,
  normalizeWaterParams,
  offsetParamsForSlider,
  offsetSliderPosition,
  snapExtent,
  surfaceHeightM,
} from './policy.js';
import { createWaterMaterial, waterUniformsForParams } from './material.js';

/**
 * The Water Surface layer: an animated sea surface at local mean sea level
 * that follows the view and is hidden by land through the depth buffer.
 *
 * On Google Photorealistic 3D the tileset itself is the depth; on the globe
 * stacks the layer turns `globe.depthTestAgainstTerrain` on while enabled and
 * puts the previous value back on disable. Geoid height comes from the shared
 * EGM96 service; the render governor holds continuous rendering for the
 * animation only while the layer is on.
 *
 * @param {object} [options]
 * @param {object} [options.services]
 * @param {{ensureGeoidReady:Function, geoidHeight:Function}|null} [options.services.geoid]
 * @param {{holdContinuousRender:Function, releaseContinuousRender:Function, governorRequestRender?:Function}|null} [options.services.render]
 * @param {{register:(viewer:object)=>void}|null} [options.services.credit] Attribution registered on first enable.
 * @param {typeof Cesium} [options.cesium] Injectable for tests without WebGL.
 * @param {() => number} [options.now] Clock for the wave animation, ms.
 */
export function createWaterLayer({
  services = {},
  cesium = Cesium,
  now = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
} = {}) {
  const geoid = services.geoid || null;
  const render = services.render || null;
  const credit = services.credit || null;

  let viewer = null;
  let enabled = false;
  let params = { ...DEFAULT_PARAMS };
  let material = null;
  let primitive = null;
  let extent = null;
  let center = null;
  let heightM = null;
  let geoidUndulationM = null;
  let datum = null;
  let hidden = null;
  let lastView = null;
  let removeMoveEnd = null;
  let removePreRender = null;
  let previousDepthTest = null;
  let startedAt = 0;
  let generation = 0;

  function requestRender() {
    if (render?.governorRequestRender)
      render.governorRequestRender(WATER_LAYER_ID);
    else viewer?.scene?.requestRender?.();
  }

  /** Where the view looks: the ellipsoid under the canvas centre, else the camera. */
  function viewCenter() {
    const scene = viewer?.scene;
    const camera = scene?.camera;
    if (!camera) return null;
    const cameraCarto = camera.positionCartographic;
    let carto = null;
    const canvas = scene.canvas;
    if (canvas && typeof camera.pickEllipsoid === 'function') {
      try {
        const picked = camera.pickEllipsoid(
          new cesium.Cartesian2(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ),
          scene.globe?.ellipsoid,
        );
        if (picked) carto = cesium.Cartographic.fromCartesian(picked);
      } catch {
        carto = null;
      }
    }
    carto ||= cameraCarto;
    if (!carto) return null;
    return {
      lat: cesium.Math.toDegrees(carto.latitude),
      lon: cesium.Math.toDegrees(carto.longitude),
      cameraHeightM: cameraCarto?.height ?? Number.NaN,
    };
  }

  function removePrimitive() {
    if (!primitive) return;
    const primitives = viewer?.scene?.primitives;
    if (
      primitives &&
      !primitives.isDestroyed?.() &&
      primitives.contains?.(primitive)
    )
      primitives.remove(primitive);
    else if (!primitive.isDestroyed?.()) primitive.destroy?.();
    primitive = null;
    extent = null;
    center = null;
  }

  function ensureMaterial() {
    if (!material) {
      material = createWaterMaterial(cesium, { repeat: WAVE_REPEAT, params });
    }
    return material;
  }

  function applyParamUniforms() {
    if (!material) return;
    Object.assign(material.uniforms, waterUniformsForParams(params));
  }

  /**
   * Where the baked sea sits. The Google tileset and a real terrain mesh put
   * it at the geoid; the flat-ellipsoid fallback globe (no terrain at all)
   * puts it at ellipsoid height zero, where a geoid-height surface would be
   * tens of metres underground or in the air.
   */
  function seaDatum() {
    const scene = viewer?.scene;
    const Ellipsoid = cesium.EllipsoidTerrainProvider;
    const flatGlobe =
      scene?.globe?.show !== false &&
      typeof Ellipsoid === 'function' &&
      viewer?.terrainProvider instanceof Ellipsoid;
    return flatGlobe ? 'ellipsoid' : 'geoid';
  }

  /** Build the rectangle around a view centre, replacing any previous one. */
  function build(view) {
    const nextExtent = snapExtent(view.lat, view.lon);
    if (!nextExtent) return false;
    datum = seaDatum();
    geoidUndulationM =
      datum === 'geoid' && geoid ? geoid.geoidHeight(view.lat, view.lon) : 0;
    heightM = surfaceHeightM(geoidUndulationM, params.offsetM);
    const geometry = new cesium.RectangleGeometry({
      rectangle: cesium.Rectangle.fromDegrees(
        nextExtent.west,
        nextExtent.south,
        nextExtent.east,
        nextExtent.north,
      ),
      height: heightM,
      granularity: cesium.Math.toRadians(GRANULARITY_DEG),
      vertexFormat: cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
    });
    const next = new cesium.Primitive({
      geometryInstances: new cesium.GeometryInstance({
        geometry,
        id: `${WATER_LAYER_ID}:surface`,
      }),
      appearance: new cesium.EllipsoidSurfaceAppearance({
        material: ensureMaterial(),
        translucent: true,
        aboveGround: true,
      }),
      asynchronous: false,
      allowPicking: false,
    });
    removePrimitive();
    primitive = viewer.scene.primitives.add(next);
    extent = nextExtent;
    center = { lat: view.lat, lon: view.lon };
    return true;
  }

  /** Match the surface to the current view: hide, keep, or rebuild. */
  function sync() {
    if (!viewer || !enabled) return;
    const view = viewCenter();
    lastView = view;
    hidden = hiddenReason(view?.cameraHeightM);
    if (hidden) {
      if (primitive) primitive.show = false;
      requestRender();
      return;
    }
    if (!primitive || needsRebuild(center, view) || seaDatum() !== datum)
      build(view);
    if (primitive) primitive.show = true;
    requestRender();
  }

  function attachViewer() {
    const scene = viewer?.scene;
    if (!scene) return;
    removeMoveEnd?.();
    removeMoveEnd = scene.camera?.moveEnd?.addEventListener?.(sync) || null;
    removePreRender?.();
    removePreRender =
      scene.preRender?.addEventListener?.(() => {
        if (material && primitive?.show)
          material.uniforms.time = (now() - startedAt) / 1000;
      }) || null;
    const globe = scene.globe;
    if (globe && previousDepthTest === null) {
      previousDepthTest = Boolean(globe.depthTestAgainstTerrain);
      globe.depthTestAgainstTerrain = true;
    }
  }

  function detachViewer() {
    removeMoveEnd?.();
    removeMoveEnd = null;
    removePreRender?.();
    removePreRender = null;
    const globe = viewer?.scene?.globe;
    if (globe && previousDepthTest !== null)
      globe.depthTestAgainstTerrain = previousDepthTest;
    previousDepthTest = null;
  }

  return {
    id: WATER_LAYER_ID,
    name: WATER_LAYER_NAME,
    icon: '🌊',
    source: 'Synthetic · EGM96 sea level',
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
    },
    async enable() {
      const token = ++generation;
      enabled = true;
      if (geoid?.ensureGeoidReady) await geoid.ensureGeoidReady();
      if (token !== generation || !enabled) return false;
      startedAt = now();
      credit?.register?.(viewer);
      attachViewer();
      render?.holdContinuousRender?.(WATER_LAYER_ID);
      sync();
      return true;
    },
    disable() {
      generation += 1;
      enabled = false;
      hidden = null;
      render?.releaseContinuousRender?.(WATER_LAYER_ID);
      detachViewer();
      removePrimitive();
      requestRender();
      return true;
    },
    update() {
      return true;
    },
    getParams() {
      return { ...params };
    },
    /** Offset moves the surface (a rebuild); opacity and relief are uniforms. */
    setParams(patch = {}) {
      const next = normalizeWaterParams(patch, params);
      const moved = next.offsetM !== params.offsetM;
      params = next;
      applyParamUniforms();
      if (moved && enabled && primitive && lastView && !hidden) build(lastView);
      if (enabled) requestRender();
      return true;
    },
    getRowControls() {
      return {
        slider: {
          id: 'sea-level-offset',
          label: t('Sea level offset'),
          ariaLabel: t('Water surface height above mean sea level, metres'),
          valueText: t('+{value} m', { value: params.offsetM.toFixed(1) }),
          min: offsetSliderPosition(PARAM_LIMITS.offsetM[0]),
          max: offsetSliderPosition(PARAM_LIMITS.offsetM[1]),
          step: 1,
          value: offsetSliderPosition(params.offsetM),
          params: offsetParamsForSlider,
        },
      };
    },
    getStats() {
      return {
        count: enabled && primitive?.show ? 1 : 0,
        error: enabled ? hidden : null,
        loading: false,
      };
    },
    /** Built extent, height and hide reason, for tests and live gates. */
    diagnostics() {
      return {
        enabled,
        hidden,
        extent: extent ? { ...extent } : null,
        center: center ? { ...center } : null,
        heightM,
        geoidUndulationM,
        datum,
        params: { ...params },
      };
    },
    destroy() {
      generation += 1;
      enabled = false;
      render?.releaseContinuousRender?.(WATER_LAYER_ID);
      detachViewer();
      removePrimitive();
      material = null;
      viewer = null;
      lastView = null;
      hidden = null;
    },
  };
}
