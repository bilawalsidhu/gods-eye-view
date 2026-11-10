// Every private Navara member the engine relies on, in one place. Written
// against @navaramap/three 0.2.1 (package.json pins it exactly; the test in
// internals.test.mjs fails if the two drift apart): re-check each access below
// before moving to another Navara version. Each names the public API that
// would replace it upstream.

import { ModelMesh } from '@navaramap/three';
import { patchCascadedLightCopy } from './cascadedLightCopy.js';
import { dropOrphanFeatureChanges } from './featureQueue.js';

export const NAVARA_INTERNALS_VERSION = '0.2.1';

function requireMember(name, valid) {
  if (!valid)
    throw new Error(
      `Navara ${NAVARA_INTERNALS_VERSION}: required private member ${name} is missing or incompatible`,
    );
}

/** Fail at startup, before an absent internal can leave tilesLoaded false forever. */
export function assertNavaraInternals(view) {
  requireMember('view._isIdle', typeof view?._isIdle === 'boolean');
  requireMember(
    'view._startMainLoop',
    typeof view?._startMainLoop === 'function',
  );
  requireMember(
    'view._renderer.setAnimationLoop',
    typeof view?._renderer?.setAnimationLoop === 'function',
  );
  for (const name of ['mrt', 'light'])
    requireMember(
      `view._scenes.${name}.children`,
      Array.isArray(view?._scenes?.[name]?.children),
    );
  requireMember(
    'ModelMesh.prototype._releaseGeometryArrays',
    typeof ModelMesh.prototype._releaseGeometryArrays === 'function',
  );
  requireMember(
    'view._eventManager.stacks.renderable_feature_changed',
    Array.isArray(view?._eventManager?.stacks?.renderable_feature_changed),
  );
  requireMember(
    'view._eventManager.removeAt',
    typeof view?._eventManager?.removeAt === 'function',
  );
  const ctx = view?.viewContext;
  for (const name of ['findMesh', 'findEffect'])
    requireMember(
      `view.viewContext.${name}`,
      typeof ctx?.[name] === 'function',
    );
  pipelinePassNames(ctx);
  const handles = {};
  for (const name of ['sky', 'stars', 'aerialPerspective', 'clouds']) {
    const ref =
      name === 'sky' || name === 'stars'
        ? ctx.findMesh(name)
        : ctx.findEffect(name);
    if (!ref) continue; // This look does not use the descriptor.
    requireMember(`${name}.ref.raw`, ref.raw != null);
    handles[name] = { ref };
  }
  forEachLuminanceUniform(handles, () => {});
}

// Navara 0.2.1's animation=false still updates the tile tree every RAF.
// Until ThreeView exposes suspend/resume, stop its underlying Three loop
// while this view is parked and reinstall its normal loop when it returns.
export function setRenderLoopEnabled(view, enabled) {
  if (enabled) view._startMainLoop();
  else view._renderer.setAnimationLoop(null);
}

let restoreRelease = null;

/**
 * Keeps 3D-tile positions and indices on the CPU after upload so the
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
  requireMember(
    'ModelMesh.prototype._releaseGeometryArrays',
    typeof release === 'function',
  );
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
 * The loaded 3D-tile roots (ModelMesh objects). Private: view._scenes.mrt,
 * the scene Navara renders tiles into. Upstream ask: as for
 * retainTileGeometry.
 */
export function tileRoots(view) {
  return (view._scenes?.mrt?.children ?? []).filter(
    (object) => object instanceof ModelMesh,
  );
}

/**
 * Whether Navara has stopped updating (tiles loaded, camera still).
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
 * throws before scaling. Upstream ask: a sky
 * luminance or atmosphere exposure that leaves unlit content alone.
 */
