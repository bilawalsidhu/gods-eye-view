import { createDataPackSession } from '../../director/packs/session.js';
import { createPackPresentations } from './presentation.js';

/** Bind selected shot packs to one engine and expose copied lifecycle diagnostics. */
export function createSceneDataPacks(
  engine,
  { sources = {}, container = engine?.host?.container } = {},
) {
  const targets = new Map();
  const presentations = createPackPresentations(engine, targets, {
    container,
  });
  const session = createDataPackSession({
    sources,
    adapters: presentations,
  });
  return {
    ...session,
    setScene: presentations.setScene,
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
