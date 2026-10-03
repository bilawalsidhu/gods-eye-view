import {
  bakeWindStreamlines,
  groupWindPaths,
  WIND_DISPLAY_HEIGHT_METERS,
  WIND_PATH_LIMIT,
  WIND_NARROW_PATH_LIMIT,
} from './streamlines.js';

export const WIND_FADE_LOW_METERS = 15000;
export const WIND_FADE_HIGH_METERS = 60000;

// Original material: a persistent fine curve plus a moving, tapered highlight.
// The integer part of s identifies a path; its fractional part follows the wind.
const FLOW_MATERIAL = `
in float v_windFacing;
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    float pathId = floor(materialInput.st.s);
    float along = fract(materialInput.st.s);
    float offset = fract((pathId + 1.0) * 0.61803398875);
    float behind = fract(phaseTime * 0.16 + offset - along);
    float tail = (1.0 - smoothstep(0.0, 0.32, behind));
    float tip = 1.0 - smoothstep(0.0, 0.045, behind);
    float ends = smoothstep(0.0, 0.055, along) * (1.0 - smoothstep(0.945, 1.0, along));
    float edge = 1.0 - smoothstep(0.26, 0.5, abs(materialInput.st.t - 0.5));
    float horizon = smoothstep(0.0, 0.065, v_windFacing);
    material.diffuse = mix(vec3(0.50, 0.79, 0.90), vec3(0.91, 0.99, 1.0), tip);
    material.alpha = (ghostAlpha + 0.64 * tail + 0.16 * tip) * ends * edge * horizon * heightFade;
    return material;
}`;

