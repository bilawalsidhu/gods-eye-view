import { defaultSourceRoot } from './common/source-root.js';
import { handleHudSummary } from './ollama/hud-summary.js';
import { attachVoiceWebSocket } from './ollama/voice.js';
import { installRemoteHub } from './ollama/remote.js';
import { VAD_ASSET_ROUTE, createVadAssetHandler } from './ollama/vad-assets.js';
import { createDebugLogHandler } from './openai/debug-log.js';
import { installFeatureRoutes } from './ollama/routes/index.js';
import { isTrustedOrigin } from './ollama/origin.js';

/** Local voice + HUD provider used when AI_PROVIDER=ollama. */
function ollamaProxy({ sourceRoot = defaultSourceRoot } = {}) {
  function install(middlewares, server) {
    middlewares.use('/api/openai/hud-summary', handleHudSummary);
    middlewares.use('/api/ollama/hud-summary', handleHudSummary);
    middlewares.use(
      '/api/realtime/debug-log',
      createDebugLogHandler({ sourceRoot }),
    );
    middlewares.use('/api/voice/config', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      // The wake-word key is meant for the browser engine, but only for pages
      // this server serves: DNS-rebinding or LAN pages get nothing.
      if (!isTrustedOrigin(req)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
      }
      res.end(
        JSON.stringify({
          provider: process.env.AI_PROVIDER || 'openai',
          wsPath: process.env.VOICE_WS_PATH || '/api/voice/ws',
          wakeWord: process.env.PICOVOICE_ACCESS_KEY
            ? {
                accessKey: process.env.PICOVOICE_ACCESS_KEY,
                keyword: process.env.WAKE_WORD || 'Computer',
              }
            : null,
        }),
      );
    });
    middlewares.use(VAD_ASSET_ROUTE, createVadAssetHandler());
    installFeatureRoutes(middlewares, server);
    attachVoiceWebSocket(server);
    // Phone / second-screen companion socket (remote.html); no-op without an
    // HTTP server, exactly like the voice socket above.
    installRemoteHub(server);
  }
  return {
    name: 'ollama-local-proxy',
    configureServer(server) {
      install(server.middlewares, server);
    },
    configurePreviewServer(server) {
      install(server.middlewares, server);
    },
  };
}

export { ollamaProxy };
