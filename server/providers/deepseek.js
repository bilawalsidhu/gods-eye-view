import { GEV_REALTIME_TOOLS } from './openai/tools.js';
import { enforceOptInRateLimit } from './openai/rate-limit.js';
import { makeOptInRateLimiter } from './common/rate-limit.js';
import { readRequestBody } from './common/request.js';

const DEEPSEEK_HUD_SUMMARY_MODEL_DEFAULT = 'deepseek-flash';
const DEEPSEEK_COMMAND_MODEL_DEFAULT = 'deepseek-flash';
const DEEPSEEK_API_BASE = 'https://api.deepseek.com';

// Built LAZILY on first request (not at module load) for the same reason as
// openai/rate-limit.js: loadEnv applies `.env` values to process.env AFTER this
// module is imported, so reading the env here at import time would always see
// it unset. `null` = unlimited (default).
let _deepseekRateLimiter;

/** DeepSeek cost endpoints (chat + hud-summary). Null = unlimited (default). */
function deepseekRateLimiter() {
  if (_deepseekRateLimiter === undefined)
    _deepseekRateLimiter = makeOptInRateLimiter(
      process.env.GEV_RATELIMIT_DEEPSEEK_PER_MIN,
    );
  return _deepseekRateLimiter;
}

function deepseekConfigured() {
  return Boolean(String(process.env.DEEPSEEK_API_KEY ?? '').trim());
}

/**
 * Re-wrap the canonical GEV tools (OpenAI Realtime `{type,name,description,
 * parameters}` shape) into DeepSeek's OpenAI-compatible chat-completions
 * `{type:'function', function:{name,description,parameters}}` shape.
 */
function deepseekFunctionTools() {
  return GEV_REALTIME_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

async function handleDeepseekStatus(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  const configured = deepseekConfigured();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      configured,
      model: configured
        ? process.env.DEEPSEEK_COMMAND_MODEL || DEEPSEEK_COMMAND_MODEL_DEFAULT
        : null,
    }),
  );
}

async function handleDeepseekChat(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const dsKey = process.env.DEEPSEEK_API_KEY;
  if (!String(dsKey ?? '').trim()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'DEEPSEEK_API_KEY is not set' }));
    return;
  }

  if (!enforceOptInRateLimit(deepseekRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 32 * 1024);
    const payload = JSON.parse(body || '{}');
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const wantStream = Boolean(payload.stream);

    const tools =
      Array.isArray(payload.tools) && payload.tools.length > 0
        ? payload.tools
        : deepseekFunctionTools();

    const deepseekPayload = {
      model:
        process.env.DEEPSEEK_COMMAND_MODEL || DEEPSEEK_COMMAND_MODEL_DEFAULT,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 2048,
      temperature: 0.3,
      stream: wantStream,
    };

    const upstream = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dsKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(deepseekPayload),
    });

    if (wantStream) {
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      const reader = upstream.body?.getReader?.();
      if (!reader) {
        res.end();
        return;
      }
      const pump = async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      const data = await upstream.json().catch(() => ({}));
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(data));
    }
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ error: error?.message || 'DeepSeek chat request failed' }),
    );
  }
}

function extractDeepSeekResponseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/**
 * DeepSeek HUD summary. Delegated to by the OpenAI hud-summary handler when no
 * OPENAI_API_KEY is set but DEEPSEEK_API_KEY is, mirroring the OpenAI 5-word
 * tactical summary through DeepSeek's chat-completions endpoint.
 */
async function handleDeepseekHudSummary(req, res) {
  if (!enforceOptInRateLimit(deepseekRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const response = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:
          process.env.DEEPSEEK_HUD_SUMMARY_MODEL ||
          DEEPSEEK_HUD_SUMMARY_MODEL_DEFAULT,
        messages: [
          {
            role: 'system',
            content: [
              "Write one concise intelligence-HUD summary for God's Eye View.",
              'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
              'Prefer the clearest named place and include a relevant enabled layer only when useful.',
              'Do not infer from coordinates or invent a place.',
              'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
            ].join(' '),
          },
          { role: 'user', content: JSON.stringify(context) },
        ],
        max_tokens: 100,
        temperature: 0,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(extractDeepSeekResponseText(data));
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        summary: summary || null,
        error: response.ok
          ? null
          : data.error?.message || 'DeepSeek HUD summary request failed',
      }),
    );
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: error?.message || 'DeepSeek HUD summary request failed',
      }),
    );
  }
}

/** Vite plugin: DeepSeek chat + status endpoints for the client chat panel. */
function deepseekProxy() {
  function install(middlewares) {
    middlewares.use('/api/deepseek/status', handleDeepseekStatus);
    middlewares.use('/api/deepseek/chat', handleDeepseekChat);
  }
  return {
    name: 'deepseek-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export {
  deepseekProxy,
  handleDeepseekHudSummary,
  deepseekRateLimiter,
  deepseekConfigured,
};