const LUMINANCE_UNIFORMS = Object.freeze([
  'SUN_SPECTRAL_RADIANCE_TO_LUMINANCE',
  'SKY_SPECTRAL_RADIANCE_TO_LUMINANCE',
]);
function visitLuminance(name, raw, uniforms, scaled, visit) {
  if (!raw) return; // not built yet
  const get = (key) =>
    uniforms instanceof Map ? uniforms.get(key) : uniforms?.[key];
  const sun = get(LUMINANCE_UNIFORMS[0]);
  const sky = get(LUMINANCE_UNIFORMS[1]);
  if (!sun?.value?.isVector3 || !sky?.value?.isVector3) {
    requireMember(`${name} luminance uniforms`, false);
  }
  visit(LUMINANCE_UNIFORMS[0], sun, scaled);
  visit(LUMINANCE_UNIFORMS[1], sky, scaled);
}

export function forEachLuminanceUniform(handles, visit) {
  const sky = handles.sky?.ref?.raw;
  visitLuminance(
    'sky.ref.raw.material.uniforms',
    sky,
    sky?.material?.uniforms,
    true,
    visit,
  );
  const stars = handles.stars?.ref?.raw;
  visitLuminance(
    'stars.ref.raw.material.uniforms',
    stars,
    stars?.material?.uniforms,
    false,
    visit,
  );
  const aerial = handles.aerialPerspective?.ref?.raw;
  visitLuminance(
    'aerialPerspective.ref.raw.rawEffect.uniforms',
    aerial,
    aerial?.rawEffect?.uniforms,
    true,
    visit,
  );
  const clouds = handles.clouds?.ref?.raw;
  visitLuminance(
    'clouds.ref.raw.rawEffect.cloudsPass.currentMaterial.uniforms',
    clouds,
    clouds?.rawEffect?.cloudsPass?.currentMaterial?.uniforms,
    true,
    visit,
  );
}

/**
 * A leak: the sun's cascaded shadow lights are re-cloned by
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

/**
 * The view's queued feature changes, for featureQueue.js, or null. Navara
 * keeps a change for a feature it does not know in that queue for good, so
 * a deleted layer's late changes keep the view from going idle. Private:
 * view._eventManager (stacks, removeAt). Upstream ask: drop a deleted
 * layer's pending feature events, or skip them in needsUpdate.
 */
export function featureChangeQueue(view) {
  const manager = view._eventManager;
  const events = manager?.stacks?.renderable_feature_changed;
  return events
    ? {
        events,
        remove: (index) =>
          manager.removeAt('renderable_feature_changed', index),
      }
    : null;
}

/**
 * Navara's public camera.fov setter drops angles below one degree, although
 * the core supports them. Optical zoom needs the same frustum for drawing,
 * tile selection and picking. Upstream ask: accept every positive FOV.
 */
export function setCameraFovy(view, radians) {
  requireMember(
    'view._core.setFrustum',
    typeof view?._core?.setFrustum === 'function',
  );
  view._core.setFrustum((radians * 180) / Math.PI, undefined, undefined);
}

/** The hooks createNavaraEngine takes. */
export const navaraHooks = (view) => {
  assertNavaraInternals(view);
  return {
    retainTileGeometry,
    setCameraFovy: (radians) => setCameraFovy(view, radians),
    tileRoots: () => tileRoots(view),
    isIdle: () => isIdle(view),
    dropOrphanFeatureChanges: () =>
      dropOrphanFeatureChanges(
        featureChangeQueue(view),
        (id) => view.findLayerById(id) != null,
      ),
  };
};

/**
 * QA diagnostics only: the names of the passes in the view's
 * post-processing pipeline, in draw order.
 * Private: ctx.renderPassOrchestrator.passMap.list ({ name, pass }).
 * Upstream ask: a public read of the pipeline order.
 */
export function pipelinePassNames(ctx) {
  if (ctx == null) return null; // The optional effect has not been created.
  const list = ctx?.renderPassOrchestrator?.passMap?.list;
  requireMember('renderPassOrchestrator.passMap.list', Array.isArray(list));
  return list.map((entry) => entry.name);
}
