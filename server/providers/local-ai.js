import { localAiConfig } from '../../src/voice/localConfig.js';
import { admitKeySetupRequest } from '../../src/keySetupCore.mjs';
import { readRequestBody } from './common/request.js';
import { searchMcp } from './local-ai-mcp.js';

export function localAiProxy({ env = process.env, fetchImpl = fetch } = {}) {
  const respond = (res, code, payload) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
  };
  function install(middlewares) {
    middlewares.use('/api/ai/config', (req, res) => {
      if (req.method !== 'GET')
        return respond(res, 405, { error: 'Method not allowed' });
      try {
        const config = localAiConfig(env);
        respond(res, 200, {
          provider: config.provider,
          profile: config.profile,
          language: config.language,
          model: config.model,
          mcpEnabled: Boolean(config.mcpUrl),
        });
      } catch (error) {
        respond(res, 503, { error: error.message });
      }
    });
    middlewares.use('/api/local-ai', async (req, res) => {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (route !== '/search')
        return respond(res, 404, { error: 'Unknown local AI route' });
      if (req.method !== 'POST')
        return respond(res, 405, { error: 'Method not allowed' });
      const admission = admitKeySetupRequest({
        method: req.method,
        remoteAddress: req.socket?.remoteAddress,
        hostHeader: req.headers.host,
        protocol: req.socket?.encrypted ? 'https:' : 'http:',
        origin: req.headers.origin,
        contentType: req.headers['content-type'],
        proxyHeaders: req.headers,
        env,
      });
      if (!admission.ok)
        return respond(res, admission.status, { error: admission.error });
      const controller = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', cancel);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(180000),
      ]);
      try {
        const config = localAiConfig(env);
        if (config.provider !== 'local')
          return respond(res, 409, {
            error: 'Select Local in Provider Settings first',
          });
        const body = JSON.parse(await readRequestBody(req, 8192));
        if (route === '/search') {
          if (!config.mcpUrl)
            return respond(res, 409, { error: 'Search MCP is not configured' });
          if (
            typeof body.query !== 'string' ||
            !body.query.trim() ||
            body.query.length > 1000
          )
            return respond(res, 400, { error: 'Invalid search query' });
          return respond(
            res,
            200,
            await searchMcp({
              url: config.mcpUrl,
              tool: config.mcpTool,
              query: body.query,
              signal,
              fetchImpl,
            }),
          );
        }
      } catch (error) {
        if (!res.destroyed)
          respond(res, error instanceof SyntaxError ? 400 : 503, {
            error: error.message,
          });
      } finally {
        res.removeListener('close', cancel);
      }
    });
  }
  return {
    name: 'gev-local-ai',
    configureServer: (server) => install(server.middlewares),
    configurePreviewServer: (server) => install(server.middlewares),
  };
}
