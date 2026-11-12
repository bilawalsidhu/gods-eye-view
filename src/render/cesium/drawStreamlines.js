/**
 * @module render/cesium/drawStreamlines
 * @description The Cesium draw port's `windStreamlines` fields: paths
 * traced once through the wind grid (`bakeWindStreamlines`), drawn as
 * polylines at `heightM` in 30° cells, each a primitive of its own. A
 * highlight moves along each path in the wind's direction; a faint ghost
 * of the whole path stays. Cells the eye cannot see (behind the Earth or
 * outside the view) are not drawn, and nothing animates while no cell is.
 *
 * Choices the contract leaves open, taken conservatively:
 * - The grid's samples are points: the first column at `rectangle.west`
 *   and the first row at `rectangle.north`, rows running south. A grid
 *   whose rectangle spans 360° of longitude wraps (`width` columns over
 *   the whole circle); any other is `width - 1` steps from west to east.
 * - `style.color` is the ghost's and the trail's colour; the moving tip
 *   brightens it towards white. `speedFactor` scales how fast the tip
 *   moves (1 by default).
 * - The highlight moves on the page's own clock, at most 30 times a
 *   second, asking for the frames it needs; `paused` holds it where it is
 *   and raises the ghost. `alpha` scales everything, and 0 draws nothing.
 * - Without `heightM` the paths are drawn at the ellipsoid's surface.
 * - Any change but `alpha`, `paused` and `style` traces the paths again.
 * - Scenes not in 3D refuse the field, as does a grid no path runs through.
 */
import * as Cesium from 'cesium';
import {
  bakeWindStreamlines,
  groupWindPaths,
} from '../../layers/wind/streamlines.js';
import { listenerList, uncaught } from './common.js';

// How fast the highlight runs along a path, in path lengths per second.
const TIP_SPEED = 0.16;
const GHOST_ALPHA = 0.25;
const GHOST_ALPHA_PAUSED = 0.34;
// The highlight moves at most this often (seconds between frames).
const STEP_SECONDS = 0.032;

// A persistent fine curve plus a moving, tapered highlight. The integer part
// of s identifies a path; its fractional part follows the wind.
const FLOW_MATERIAL = `
in float v_windFacing;
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    float pathId = floor(materialInput.st.s);
    float along = fract(materialInput.st.s);
    float offset = fract((pathId + 1.0) * 0.61803398875);
    float behind = fract(phaseTime * tipSpeed + offset - along);
    float tail = (1.0 - smoothstep(0.0, 0.32, behind));
    float tip = 1.0 - smoothstep(0.0, 0.045, behind);
    float ends = smoothstep(0.0, 0.055, along) * (1.0 - smoothstep(0.945, 1.0, along));
    float edge = 1.0 - smoothstep(0.26, 0.5, abs(materialInput.st.t - 0.5));
    float horizon = smoothstep(0.0, 0.065, v_windFacing);
    material.diffuse = mix(baseColor.rgb, vec3(0.91, 0.99, 1.0), tip);
    material.alpha = (ghostAlpha + 0.64 * tail + 0.16 * tip) * ends * edge * horizon * heightFade;
    return material;
}`;

const DEFAULT_COLOR = '#80c9e6';

/** A contract colour as Cesium's; one Cesium cannot read is the default. */
function toColor(C, color) {
  const Color = C.Color ?? Cesium.Color;
  if (Array.isArray(color))
    return new Color(color[0], color[1], color[2], color[3] ?? 1);
  return (
    Color.fromCssColorString(String(color ?? DEFAULT_COLOR)) ??
    Color.fromCssColorString(DEFAULT_COLOR)
  );
}

/**
 * The spec's grid as the wind sampler reads it. A rectangle across the
 * antimeridian (west east of east) runs east past 180°.
 */
export function windGridOf(spec) {
  const { west, south, north } = spec.rectangle;
  let { east } = spec.rectangle;
  if (east < west) east += 360;
  const span = east - west;
  const wraps = span >= 360 - 1e-9;
  return {
    u: spec.u,
    v: spec.v,
    nx: spec.width,
    ny: spec.height,
    lo1: west,
    la1: north,
    dx: span / (wraps ? spec.width : spec.width - 1),
    dy: (north - south) / (spec.height - 1),
  };
}

