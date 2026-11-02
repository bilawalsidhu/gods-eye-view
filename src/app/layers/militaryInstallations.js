import { overlayHost } from './overlayHost.js';
import * as credits from '../../data/dataCredits.js';
import { createInstallationsLayer } from '../../layers/installations/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationInstallations({ surface, source }) {
  const { groundFloor: ground, anchors } = surface;
  return createInstallationsLayer({
    source,
    overlayHost,
    services: {
      credits,
      render,
      context,
      ground,
      anchors,
      picking,
      maps: {
        subscribeMapStack(callback) {
          globalThis.window?.addEventListener?.(
            'gev:map-stack-changed',
            callback,
          );
          return () =>
            globalThis.window?.removeEventListener?.(
              'gev:map-stack-changed',
              callback,
            );
        },
      },
    },
  });
}
