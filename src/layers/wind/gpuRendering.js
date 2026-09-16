import {
  bakeWindStreamlines,
  WIND_DISPLAY_HEIGHT_METERS,
  WIND_PATH_LIMIT,
  WIND_NARROW_PATH_LIMIT,
} from './streamlines.js';

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
    material.alpha = (ghostAlpha + 0.64 * tail + 0.16 * tip) * ends * edge * horizon;
    return material;
}`;

/** Native Cesium geometry/material owner. No animation loop or DOM ownership. */
export function createWindGpuRendering({ cesium: C, getViewer }) {
  let primitive = null;
  let collection = null;
  let material = null;
  let paused = false;
  let destroyed = false;
  let diagnostics = { pathCount: 0, vertexCount: 0, buildMs: 0, error: null };

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
        C?.Cartesian3?.fromDegrees,
      ) &&
      (C.SceneMode?.SCENE3D === undefined ||
        scene.mode === undefined ||
        scene.mode === C.SceneMode.SCENE3D)
    );
  }

  function clear() {
    if (primitive) {
      collection?.remove(primitive);
      if (!primitive.isDestroyed?.()) primitive.destroy?.();
    }
    primitive = null;
    collection = null;
    material?.destroy?.();
    material = null;
    diagnostics = { pathCount: 0, vertexCount: 0, buildMs: 0, error: null };
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
      const instances = paths.map((path) => {
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
        vertexCount += positions.length * 4 - 4;
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
      material = new C.Material({
        fabric: {
          type: 'GevWindStreamline',
          uniforms: { phaseTime: 0, ghostAlpha: paused ? 0.34 : 0.25 },
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
      const appearance = new C.PolylineMaterialAppearance({
        material,
        vertexShaderSource,
        translucent: true,
        renderState: { depthTest: { enabled: true }, depthMask: false },
      });
      primitive = new C.Primitive({
        geometryInstances: instances,
        appearance,
        asynchronous: true,
        allowPicking: false,
        releaseGeometryInstances: true,
        compressVertices: false,
      });
      collection = getViewer().scene.primitives;
      collection.add(primitive);
      diagnostics = {
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

  return {
    supported,
    setField,
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
      ready: Boolean(primitive?.ready),
      mode: 'gpu-streamlines',
      displayHeightMeters: WIND_DISPLAY_HEIGHT_METERS,
    }),
  };
}
