import { createDataPackSession } from '../../director/packs/session.js';
import { createPackPresentations } from './presentation.js';

/** Bind selected shot packs to one viewer and expose copied lifecycle diagnostics. */
export function createSceneDataPacks(viewer, { sources = {} } = {}) {
  const targets = new Map();
  const session = createDataPackSession({
    sources,
    adapters: createPackPresentations(viewer, targets),
  });
  return {
    ...session,
    sourceIds: () => Object.keys(sources),
    getTargets: () => new Map(targets),
    apply(scene, shot, token) {
      const wanted = new Set(shot.dataPackIds || []);
      return session.load(
        (scene.dataPacks || []).filter((pack) => wanted.has(pack.id)),
        { anchors: scene.anchors, signal: token?.signal },
      );
    },
  };
}
