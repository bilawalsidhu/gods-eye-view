import { defaultSourceRoot } from './common/source-root.js';
import { handleHudSummary } from './openai/hud-summary.js';
import { createDebugLogHandler } from './openai/debug-log.js';
import { createRealtimeTokenHandler } from './openai/realtime.js';
import { handleAiChat } from './openai/chat.js';

/**
 * Vite plugin: AI Provider proxy (OpenAI Realtime + Multi-Provider HUD & Voice).
 */
function openAiRealtimeProxy({
  sourceRoot = defaultSourceRoot,
  annotationGuidance,
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/openai/hud-summary', handleHudSummary);
    middlewares.use('/api/ai/hud-summary', handleHudSummary);
    middlewares.use('/api/ai/chat', handleAiChat);

    middlewares.use(
      '/api/realtime/debug-log',
      createDebugLogHandler({ sourceRoot }),
    );

    middlewares.use(
      '/api/realtime/token',
      createRealtimeTokenHandler({ annotationGuidance }),
    );
  }

  return {
    name: 'openai-realtime-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { openAiRealtimeProxy };
