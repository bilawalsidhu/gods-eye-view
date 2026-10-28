import { createChatGptAuth } from './agent/chatgpt/auth.js';
import { createChatGptAuthHandler } from './agent/chatgpt/routes.js';
import { sameSiteGated } from './common/same-site.js';
import {
  createAgentCommandHandler,
  createAgentConfigHandler,
  createAgentModelsHandler,
} from './agent/routes.js';

/**
 * Vite plugin: the typed agent relay.
 *
 * Endpoints:
 *   GET  /api/agent/config  - providers, defaults and prefix size
 *   GET  /api/agent/models  - capability-gated model list for one provider
 *   POST /api/agent/command - one model turn, tool calls validated before return
 *
 * All three refuse cross-site browser requests, like the other cost-bearing
 * endpoints (see server/providers/common/same-site.js and SECURITY.md), and
 * share a per-IP throttle (GEV_RATELIMIT_AGENT_PER_MIN).
 *
 * @param {{annotationGuidance?: string}} [options]
 */
function typedAgentProxy({ annotationGuidance } = {}) {
  const chatgpt = createChatGptAuth();
  function install(middlewares) {
    middlewares.use('/api/agent/chatgpt', createChatGptAuthHandler(chatgpt));
    middlewares.use(
      '/api/agent/config',
      sameSiteGated(createAgentConfigHandler({ chatgpt })),
    );
    middlewares.use(
      '/api/agent/models',
      sameSiteGated(createAgentModelsHandler({ chatgpt })),
    );
    middlewares.use(
      '/api/agent/command',
      sameSiteGated(createAgentCommandHandler({ annotationGuidance, chatgpt })),
    );
  }

  return {
    name: 'typed-agent-proxy',
    configureServer: (server) => {
      install(server.middlewares);
      server.httpServer?.once('close', () => chatgpt.close());
    },
    configurePreviewServer: (server) => {
      install(server.middlewares);
      server.httpServer?.once('close', () => chatgpt.close());
    },
  };
}

export { typedAgentProxy };
