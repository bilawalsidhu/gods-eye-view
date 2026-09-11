/**
 * Local voice provider for God's Eye View (September 2026).
 *
 * Answers upstream issue #212: drive the SAME 28 voice tools with a local LLM
 * (Ollama) or Anthropic instead of the OpenAI Realtime API. The browser does
 * speech-to-text (Web Speech API) and text-to-speech (speechSynthesis); this
 * module only turns a transcript + tool schemas into tool calls.
 *
 * Endpoints (installed by installLocalVoiceMiddleware):
 *   GET  /api/local-voice/status → { configured, provider, model, lang }
 *   POST /api/local-voice/turn   → { text, toolCalls:[{ id, name, args }] }
 *
 * Conversation format is provider-neutral so the client keeps ONE history:
 *   { role:'user', content }
 *   { role:'assistant', content, toolCalls:[{ id, name, args }] }
 *   { role:'tool', id, name, content }   (content = JSON string of the result)
 *
 * Env: LOCAL_VOICE_PROVIDER=ollama|anthropic|auto (default auto),
 *      OLLAMA_URL (default http://127.0.0.1:11434), OLLAMA_MODEL (default qwen3),
 *      ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-sonnet-5),
 *      LOCAL_VOICE_LANG (BCP-47 hint for the browser recognizer, default navigator language).
 */

const MAX_HISTORY = 24;
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen3';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

export function resolveLocalVoiceProvider(env = process.env) {
  const requested = String(env.LOCAL_VOICE_PROVIDER || 'auto').trim().toLowerCase();
  const anthropicKey = String(env.ANTHROPIC_API_KEY || '').trim();
  const ollamaUrl = String(env.OLLAMA_URL || '').trim();
  const lang = String(env.LOCAL_VOICE_LANG || '').trim() || null;
  let provider = null;
  if (requested === 'anthropic' && anthropicKey) provider = 'anthropic';
  else if (requested === 'ollama' && (ollamaUrl || requested === 'ollama')) provider = 'ollama';
  else if (requested === 'auto') provider = anthropicKey ? 'anthropic' : (ollamaUrl ? 'ollama' : null);
  if (!provider) return { configured: false, provider: null, model: null, lang };
  if (provider === 'anthropic') {
    return { configured: true, provider, model: String(env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL).trim(), lang, apiKey: anthropicKey };
  }
  return {
    configured: true,
    provider,
    model: String(env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL).trim(),
    lang,
    url: (ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, ''),
  };
}

/** Realtime-style tool ({type:'function',name,description,parameters}) → Ollama/OpenAI chat tool. */
export function toOllamaTools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
  }));
}

/** Realtime-style tool → Anthropic tool. */
export function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.parameters || { type: 'object', properties: {} },
  }));
}

export function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' || m.role === 'tool' ? m.role : 'user';
    const content = typeof m.content === 'string' ? m.content.slice(0, 8000) : '';
    if (role === 'assistant') {
      const toolCalls = Array.isArray(m.toolCalls)
        ? m.toolCalls
          .filter((c) => c && typeof c.name === 'string')
          .map((c, i) => ({ id: String(c.id || `call_${i}`), name: c.name, args: c.args && typeof c.args === 'object' ? c.args : {} }))
        : [];
      clean.push({ role, content, toolCalls });
    } else if (role === 'tool') {
      clean.push({ role, id: String(m.id || ''), name: String(m.name || ''), content });
    } else {
      clean.push({ role, content });
    }
  }
  return clean.slice(-MAX_HISTORY);
}

export function toOllamaMessages(instructions, history) {
  const out = [{ role: 'system', content: instructions }];
  for (const m of history) {
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls.length) msg.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content || '{}' });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

export function toAnthropicMessages(history) {
  const out = [];
  let pendingResults = null;
  const flushResults = () => {
    if (pendingResults && pendingResults.length) out.push({ role: 'user', content: pendingResults });
    pendingResults = null;
  };
  for (const m of history) {
    if (m.role === 'tool') {
      if (!pendingResults) pendingResults = [];
      pendingResults.push({ type: 'tool_result', tool_use_id: m.id, content: m.content || '{}' });
      continue;
    }
    flushResults();
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content || '…' }] });
    }
  }
  flushResults();
  // Anthropic requires alternating roles starting with user; merge adjacent same-role messages.
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = last.content.concat(m.content);
    else merged.push(m);
  }
  if (merged.length && merged[0].role !== 'user') merged.unshift({ role: 'user', content: [{ type: 'text', text: '…' }] });
  return merged;
}

async function ollamaTurn(config, instructions, tools, history) {
  const response = await fetch(`${config.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      think: false,
      messages: toOllamaMessages(instructions, history),
      tools: toOllamaTools(tools),
      options: { temperature: 0.2 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  const message = data?.message || {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((c, i) => ({
      id: String(c.id || `call_${Date.now()}_${i}`),
      name: c.function?.name || '',
      args: parseArgs(c.function?.arguments),
    })).filter((c) => c.name)
    : [];
  return { text: String(message.content || '').trim(), toolCalls, model: data?.model || config.model };
}

async function anthropicTurn(config, instructions, tools, history) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 600,
      system: instructions,
      tools: toAnthropicTools(tools),
      messages: toAnthropicMessages(history),
    }),
  });
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
  return { text, toolCalls, model: data?.model || config.model };
}

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('connect').Server} middlewares Vite's connect app.
 * @param {{ tools: object[], instructions: string, env?: object }} options
 */
export function installLocalVoiceMiddleware(middlewares, { tools, instructions, env = process.env }) {
  const localInstructions = `${instructions}\n`
    + 'You are running on a local/private model, not OpenAI. Reply in the language the operator speaks (Spanish when they speak Spanish). '
    + 'Keep spoken replies to one short sentence. When a tool is needed, call it; after tool results, confirm in one sentence. '
    + 'If the operator asks what you can do, what to say, or how to zoom / rotate / orbit / follow / enter the cockpit / change layers or styles, '
    + 'answer without calling a tool: a short list (max 8 lines) of example commands drawn from your tools, in their language. '
    + 'For fly_route, omit the route name unless the operator names a specific saved route: "fly the route" means the newest drawn route.';

  middlewares.use('/api/local-voice/status', (req, res) => {
    const config = resolveLocalVoiceProvider(env);
    sendJson(res, 200, { configured: config.configured, provider: config.provider, model: config.model, lang: config.lang });
  });

  middlewares.use('/api/local-voice/turn', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const config = resolveLocalVoiceProvider(env);
    if (!config.configured) return sendJson(res, 503, { error: 'No local voice provider configured (set OLLAMA_URL or ANTHROPIC_API_KEY)' });
    let body;
    try {
      body = await readJson(req, MAX_BODY_BYTES);
    } catch (error) {
      return sendJson(res, 400, { error: `Bad request: ${error.message}` });
    }
    const history = sanitizeHistory(body.messages);
    if (!history.length) return sendJson(res, 400, { error: 'messages required' });
    try {
      const turn = config.provider === 'anthropic'
        ? await anthropicTurn(config, localInstructions, tools, history)
        : await ollamaTurn(config, localInstructions, tools, history);
      sendJson(res, 200, { ...turn, provider: config.provider });
    } catch (error) {
      sendJson(res, 502, { error: String(error?.message || error).slice(0, 300), provider: config.provider });
    }
  });
}
