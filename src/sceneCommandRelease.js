/**
 * Let a turned-off layer's memory go.
 *
 * Cesium (engine 22.3, `Scene/View.js`) reuses each view's per-pass command
 * arrays: every frame resets `frustumCommands.indices[pass]` to 0 and
 * overwrites `commands[pass][i]` from the start. `Scene.js` truncates the
 * voxel, Gaussian-splat and translucent passes to their counts; the opaque
 * and other passes keep the slots past the new count. When a layer is turned
 * off the next frame has fewer commands, so that tail keeps the destroyed
 * primitives' DrawCommands, and through `_owner` → primitive → entity →
 * EntityCollection the whole data source stays reachable. The offscreen view
 * `scene.sampleHeight` / `pickFromRay` render into keeps its last list the
 * same way, until the next height sample.
 *
 * Measured (production build, heap after GC, Data Centers on → off): 116 MiB
 * kept on main, 13 MiB with this module; heap snapshots traced the entities
 * through `View.frustumCommandsList` and `Picking._pickOffscreenView`.
 *
 * After a layer finishes turning off, this renders one frame, trims the main
 * view's arrays to that frame's counts, and empties the offscreen pick view's
 * lists (it rebuilds them in full on every pick). It reads private Cesium
 * fields: `src/sceneCommandRelease.test.mjs` fails if any of them is renamed
 * or if Cesium changes which passes it truncates, and once Cesium clears the
 * tail itself this module can go.
 */

/** Drop command references a view no longer draws. */
function trimView(view, { keepCurrent }) {
  for (const frustum of view?.frustumCommandsList || []) {
    const { commands, indices } = frustum;
    for (let pass = 0; pass < commands.length; pass += 1) {
      const keep = keepCurrent ? indices[pass] : 0;
      if (commands[pass].length > keep) commands[pass].length = keep;
      if (!keepCurrent) indices[pass] = 0;
    }
  }
  if (!keepCurrent)
    for (const extent of view?._commandExtents || [])
      extent.command = undefined;
}

/**
 * Release stale command references in the scene's main view (keeping what
 * the last frame drew) and in its offscreen pick view (all of it).
 * @param {object} scene Cesium Scene, right after a render.
 */
export function trimStaleSceneCommands(scene) {
  trimView(scene._defaultView, { keepCurrent: true });
  trimView(scene._picking?._pickOffscreenView, { keepCurrent: false });
}

/**
 * After every layer disable, render one frame and trim once it is drawn.
 * @param {{scene: object, dataManager: object, requestRender: (reason: string) => void}} deps
 * @returns {() => void} uninstall
 */
export function installLayerReleaseTrim({ scene, dataManager, requestRender }) {
  let removeOneShot = null;
  const unsubscribe = dataManager.subscribe((change) => {
    if (change?.type !== 'visibility' || change.enabled !== false) return;
    if (removeOneShot) return; // a trim is already waiting for its frame
    removeOneShot = scene.postRender.addEventListener(() => {
      removeOneShot();
      removeOneShot = null;
      trimStaleSceneCommands(scene);
    });
    requestRender('layer-release-trim');
  });
  return () => {
    unsubscribe();
    removeOneShot?.();
    removeOneShot = null;
  };
}
