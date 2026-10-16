// Every private Navara member the engine relies on, in one place. Written
// against @navaramap/three 0.2.1 (package.json pins it exactly; the test in
// internals.test.mjs fails if the two drift apart): re-check each access below
// before moving to another Navara version. Each names the parity spike that
// found it and the public API that would replace it upstream.

import { ModelMesh } from '@navaramap/three';
import { patchCascadedLightCopy } from './cascadedLightCopy.js';

export const NAVARA_INTERNALS_VERSION = '0.2.1';

let restoreRelease = null;

/**
 * S2: keep 3D-tile positions and indices on the CPU after upload so the
 * surface ray can hit them. Private: ModelMesh.prototype._releaseGeometryArrays,
 * which frees every attribute array once the tile is on the GPU. Patched on
 * the prototype, for all views; idempotent. Upstream ask: an option to retain
 * tile geometry for ray queries, or a sampleHeight/pickRay over 3D tiles.
 * Throws when the member is gone (another Navara version).
 */
export function retainTileGeometry() {
  if (restoreRelease) return restoreRelease;
  const proto = ModelMesh.prototype;
  const release = proto._releaseGeometryArrays;
  if (typeof release !== 'function')
    throw new Error('ModelMesh._releaseGeometryArrays not found');
  proto._releaseGeometryArrays = function releaseAllButPositions(mesh) {
    const geometry = mesh.geometry;
    const position = geometry?.attributes?.position;
    const index = geometry?.index ?? null;
    if (!position) return release.call(this, mesh);
    delete geometry.attributes.position;
    geometry.index = null;
    try {
      return release.call(this, mesh);
    } finally {
      geometry.attributes.position = position;
      geometry.index = index;
    }
  };
  restoreRelease = () => {
    proto._releaseGeometryArrays = release;
    restoreRelease = null;
  };
  return restoreRelease;
}

/**
 * S2: the loaded 3D-tile roots (ModelMesh objects). Private: view._scenes.mrt,
 * the scene Navara renders tiles into. Upstream ask: as for
 * retainTileGeometry.
 */
export function tileRoots(view) {
  return (view._scenes?.mrt?.children ?? []).filter(
    (object) => object instanceof ModelMesh,
  );
}

/**
 * S2/S5: whether Navara has stopped updating (tiles loaded, camera still).
 * Private: view._isIdle, which the public `idle` event reports only as an
 * edge. Upstream ask: a public isIdle/tilesLoaded getter.
 */
export function isIdle(view) {
  return view._isIdle === true;
}

/**
 * The cinematic look's atmosphere scale (look.js createLuminanceScaler):
 * the radiance-to-luminance factor uniforms of the takram materials behind
 * the look's sky, stars, aerial perspective and clouds handles. Private:
 * - sky, stars: handle.ref.raw (the three object) .material.uniforms;
 * - aerial perspective: handle.ref.raw.rawEffect.uniforms (a Map);
 * - clouds: handle.ref.raw.rawEffect.cloudsPass.currentMaterial.uniforms
 *   (the clouds swap that material when their quality changes).
 * Calls `visit(key, uniform, scaled)` for each, scaled false for the stars.
 * A handle whose object is built but has lost a path fails loudly: it
 * throws in the dev server and warns once in a build. Upstream ask: a sky
 * luminance or atmosphere exposure that leaves unlit content alone.
 */
export const LUMINANCE_UNIFORMS = Object.freeze([
  'SUN_SPECTRAL_RADIANCE_TO_LUMINANCE',
  'SKY_SPECTRAL_RADIANCE_TO_LUMINANCE',
]);
const DEV = Boolean(import.meta.env?.DEV);
const reported = new Set();

function luminancePathLost(name) {
  const message = `Navara ${NAVARA_INTERNALS_VERSION}: the ${name} luminance uniforms are not where internals.js expects them`;
  if (DEV) throw new Error(message);
  if (reported.has(name)) return;
  reported.add(name);
  console.warn(`[globe] ${message}; the atmosphere stays unscaled there`);
}

function visitLuminance(name, raw, uniforms, scaled, visit) {
  if (!raw) return; // not built yet
  const get = (key) =>
    uniforms instanceof Map ? uniforms.get(key) : uniforms?.[key];
  const sun = get(LUMINANCE_UNIFORMS[0]);
  const sky = get(LUMINANCE_UNIFORMS[1]);
  if (!sun?.value?.isVector3 || !sky?.value?.isVector3) {
    luminancePathLost(name);
    return;
  }
  visit(LUMINANCE_UNIFORMS[0], sun, scaled);
  visit(LUMINANCE_UNIFORMS[1], sky, scaled);
}

export function forEachLuminanceUniform(handles, visit) {
  const sky = handles.sky?.ref?.raw;
  visitLuminance('sky', sky, sky?.material?.uniforms, true, visit);
  const stars = handles.stars?.ref?.raw;
  visitLuminance('stars', stars, stars?.material?.uniforms, false, visit);
  const aerial = handles.aerialPerspective?.ref?.raw;
  visitLuminance(
    'aerial perspective',
    aerial,
    aerial?.rawEffect?.uniforms,
    true,
    visit,
  );
  const clouds = handles.clouds?.ref?.raw;
  visitLuminance(
    'clouds',
    clouds,
    clouds?.rawEffect?.cloudsPass?.currentMaterial?.uniforms,
    true,
    visit,
  );
}

/**
 * Phase 3 review (leak): the sun's cascaded shadow lights are re-cloned by
 * the transparent pass every frame (cascadedLightCopy.js). Finds the
 * CascadedDirectionalLights class among the view's scene lights (private:
 * view._scenes.light) and patches its copy to update in place. Returns the
 * restore function, or null when the look has no cascaded light (the
 * cinematic sun casts no shadow). Upstream ask: copy cascaded lights in
 * place.
 */
export function keepCascadedLightIds(view) {
  const lights = view._scenes?.light?.children ?? [];
  const cascaded = lights.find((light) => Array.isArray(light?.cascadedLights));
  return cascaded
    ? patchCascadedLightCopy(Object.getPrototypeOf(cascaded))
    : null;
}

/** The hooks createNavaraEngine takes. */
export const navaraHooks = (view) => ({
  retainTileGeometry,
  tileRoots: () => tileRoots(view),
  isIdle: () => isIdle(view),
});
