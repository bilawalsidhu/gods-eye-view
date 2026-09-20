import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import { createLlmStatusHandler } from './llm/status.js';

/**
 * Vite plugin: local-LLM health and model discovery.
 *
 * GET /api/llm/status → which text backend is configured (openai | ollama |
 *   llamacpp), whether it answers, and the models it reports. Optional
 *   ?provider= / ?baseUrl= let Provider Settings test a server BEFORE saving
 *   it; only local/private addresses may be probed that way.
 *
 * Dev-server only and loopback-only, sharing the Provider Settings admission
 * gate: this endpoint makes the host fetch a local address and reveals what
 * is running on it, which is nobody else's business. Prod builds never
 * register it, so the panel's probe simply fails and the section says so.
 */
function llmStatusProxy({ fetchImpl, timeoutMs } = {}) {
  const handler = createLlmStatusHandler({
    fetchImpl,
    timeoutMs,
    admit: (req) =>
      admitKeySetupRequest({
        method: req.method,
        remoteAddress: req.socket?.remoteAddress,
        hostHeader: req.headers?.host,
        protocol: req.socket?.encrypted ? 'https:' : 'http:',
        origin: req.headers?.origin,
        contentType: req.headers?.['content-type'],
        proxyHeaders: req.headers || {},
        env: process.env,
      }),
  });
  return {
    name: 'gev-llm-status',
    // Same window as Provider Settings itself: `vite preview` resolves with
    // command 'serve' too, so pin both conditions rather than relying on
    // which hook a future edit happens to use.
    apply: (_config, { command, isPreview }) =>
      command === 'serve' && !isPreview,
    configureServer(server) {
      server.middlewares.use('/api/llm/status', handler);
    },
  };
}

export { llmStatusProxy };
