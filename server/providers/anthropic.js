import { createAnthropicChatHandler } from './anthropic/chat.js';

/** Typed chat only: Anthropic has no live voice API, so there is no token route. */
function anthropicChatProxy({ annotationGuidance, realtime = {} } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/anthropic/chat',
      createAnthropicChatHandler({ ...realtime, annotationGuidance }),
    );
  }
  return {
    name: 'anthropic-chat-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { anthropicChatProxy };
