import { createHamRepeatersMiddleware } from './ham-repeaters/catalog.js';
import {
  createHamrigRepeaterProvider,
  parseHamRepeatersEnv,
} from './ham-repeaters/hamrig.js';
import { HAM_REPEATERS_MOUNT_PATH } from './ham-repeaters/constants.js';

export {
  createHamRepeatersMiddleware,
  parseRepeaterSearch,
  repeaterSearchKey,
} from './ham-repeaters/catalog.js';
export {
  createHamrigRepeaterProvider,
  fetchHamrigJson,
  normalizeHamrigBaseUrl,
  parseHamRepeatersEnv,
} from './ham-repeaters/hamrig.js';
export { HAM_REPEATERS_MOUNT_PATH } from './ham-repeaters/constants.js';

/**
 * Amateur-radio repeaters around a point, served under `/api/ham-repeaters`.
 * The adapters are built once on first use from the operator's environment
 * (`HAMRIG_ENABLED`, `HAMRIG_BASE_URL`, `HAM_REPEATERS_HAMRIG_FM`).
 */
export function hamRepeatersProxy(env = process.env, options = {}) {
  const config = parseHamRepeatersEnv(env);
  let middleware = null;
  const handler = (req, res, next) => {
    if (!middleware) {
      const providers = config.enabled
        ? [
            createHamrigRepeaterProvider({
              baseUrl: config.baseUrl,
              fmEnabled: config.fmEnabled,
              fetchImpl: options.fetchImpl,
              log: options.log,
            }),
          ]
        : [];
      middleware = createHamRepeatersMiddleware({
        providers,
        enabled: config.enabled,
        now: options.now,
        log: options.log,
      });
    }
    return middleware(req, res, next);
  };
  const install = (server) => {
    server.middlewares.use(HAM_REPEATERS_MOUNT_PATH, handler);
  };
  return {
    name: 'ham-repeaters-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
