import { GEV_REALTIME_TOOLS } from './openai/tools.js';
import { enforceRateLimit } from './openai/rate-limit.js';
import { makeCostRateLimiter } from './common/rate-limit.js';
import { readRequestBody } from './common/request.js';
import { sameSiteGated } from './common/same-site.js';

/**
 * OpenAI-compatible chat-completions providers for the text AI chat and the
 * HUD summary fallback. Each entry names its env vars only; values are read
 * per request because loadEnv applies `.env` to process.env after import.
 * `extraBody` is merged into every upstream request. Thinking is disabled on
 * both: tool calling works without it, and with it the 100-token HUD summary
 * is spent on reasoning and comes back with empty content.
 */
const AI_CHAT_PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    label: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    baseEnv: 'DEEPSEEK_API_BASE',
    defaultBase: 'https://api.deepseek.com',
    commandModelEnv: 'DEEPSEEK_COMMAND_MODEL',
    hudModelEnv: 'DEEPSEEK_HUD_SUMMARY_MODEL',
    defaultModel: 'deepseek-flash',
    extraBody: Object.freeze({ thinking: { type: 'disabled' } }),
  }),
  mimo: Object.freeze({
    label: 'MiMo',
    keyEnv: 'MIMO_API_KEY',
    // Token Plan keys (tp-/ttp-) need their regional base, e.g.
    // https://token-plan-sgp.xiaomimimo.com/v1.
    baseEnv: 'MIMO_API_BASE',
    defaultBase: 'https://api.xiaomimimo.com/v1',
    commandModelEnv: 'MIMO_COMMAND_MODEL',
    hudModelEnv: 'MIMO_HUD_SUMMARY_MODEL',
    defaultModel: 'mimo-v2.6-flash',
    extraBody: Object.freeze({ thinking: { type: 'disabled' } }),
  }),
});

const AI_CHAT_DEFAULT_PER_MIN = 60;

// Built LAZILY on first request for the same reason as openai/rate-limit.js:
// loadEnv applies `.env` values to process.env AFTER this module is imported.
// Shared across providers so switching provider cannot double the budget.
let _aiChatRateLimiter;

/** AI chat cost endpoints (chat + hud-summary). Null only when set to 0. */
function aiChatRateLimiter() {
  if (_aiChatRateLimiter === undefined)
    _aiChatRateLimiter = makeCostRateLimiter(
      envValue('GEV_RATELIMIT_AI_CHAT_PER_MIN') ||
        envValue('GEV_RATELIMIT_DEEPSEEK_PER_MIN'),
      AI_CHAT_DEFAULT_PER_MIN,
    );
  return _aiChatRateLimiter;
}

function envValue(name) {
  return String(process.env[name] ?? '').trim();
}

function providerConfigured(id) {
  const provider = AI_CHAT_PROVIDERS[id];
  return Boolean(provider && envValue(provider.keyEnv));
}

function configuredProviderIds() {
  return Object.keys(AI_CHAT_PROVIDERS).filter(providerConfigured);
}

/**
 * The provider used when a request names none: AI_CHAT_PROVIDER when it is
 * configured, otherwise the first configured provider in table order.
 */
function defaultProviderId() {
  const preferred = envValue('AI_CHAT_PROVIDER').toLowerCase();
  if (providerConfigured(preferred)) return preferred;
  return configuredProviderIds()[0] ?? null;
}

function aiChatConfigured() {
  return defaultProviderId() !== null;
}

function providerBase(provider) {
  return (envValue(provider.baseEnv) || provider.defaultBase).replace(
    /\/+$/,
    '',
  );
}

