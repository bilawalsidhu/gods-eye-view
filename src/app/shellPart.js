import { catalogControlServices } from './catalog.js';

/**
 * The shell's scene part: the shell was built on `builtOn`, and each later
 * globe attaches to it with that globe's catalog. A switch detaches the
 * shell in 'shell-release' (the tools phase), before the data layers, as its
 * teardown always did; this part's detach covers an attachment that failed
 * before that part attached (a later part of a candidate engine) and is a
 * no-op once the shell has let go.
 */
export function shellScenePart(styleManager, { builtOn, catalog }) {
  let first = builtOn;
  return {
    name: 'shell',
    attachScene(next, { transaction } = {}) {
      if (next === first) {
        first = null;
        return;
      }
      first = null;
      return styleManager.attachScene(
        {
          viewer: next.viewer,
          engine: next.engine,
          mapStackController: next.mapStackController,
          services: catalogControlServices(next.catalog ?? catalog),
          engineSwitch: true,
        },
        transaction,
      );
    },
    detachScene: (options, transaction) =>
      styleManager.detachScene(options, transaction),
  };
}
