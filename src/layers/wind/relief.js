// View-directed display lighting over existing terrain normals. This does not
// represent the Sun, change terrain geometry, or supply missing elevation data.
function reliefSource(terrainNormals) {
  const normal = terrainNormals
    ? 'vec3 normal = normalize(materialInput.normalEC);'
    : `vec3 worldPosition = (czm_inverseView * vec4(-materialInput.positionToEyeEC, 1.0)).xyz;
    vec3 geodeticNormal = normalize(worldPosition * czm_ellipsoidInverseRadii * czm_ellipsoidInverseRadii);
    vec3 normal = normalize(czm_viewRotation * geodeticNormal);`;
  return `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    ${normal}
    vec3 displayLight = normalize(vec3(-0.45, 0.55, 0.8));
    float shade = clamp((1.0 - dot(normal, displayLight)) * 0.32, 0.0, 0.28);
    material.diffuse = vec3(0.0);
    material.alpha = shade;
    return material;
}
`;
}

/** Optional, exclusive globe-material owner; no animation or source acquisition. */
export function createWindRelief({ cesium, getViewer } = {}) {
  let globe = null;
  let scene = null;
  let owned = null;
  let previous = undefined;
  let destroyed = false;
  let reason = 'Not attached';
  let mode = null;
  const alive = (value) => value && !value.isDestroyed?.();
  const active = () =>
    Boolean(owned && alive(globe) && globe.material === owned);

  function clear() {
    const changed = active();
    if (changed) globe.material = previous;
    if (owned && !owned.isDestroyed?.()) owned.destroy?.();
    if (changed && alive(scene)) scene.requestRender?.();
    owned = null;
    mode = null;
    globe = null;
    scene = null;
    previous = undefined;
    reason = destroyed ? 'Destroyed' : 'Not attached';
  }

  return {
    attach() {
      if (destroyed) return false;
      const viewer = getViewer?.();
      const nextScene = alive(viewer) ? viewer.scene : null;
      const nextGlobe = nextScene?.globe;
      const nextMode =
        nextGlobe?.terrainProvider?.hasVertexNormals === true
          ? 'terrain relief'
          : 'globe curvature';
      if (active() && globe === nextGlobe && mode === nextMode) return true;
      clear();
      if (!alive(nextGlobe) || typeof cesium?.Material !== 'function') {
        reason = 'Globe material unavailable';
        return false;
      }
      if (nextGlobe.material != null) {
        reason = 'Globe material already owned';
        return false;
      }
      // Cesium excludes normal-dependent materials without terrain normals.
      // The fallback uses existing position/ellipsoid uniforms: curvature only,
      // never an invented terrain normal or an additional provider request.
      try {
        owned = new cesium.Material({
          fabric: {
            type:
              nextMode === 'terrain relief'
                ? 'GEVWindTerrainRelief'
                : 'GEVWindGlobeCurvature',
            source: reliefSource(nextMode === 'terrain relief'),
          },
          translucent: true,
        });
        mode = nextMode;
        globe = nextGlobe;
        scene = nextScene;
        previous = globe.material;
        globe.material = owned;
        scene.requestRender?.();
        reason = null;
        return true;
      } catch {
        clear();
        reason = 'Relief material unavailable';
        return false;
      }
    },
    clear,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clear();
    },
    getDiagnostics() {
      return {
        active: active(),
        reason: owned && !active() ? 'Globe material replaced' : reason,
        lighting: 'View-directed display shading',
        mode: active() ? mode : null,
        maxOpacity: 0.28,
      };
    },
  };
}