function postCompletion(provider, body) {
  return fetch(`${providerBase(provider)}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${envValue(provider.keyEnv)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...provider.extraBody, ...body }),
  });
}

/**
 * Re-wrap the canonical GEV tools (OpenAI Realtime `{type,name,description,
 * parameters}` shape) into the chat-completions
 * `{type:'function', function:{name,description,parameters}}` shape.
 */
function chatFunctionTools() {
  return GEV_REALTIME_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Drop `reasoning_content` from replayed history: a conversation can switch
 * provider mid-way, and not every provider accepts reasoning in its input.
 */
function sanitizeMessages(messages) {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const { reasoning_content: _reasoning, ...rest } = message;
    return rest;
  });
}

/**
 * Log a failed upstream call server-side only. Clients get a fixed message:
 * provider error bodies are never relayed (SECURITY.md, sanitized proxy errors).
 */
async function logUpstreamFailure(provider, what, response) {
  const detail = await response.text().catch(() => '');
  console.warn(
    `[ai-chat] ${provider.label} ${what} failed: HTTP ${response.status} ${detail.slice(0, 300)}`,
  );
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function handleAiChatStatus(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  const providers = configuredProviderIds().map((id) => {
    const provider = AI_CHAT_PROVIDERS[id];
    return {
      id,
      label: provider.label,
      model: envValue(provider.commandModelEnv) || provider.defaultModel,
    };
  });
  sendJson(res, 200, {
    configured: providers.length > 0,
    defaultProvider: defaultProviderId(),
    providers,
  });
}

async function handleAiChat(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (!aiChatConfigured()) {
    sendJson(res, 503, { error: 'No AI chat provider key is set' });
    return;
  }

  if (!enforceRateLimit(aiChatRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 32 * 1024);
    const payload = JSON.parse(body || '{}');
    const id =
      typeof payload.provider === 'string' && payload.provider
        ? payload.provider
        : defaultProviderId();
    if (!providerConfigured(id)) {
      sendJson(res, 400, { error: `AI chat provider "${id}" is not set up` });
      return;
    }
    const provider = AI_CHAT_PROVIDERS[id];
    const messages = Array.isArray(payload.messages)
      ? sanitizeMessages(payload.messages)
      : [];
    const wantStream = Boolean(payload.stream);

    const tools =
      Array.isArray(payload.tools) && payload.tools.length > 0
        ? payload.tools
        : chatFunctionTools();

    const upstream = await postCompletion(provider, {
      model: envValue(provider.commandModelEnv) || provider.defaultModel,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 2048,
      temperature: 0.3,
      stream: wantStream,
    });

    if (!upstream.ok) {
      await logUpstreamFailure(provider, 'chat', upstream);
      sendJson(res, upstream.status === 429 ? 429 : 502, {
        error: `${provider.label} chat request failed (HTTP ${upstream.status})`,
      });
      return;
    }

    if (wantStream) {
      res.statusCode = 200;
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
      sendJson(res, 200, data);
    }
  } catch (error) {
    console.warn('[ai-chat] chat request failed:', error?.message || error);
    sendJson(res, 502, { error: 'AI chat request failed' });
  }
}

function extractChatResponseText(data) {
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
 * HUD summary through the default AI chat provider. Delegated to by the OpenAI
 * hud-summary handler when no OPENAI_API_KEY is set but a chat provider is,
 * mirroring the OpenAI 5-word tactical summary.
 */
async function handleAiChatHudSummary(req, res) {
  if (!enforceRateLimit(aiChatRateLimiter(), req, res)) return;

  const id = defaultProviderId();
  const provider = AI_CHAT_PROVIDERS[id];
  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const response = await postCompletion(provider, {
      model: envValue(provider.hudModelEnv) || provider.defaultModel,
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
    });
    if (!response.ok) {
      await logUpstreamFailure(provider, 'HUD summary', response);
      sendJson(res, response.status === 429 ? 429 : 502, {
        summary: null,
        error: `${provider.label} HUD summary request failed`,
      });
      return;
    }
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(extractChatResponseText(data));
    sendJson(res, summary ? 200 : 502, {
      summary: summary || null,
      error: summary ? null : `${provider.label} returned an empty HUD summary`,
    });
  } catch (error) {
    console.warn('[ai-chat] HUD summary failed:', error?.message || error);
    sendJson(res, 502, {
      summary: null,
      error: `${provider.label} HUD summary request failed`,
    });
  }
}

/** Vite plugin: AI chat + status endpoints for the client chat panel. */
function aiChatProxy() {
  function install(middlewares) {
    // Chat is cost-bearing: refuse cross-site browser requests
    // (see server/providers/common/same-site.js and SECURITY.md).
    middlewares.use('/api/ai/status', handleAiChatStatus);
    middlewares.use('/api/ai/chat', sameSiteGated(handleAiChat));
  }
  return {
    name: 'ai-chat-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export {
  AI_CHAT_PROVIDERS,
  aiChatProxy,
  aiChatConfigured,
  aiChatRateLimiter,
  handleAiChatHudSummary,
  sanitizeMessages,
};
