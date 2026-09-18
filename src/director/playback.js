/**
 * Build an ordered shot queue, starting at a scene and optionally wrapping.
 * Scene and shot objects are opaque to the runner apart from their identifiers.
 * @param {Array<{id:string, shots:Object[]}>} scenes
 * @param {string} startSceneId
 * @param {{single?:boolean}} [options]
 * @returns {Array<{scene:Object, shot:Object}>}
 */
export function buildPlaybackQueue(
  scenes,
  startSceneId,
  { single = false } = {},
) {
  const start = Math.max(
    0,
    scenes.findIndex((scene) => scene.id === startSceneId),
  );
  const ordered = single
    ? scenes.slice(start, start + 1)
    : [...scenes.slice(start), ...scenes.slice(0, start)];
  return ordered.flatMap((scene) =>
    scene.shots.map((shot) => ({ scene, shot })),
  );
}

/**
 * Run ordered shots through an application-supplied playback adapter.
 *
 * Each phase receives {scene, shot, index, total, token}. The adapter owns
 * camera/rendering resources and must observe token.signal or token.cancelled
 * while awaiting work. The runner rechecks both after every phase; it cannot
 * interrupt an adapter that ignores cancellation. No timers, UI, storage,
 * renderer or authored content are imported here.
 *
 * releaseScene(scene, token?) leaves a previously loaded scene before playback
 * (false refuses that initial handoff). Between scenes and during final cleanup
 * it receives no cancelled token, so resource release can finish after Stop.
 * An empty/already-cancelled queue acquires and releases no resources.
 *
 * @param {Array<{scene:Object, shot:Object}>} queue Normalized, fixed shot queue.
 * @param {Object} options
 * @param {{cancelled?:boolean, signal?:AbortSignal}} options.token Run lifetime.
 * @param {Object} options.adapter selectShot/applyVisual/applyLayers/travel/
 * settle/hold/completeShot callbacks, releaseScene and optional complete.
 * @param {Object|null} [options.previousScene=null] Previously loaded scene.
 * @param {boolean} [options.releaseOnFinish=true] Release the final scene.
 * @returns {Promise<{status:'completed'|'cancelled', completedShots:number}>}
 */
export async function playSceneQueue(
  queue,
  { token, adapter, previousScene = null, releaseOnFinish = true },
) {
  const cancelled = () => Boolean(token.cancelled || token.signal?.aborted);
  let activeScene = null;
  let completedShots = 0;
  try {
    if (!queue.length || cancelled()) {
      return {
        status: cancelled() ? 'cancelled' : 'completed',
        completedShots,
      };
    }
    if (previousScene && previousScene.id !== queue[0].scene.id) {
      const released = await adapter.releaseScene(previousScene, token);
      if (!released)
        throw new Error(`Could not leave scene: ${previousScene.title}`);
    }
    for (let index = 0; index < queue.length && !cancelled(); index++) {
      const { scene, shot } = queue[index];
      if (activeScene && activeScene.id !== scene.id) {
        await adapter.releaseScene(activeScene);
        activeScene = null;
        if (cancelled()) break;
      }
      activeScene = scene;
      const context = { scene, shot, index, total: queue.length, token };
      for (const phase of SHOT_PHASES) {
        if (cancelled()) break;
        await adapter[phase](context);
      }
      if (!cancelled()) completedShots++;
    }
    if (!cancelled()) await adapter.complete?.();
    return { status: cancelled() ? 'cancelled' : 'completed', completedShots };
  } finally {
    if (releaseOnFinish && activeScene) await adapter.releaseScene(activeScene);
  }
}

const SHOT_PHASES = [
  'selectShot',
  'applyVisual',
  'applyLayers',
  'travel',
  'settle',
  'hold',
  'completeShot',
];

export {
  sceneTimingForShot,
  sceneSeekState,
  cameraAtProgress,
} from './timeline.js';
export { createPlaybackClock } from './clock.js';

export {
  parseSceneDocument,
  validateSceneDocument,
  stringifySceneDocument,
  SceneDocumentError,
  SCENE_DOCUMENT_VERSION,
  SCENE_DOCUMENT_LIMITS,
} from './document.js';

export {
  resolveCameraPose,
  resolveCameraMove,
  sampleCameraMove,
} from './camera.js';

export { createAssetDirectorySource } from './packs/source.js';
export { createDataPackSession } from './packs/session.js';
export { validateDataPack, PACK_LIMITS } from './packs/manifest.js';

export { createInteractionSession } from './interactions/session.js';

export {
  parseSceneShare,
  readSceneShare,
  createSceneBundle,
  createBundleAssets,
  BUNDLE_SOURCE,
  SHARE_LIMITS,
} from './sharing/bundle.js';
export { describeSceneShare } from './sharing/preview.js';
export { editSceneDetails, selectSceneDocument } from './authoring.js';