/** Native Cesium geometry/material owner. No animation loop or DOM ownership. */
export function createWindGpuRendering({ cesium: C, getViewer }) {
  const cells = [];
  let occluder = null;
  let collection = null;
  let material = null;
  let paused = false;
  let destroyed = false;
  const emptyDiagnostics = () => ({
    pathCount: 0,
    vertexCount: 0,
    buildMs: 0,
    error: null,
    cellCount: 0,
    visibleCells: 0,
    visibleVertexCount: 0,
    heightFade: 0,
  });
  let diagnostics = emptyDiagnostics();

  function supported() {
    const scene = getViewer?.()?.scene;
    return (
      !destroyed &&
      Boolean(
        scene?.primitives &&
        C?.Primitive &&
        C?.GeometryInstance &&
        C?.GeometryInstanceAttribute &&
        C?.ComponentDatatype?.FLOAT !== undefined &&
        C?.PolylineGeometry &&
        C?.PolylineMaterialAppearance &&
        C?.Material &&
        C?.BoundingSphere?.fromPoints &&
        C?.Occluder &&
        C?.Ellipsoid?.WGS84 &&
        C?.Intersect &&
        C?.Cartesian3?.fromDegrees,
      ) &&
      (C.SceneMode?.SCENE3D === undefined ||
        scene.mode === undefined ||
        scene.mode === C.SceneMode.SCENE3D)
    );
  }

  function clear() {
    for (const cell of cells) {
      collection?.remove(cell.primitive);
      if (!cell.primitive.isDestroyed?.()) cell.primitive.destroy?.();
    }
    cells.length = 0;
    occluder = null;
    collection = null;
    material?.destroy?.();
    material = null;
    diagnostics = emptyDiagnostics();
  }

  function setField(field) {
    clear();
    if (!supported() || !field) return false;
    const started = globalThis.performance?.now?.() ?? Date.now();
    try {
      const width = getViewer().scene.canvas?.clientWidth;
      const budget =
        width > 0 && width < 700 ? WIND_NARROW_PATH_LIMIT : WIND_PATH_LIMIT;
      const paths = bakeWindStreamlines(field, { count: budget });
      if (!paths.length) return false;
      let vertexCount = 0;
      material = new C.Material({
        fabric: {
          type: 'GevWindStreamline',
          uniforms: {
            phaseTime: 0,
            ghostAlpha: paused ? 0.34 : 0.25,
            heightFade: 0,
          },
          source: FLOW_MATERIAL,
        },
        translucent: () => true,
      });
      const base = new C.PolylineMaterialAppearance({ material });
      // Extend the public default shader rather than duplicate Cesium's polyline
      // expansion/precision code. Explicit facing also masks the far hemisphere
      // when a scene chooses not to preserve globe depth for translucent objects.
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
      const scene = getViewer().scene;
      collection = scene.primitives;
      // EllipsoidalOccluder only tests points. Use Cesium's sphere occluder
      // with an inscribed Earth sphere, independent of scene.globe.show.
      occluder = new C.Occluder(
        new C.BoundingSphere(
          C.Cartesian3.ZERO,
          C.Ellipsoid.WGS84.minimumRadius,
        ),
        scene.camera.positionWC,
      );
      for (const group of groupWindPaths(paths)) {
        const cellPositions = [];
        let cellVertexCount = 0;
        const instances = group.paths.map((path) => {
          const positions = path.coordinates.map(([lon, lat]) =>
            C.Cartesian3.fromDegrees(lon, lat, WIND_DISPLAY_HEIGHT_METERS),
          );
          // Pass the native description to Cesium's worker. Per-instance seed
          // attributes avoid touching the expanded vertex buffer on the UI thread.
          const geometry = new C.PolylineGeometry({
            positions,
            width: 2.4,
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
        const cell = {
          primitive,
          sphere: C.BoundingSphere.fromPoints(cellPositions),
          vertexCount: cellVertexCount,
        };
        cells.push(cell);
        collection.add(primitive);
        vertexCount += cellVertexCount;
      }
      diagnostics = {
        ...emptyDiagnostics(),
        cellCount: cells.length,
        pathCount: paths.length,
        vertexCount,
        buildMs: (globalThis.performance?.now?.() ?? Date.now()) - started,
        error: null,
      };
      return true;
    } catch (error) {
      clear();
      diagnostics.error =
        error instanceof Error ? error.message : 'Wind geometry unavailable';
      return false;
    }
  }

  // Cesium reuses its frustum culling volume and the occluder's scratch vectors.
  // This loop creates no positions, spheres, appearances or per-cell temporaries.
  function updateVisibility(camera) {
    const height = camera.positionCartographic.height;
    const heightFade = Math.max(
      0,
      Math.min(
        1,
        (height - WIND_FADE_LOW_METERS) /
          (WIND_FADE_HIGH_METERS - WIND_FADE_LOW_METERS),
      ),
    );
    diagnostics.heightFade = heightFade;
    if (material) material.uniforms.heightFade = heightFade;
    diagnostics.visibleCells = 0;
    diagnostics.visibleVertexCount = 0;
    let volume;
    if (heightFade > 0 && cells.length) {
      occluder.cameraPosition = camera.positionWC;
      volume = camera.frustum.computeCullingVolume(
        camera.positionWC,
        camera.directionWC,
        camera.upWC,
      );
    }
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      cell.primitive.show =
        heightFade > 0 &&
        occluder.isBoundingSphereVisible(cell.sphere) &&
        volume.computeVisibility(cell.sphere) !== C.Intersect.OUTSIDE;
      if (cell.primitive.show) {
        diagnostics.visibleCells++;
        diagnostics.visibleVertexCount += cell.vertexCount;
      }
    }
    return diagnostics.visibleCells > 0 && heightFade > 0;
  }

  return {
    supported,
    setField,
    updateVisibility,
    tick(elapsedSeconds) {
      if (material && !paused && Number.isFinite(elapsedSeconds))
        material.uniforms.phaseTime = Math.max(0, elapsedSeconds) % 10000;
    },
    setOptions(options = {}) {
      if (typeof options.paused === 'boolean') paused = options.paused;
      if (material) material.uniforms.ghostAlpha = paused ? 0.34 : 0.25;
    },
    clear,
    destroy() {
      clear();
      destroyed = true;
    },
    getParticleCount: () => diagnostics.pathCount,
    getDiagnostics: () => ({
      ...diagnostics,
      ready: cells.length > 0 && cells.every((cell) => cell.primitive.ready),
      mode: 'gpu-streamlines',
      displayHeightMeters: WIND_DISPLAY_HEIGHT_METERS,
    }),
  };
}