/**
 * One `windStreamlines` field over `scene`.
 * @param {{scene: object, spec: object, report?: (error: unknown) => void,
 *   cesium?: object,
 *   requestFrame?: (cb: (time: number) => void) => number,
 *   cancelFrame?: (id: number) => void, onDispose?: () => void}} options
 */
export function createWindStreamlines({
  scene,
  spec,
  report = uncaught,
  cesium: C = Cesium,
  requestFrame = (cb) => globalThis.requestAnimationFrame(cb),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
  onDispose = () => {},
}) {
  if (
    C.SceneMode?.SCENE3D !== undefined &&
    scene.mode !== undefined &&
    scene.mode !== C.SceneMode.SCENE3D
  )
    throw new TypeError(
      'the Cesium renderer draws wind streamlines in 3D only',
    );

  const live = () => !scene.isDestroyed?.();
  const requestRender = () => {
    if (live()) scene.requestRender();
  };
  let current = { ...spec, style: { ...spec.style } };
  let alpha = spec.alpha ?? 1;
  let paused = spec.paused === true;
  let shown = true;
  let disposed = false;
  const cells = [];
  let material = null;
  let occluder = null;
  let phaseTime = 0;
  let visibleCells = 0;
  let diagnostics = { pathCount: 0, vertexCount: 0, buildMs: 0, cellCount: 0 };
  // The animation frame asked for, and when the highlight last moved.
  let frameId = null;
  let lastTime = null;
  // 'drawn' is owed for the latest change, made at `changedAt`.
  let owed = true;
  let renders = 0;
  let changedAt = 0;
  const frameNumber = () => scene.frameState?.frameNumber ?? renders;
  const drawnListeners = listenerList(report);

  function clear() {
    for (const cell of cells) {
      if (live() && scene.primitives && !scene.primitives.isDestroyed?.())
        scene.primitives.remove(cell.primitive);
      if (!cell.primitive.isDestroyed?.()) cell.primitive.destroy?.();
    }
    cells.length = 0;
    if (material && !material.isDestroyed?.()) material.destroy?.();
    material = null;
    occluder = null;
    visibleCells = 0;
  }

  function styleUniforms() {
    if (!material) return;
    const color = toColor(C, current.style?.color);
    material.uniforms.baseColor = color;
    material.uniforms.tipSpeed = TIP_SPEED * (current.style?.speedFactor ?? 1);
    material.uniforms.ghostAlpha = paused ? GHOST_ALPHA_PAUSED : GHOST_ALPHA;
    material.uniforms.heightFade = alpha;
  }

  /** Trace and build; a failure leaves nothing built and throws. */
  function build() {
    try {
      buildCells();
    } catch (error) {
      clear();
      diagnostics = { pathCount: 0, vertexCount: 0, buildMs: 0, cellCount: 0 };
      throw error;
    }
  }
  function buildCells() {
    clear();
    const started = performance.now();
    // A grid round the whole globe wraps the wind east and west; one over
    // part of it seeds inside it, and its paths stop at its edges.
    const grid = windGridOf(current);
    const { west, south, north } = current.rectangle;
    const east =
      current.rectangle.east < west
        ? current.rectangle.east + 360
        : current.rectangle.east;
    const bounds =
      east - west >= 360 - 1e-9 ? null : { west, south, east, north };
    const paths = bakeWindStreamlines(grid, {
      count: current.pathBudget,
      steps: current.steps,
      bounds,
    });
    // A grid no path runs through is refused, so its caller can draw it
    // some other way.
    if (!paths.length)
      throw new RangeError('no wind streamlines run through this grid');
    let vertexCount = 0;
    material = new C.Material({
      fabric: {
        type: 'DrawWindStreamline',
        uniforms: {
          phaseTime,
          ghostAlpha: GHOST_ALPHA,
          heightFade: 0,
          tipSpeed: TIP_SPEED,
          baseColor: toColor(C, DEFAULT_COLOR),
        },
        source: FLOW_MATERIAL,
      },
      translucent: () => true,
    });
    styleUniforms();
    const base = new C.PolylineMaterialAppearance({ material });
    // Extend Cesium's own polyline shader rather than duplicate its
    // expansion and precision code. Explicit facing also masks the far
    // hemisphere when a scene keeps no globe depth for translucent objects.
    const source = base.vertexShaderSource;
    if (
      !/void\s+main\s*\(\s*\)/.test(source) ||
      !/v_st\.s\s*=\s*st\.s\s*;/.test(source)
    )
      throw new Error('Wind polyline shader entry unavailable');
    const seededSource = source.replace(
      /v_st\.s\s*=\s*st\.s\s*;/,
      'v_st.s = st.s * 0.999 + czm_batchTable_windSeed(batchId);',
    );
    const vertexShaderSource =
      `out float v_windFacing;\n${seededSource}`.replace(
        /void\s+main\s*\(\s*\)\s*\{/,
        `void main() {\nvec3 windWorld = (czm_model * vec4(position3DHigh + position3DLow, 1.0)).xyz;\nv_windFacing = dot(normalize(windWorld), normalize(czm_viewerPositionWC - windWorld));\n`,
      );
    // EllipsoidalOccluder only tests points: a sphere occluder with an
    // inscribed Earth sphere, whether or not the globe shows.
    occluder = new C.Occluder(
      new C.BoundingSphere(C.Cartesian3.ZERO, C.Ellipsoid.WGS84.minimumRadius),
      scene.camera.positionWC,
    );
    const height = Number(current.heightM) || 0;
    const width = current.style?.widthPx ?? 2.4;
    for (const group of groupWindPaths(paths)) {
      const cellPositions = [];
      let cellVertexCount = 0;
      const instances = group.paths.map((path) => {
        const positions = path.coordinates.map(([lon, lat]) =>
          C.Cartesian3.fromDegrees(lon, lat, height),
        );
        // Cesium's worker expands the lines; per-instance seeds keep the
        // expanded vertex buffer off the main thread.
        const geometry = new C.PolylineGeometry({
          positions,
          width,
          arcType: C.ArcType?.NONE,
          vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
        });
        cellPositions.push(...positions);
        cellVertexCount += positions.length * 4 - 4;
        return new C.GeometryInstance({
          geometry,
          attributes: {
            windSeed: new C.GeometryInstanceAttribute({
              componentDatatype: C.ComponentDatatype.FLOAT,
              componentsPerAttribute: 1,
              value: [path.seed],
            }),
          },
        });
      });
      const appearance = new C.PolylineMaterialAppearance({
        material,
        vertexShaderSource,
        translucent: true,
        renderState: { depthTest: { enabled: true }, depthMask: false },
      });
      const primitive = new C.Primitive({
        show: false,
        geometryInstances: instances,
        appearance,
        asynchronous: true,
        allowPicking: false,
        releaseGeometryInstances: true,
        compressVertices: false,
      });
      cells.push({
        primitive,
        sphere: C.BoundingSphere.fromPoints(cellPositions),
        vertexCount: cellVertexCount,
      });
      scene.primitives.add(primitive);
      vertexCount += cellVertexCount;
    }
    diagnostics = {
      pathCount: paths.length,
      vertexCount,
      buildMs: performance.now() - started,
      cellCount: cells.length,
    };
  }

  // Which cells the eye can see, before each frame draws.
  function cull() {
    visibleCells = 0;
    const camera = scene.camera;
    const draws = shown && alpha > 0 && cells.length > 0 && camera;
    let volume;
    if (draws) {
      occluder.cameraPosition = camera.positionWC;
      volume = camera.frustum.computeCullingVolume(
        camera.positionWC,
        camera.directionWC,
        camera.upWC,
      );
    }
    for (const cell of cells) {
      cell.primitive.show = Boolean(
        draws &&
        occluder.isBoundingSphereVisible(cell.sphere) &&
        volume.computeVisibility(cell.sphere) !== C.Intersect.OUTSIDE,
      );
      if (cell.primitive.show) visibleCells += 1;
    }
  }
  const page = globalThis.document;
  const animating = () =>
    !disposed &&
    shown &&
    !paused &&
    alpha > 0 &&
    visibleCells > 0 &&
    page?.hidden !== true;
  function step(time) {
    frameId = null;
    if (!animating()) {
      lastTime = null;
      return;
    }
    const elapsed = lastTime === null ? null : (time - lastTime) / 1000;
    // A first frame (after a pause, a hidden page or nothing in view) moves
    // one tick; otherwise the highlight moves by the time passed, and a frame
    // is drawn, at most every STEP_SECONDS.
    let moved = true;
    if (elapsed === null) phaseTime += 1 / 60;
    else if (elapsed >= STEP_SECONDS) phaseTime += elapsed;
    else moved = false;
    if (moved) {
      lastTime = time;
      if (material) material.uniforms.phaseTime = phaseTime % 10000;
      requestRender();
    }
    frameId = requestFrame(step);
  }
  function animate() {
    if (animating()) frameId ??= requestFrame(step);
    else if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
      lastTime = null;
    }
  }

  const ready = () => cells.every((cell) => cell.primitive.ready);
  function changed() {
    owed = true;
    changedAt = frameNumber();
    requestRender();
  }
  // A field that cannot be built is refused, holding nothing.
  build();
  const offPreRender = scene.preRender.addEventListener(() => {
    cull();
    animate();
  });
  // A hidden page stops the highlight; shown again, it starts afresh rather
  // than jumping by the time it was hidden.
  const onVisibility = () => {
    lastTime = null;
    animate();
  };
  page?.addEventListener?.('visibilitychange', onVisibility);
  const offPostRender = scene.postRender.addEventListener(() => {
    renders += 1;
    // Nothing built (a rebuild failed) is never told drawn.
    if (!owed || !shown || disposed || !cells.length) return;
    if (!ready() || frameNumber() <= changedAt) {
      requestRender();
      return;
    }
    owed = false;
    drawnListeners.fire();
  });

  changed();

  return {
    id: spec.id,
    get show() {
      return shown;
    },
    set show(value) {
      const next = Boolean(value);
      if (disposed || next === shown) return;
      shown = next;
      if (!shown) {
        for (const cell of cells) cell.primitive.show = false;
        visibleCells = 0;
        animate();
      }
      changedAt = frameNumber();
      requestRender();
    },
    update(patch = {}) {
      if (disposed) return;
      if (patch.kind !== undefined && patch.kind !== 'windStreamlines')
        throw new TypeError('a field keeps its kind');
      const retrace =
        ['u', 'v', 'width', 'height', 'pathBudget', 'steps', 'heightM'].some(
          (key) => key in patch && patch[key] !== current[key],
        ) ||
        (patch.rectangle !== undefined &&
          ['west', 'south', 'east', 'north'].some(
            (edge) => patch.rectangle[edge] !== current.rectangle?.[edge],
          ));
      const restroke =
        patch.style?.widthPx !== undefined &&
        patch.style.widthPx !== current.style?.widthPx;
      current = {
        ...current,
        ...patch,
        style: { ...current.style, ...patch.style },
      };
      if ('alpha' in patch) alpha = patch.alpha ?? 1;
      if ('paused' in patch) paused = patch.paused === true;
      if (retrace || restroke)
        try {
          build();
        } catch (error) {
          // It draws nothing until a change builds again.
          report(error);
        }
      else styleUniforms();
      cull();
      animate();
      changed();
    },
    on(event, cb) {
      if (event !== 'drawn') return () => {};
      return drawnListeners.on(cb);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
      offPreRender();
      offPostRender();
      page?.removeEventListener?.('visibilitychange', onVisibility);
      drawnListeners.clear();
      clear();
      requestRender();
      onDispose();
    },
    /** For tests and diagnostics: what it built and draws. */
    diagnostics: () => ({
      ...diagnostics,
      visibleCells,
      ready: ready(),
      animating: frameId !== null,
      phaseTime,
    }),
  };
}
