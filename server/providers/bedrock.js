import { createBedrockChatHandler } from './bedrock/chat.js';

/** Typed chat only: Amazon Bedrock has no realtime voice API, so there is no token route. */
function bedrockChatProxy({ annotationGuidance, realtime = {} } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/bedrock/chat',
      createBedrockChatHandler({ ...realtime, annotationGuidance }),
    );
  }
  return {
    name: 'bedrock-chat-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { bedrockChatProxy };
