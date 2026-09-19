/**
 * server/serverless/tools-route.js — `GET /api/tools` (catalogue) and
 * `GET /api/tools/<name>?…` (invoke) for every tool in server/tools/registry.js.
 *
 * Served by the existing catch-all function (api/[...route].js) in BOTH the
 * serverless app and the local dev server — no new Vercel function. The
 * response envelope is deliberately small and stable so an OnDemand REST-API
 * agent (dashboard "REST API" plugin fed with docs/plugins/<plugin>/openapi.json)
 * can consume it:
 *
 *   200 { ok: true,  tool, params, data, provider?, provenance?, generatedAtUtc }
 *   4xx { ok: false, tool, error: { code, message, param? } }      (validation)
 *   5xx { ok: false, tool, error: { code, message } }              (upstream)
 *
 * Unknown parameters are a 400 `unknown_param` (server/sources/_shared.js
 * validateParams), exactly like the Gate 3 earthquake adapter. Nothing here
 * ever echoes an env var value; upstream keys never leave the server.
 */
import { validateParams, isoUtc } from '../sources/_shared.js';
import { toolIndex, toolCatalogue } from '../tools/registry.js';

function send(res, req, status, body, { cacheSeconds = 0 } = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    status === 200 && cacheSeconds > 0
      ? `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`
      : 'no-store',
  );
  res.setHeader('X-Tools-Route', 'ondemand-spatial');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(body));
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date, index?: Map<string, object> }} [options]
 */
export function createToolsHandler({
  env = process.env,
  now = () => new Date(),
  index = null,
} = {}) {
  const tools = index || toolIndex();
  return async function toolsHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      send(res, req, 405, {
        ok: false,
        error: { code: 'method_not_allowed', message: 'GET or HEAD only' },
      });
      return;
    }
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const segments = requestUrl.pathname.split('/').filter(Boolean);
    const name = segments.length ? decodeURIComponent(segments[0]) : '';

    if (!name) {
      send(
        res,
        req,
        200,
        { ok: true, tools: toolCatalogue(), generatedAtUtc: isoUtc(now()) },
        { cacheSeconds: 300 },
      );
      return;
    }
    const tool = tools.get(name);
    if (!tool) {
      send(res, req, 404, {
        ok: false,
        tool: name,
        error: {
          code: 'unknown_tool',
          message: `unknown tool "${name}"; available: ${[...tools.keys()].join(', ')}`,
        },
      });
      return;
    }
    const validated = validateParams(
      Object.fromEntries(requestUrl.searchParams.entries()),
      tool.params || {},
    );
    if (!validated.ok) {
      send(res, req, validated.status, {
        ok: false,
        tool: name,
        error: validated.error,
      });
      return;
    }
    const controller = new AbortController();
    if (typeof req.on === 'function') req.on('close', () => controller.abort());
    try {
      const result = await tool.handler(validated.params, {
        signal: controller.signal,
        env,
        now,
        requestUrl,
        tool: name,
      });
      if (!result || result.ok === false) {
        const status = Number(result?.status) || 502;
        send(res, req, status, {
          ok: false,
          tool: name,
          error: result?.error || {
            code: 'tool_failed',
            message: `${name} returned no result`,
          },
          ...(result?.provider ? { provider: result.provider } : {}),
        });
        return;
      }
      send(
        res,
        req,
        Number(result.status) || 200,
        {
          ok: true,
          tool: name,
          params: validated.params,
          data: result.data ?? null,
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.provenance ? { provenance: result.provenance } : {}),
          generatedAtUtc: isoUtc(now()),
        },
        { cacheSeconds: Number(tool.cacheSeconds) || 0 },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn(`[tools] ${name} failed:`, error?.message || error);
      send(res, req, 502, {
        ok: false,
        tool: name,
        error: {
          code: 'tool_failed',
          message: `${name} failed: ${String(error?.message || 'error').slice(0, 160)}`,
        },
      });
    }
  };
}

/** Mount the tools route on a Connect-compatible router. */
export function mountToolsRoute(router, options) {
  router.use('/api/tools', createToolsHandler(options));
}
