import { createGeminiTokenHandler } from './gemini/realtime.js';

/** Mint constrained Live API credentials; the permanent key stays on Node. */
function geminiLiveProxy({ annotationGuidance, realtime = {} } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/gemini/token',
      createGeminiTokenHandler({ ...realtime, annotationGuidance }),
    );
  }
  return {
    name: 'gemini-live-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { geminiLiveProxy };
