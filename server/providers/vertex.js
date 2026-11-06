import { createVertexChatHandler } from './vertex/chat.js';

/** Typed chat only: Vertex AI Express Mode has no Live models, so there is no token route. */
function vertexChatProxy({ annotationGuidance, realtime = {} } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/vertex/chat',
      createVertexChatHandler({ ...realtime, annotationGuidance }),
    );
  }
  return {
    name: 'vertex-chat-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { vertexChatProxy };
