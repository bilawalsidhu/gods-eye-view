/**
 * Local-model adapters: stateless chat requests, so every phrase is a fresh
 * context by construction. Same system prompt (realtimeInstructions()) and
 * the production tools converted with toChatTools() (schema-normalized).
 *
 *   openai-chat  any OpenAI-compatible server (LM Studio :1234/v1, Ollama
 *                :11434/v1). Streams SSE; timing is client-side.
 *   ollama       Ollama's native /api/chat. Same message and tool formats as
 *                Chat Completions, but it can set num_ctx (the OpenAI shim
 *                cannot — the ~15k-token prompt would be silently truncated
 *                at a small default context) and turn thinking off, and it
 *                reports server-side prefill/decode/load timings.
 *
 * Both mirror the Realtime loop: stub tool results, then continue until a
 * response has no tool calls, up to 4 continuations.
 */
import { realtimeInstructions, GEV_REALTIME_TOOLS } from '../productionConfig.mjs';
import { toChatTools } from '../toolFormats.mjs';

const MAX_CONTINUATIONS = 4;

function emptyResult() {
  return {
    calls: [], text: '', errors: [], responses: 0,
    usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    costUsd: 0, tFirstTokenMs: null, tFirstCallMs: null, tDoneMs: null, setupMs: 0, timeout: false,
    local: { prefillTokS: null, decodeTokS: null, promptEvalCount: null, evalCount: null, loadMs: null, firstResponseMs: null },
  };
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return { __unparsed: String(raw).slice(0, 400) }; }
}

async function* lines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

/**
 * Shared multi-response loop over one or more user turns in ONE growing
 * message history. `request(messages, r, t0, first, deadline)` performs one
 * streamed completion and returns `{ content, toolCalls:[{id,name,args}] }`.
 */
async function runChatDialogue({ turns, onCall, request, turnTimeoutMs, contexts = [] }) {
  const messages = [{ role: 'system', content: realtimeInstructions() }];
  const results = [];
  for (let turn = 0; turn < turns.length; turn += 1) {
    const r = emptyResult();
    if (contexts[turn]) messages.push({ role: 'system', content: JSON.stringify(contexts[turn]) });
    messages.push({ role: 'user', content: turns[turn] });
    const t0 = Date.now();
    const deadline = t0 + turnTimeoutMs;
    try {
      for (let round = 0; round <= MAX_CONTINUATIONS; round += 1) {
        if (Date.now() > deadline) { r.timeout = true; break; }
        const out = await request(messages, r, t0, round === 0, deadline);
        r.responses += 1;
        if (out.content) r.text += (r.text ? ' | ' : '') + out.content.trim();
        if (!out.toolCalls.length) {
          messages.push({ role: 'assistant', content: out.content || '' });
          break;
        }
        messages.push({ role: 'assistant', content: out.content || '', tool_calls: out.toolCalls.map((tc) => tc.wire) });
        for (const tc of out.toolCalls) {
          const c = { name: tc.name, args: tc.args, atMs: tc.atMs };
          r.calls.push(c);
          messages.push({ role: 'tool', tool_call_id: tc.id, tool_name: tc.name, name: tc.name, content: JSON.stringify(onCall(c, turn)) });
        }
      }
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') r.timeout = true;
      else r.errors.push(String(e?.message || e).slice(0, 300));
    }
    r.tDoneMs = Date.now() - t0;
    results.push(r);
    if (r.timeout || r.errors.length) {
      while (results.length < turns.length) {
        const skipped = emptyResult();
        skipped.errors.push('dialogue aborted after an earlier turn failed');
        results.push(skipped);
      }
      break;
    }
  }
  return results;
}

// ── OpenAI-compatible (SSE) ─────────────────────────────────────────────────

export function createOpenAiChatAdapter({ model, baseUrl, temperature = 0.8, extraBody = {}, turnTimeoutMs = 180_000, apiKey = 'local' }) {
  const tools = toChatTools(GEV_REALTIME_TOOLS);
  const request = async (messages, r, t0, first, deadline) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, messages, tools, tool_choice: 'auto', temperature, stream: true,
        stream_options: { include_usage: true }, ...extraBody,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const tStart = Date.now();
    let tFirst = null;
    let content = '';
    const byIndex = new Map();
    let usage = null;
    let firstCallDoneAt = null;
    for await (const line of lines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      let m;
      try { m = JSON.parse(data); } catch { continue; }
      if (m.usage) usage = m.usage;
      const choice = m.choices?.[0];
      const d = choice?.delta || {};
      const now = Date.now();
      if ((d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length) && tFirst === null) {
        tFirst = now;
        if (r.tFirstTokenMs === null) r.tFirstTokenMs = now - t0;
      }
      if (d.content) content += d.content;
      for (const tc of d.tool_calls || []) {
        const idx = tc.index ?? byIndex.size;
        if (idx > 0 && byIndex.has(0) && firstCallDoneAt === null) firstCallDoneAt = now;
        const cur = byIndex.get(idx) || { id: tc.id || `call_${idx}`, name: '', argText: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.argText += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
        byIndex.set(idx, cur);
      }
      if (choice?.finish_reason && byIndex.size && firstCallDoneAt === null) firstCallDoneAt = now;
    }
    const tEnd = Date.now();
    if (byIndex.size && firstCallDoneAt === null) firstCallDoneAt = tEnd;
    if (byIndex.size && r.tFirstCallMs === null) r.tFirstCallMs = firstCallDoneAt - t0;
    if (usage) {
      r.usage.inputTokens += usage.prompt_tokens || 0;
      r.usage.cachedTokens += usage.prompt_tokens_details?.cached_tokens || 0;
      r.usage.outputTokens += usage.completion_tokens || 0;
      r.usage.reasoningTokens += usage.completion_tokens_details?.reasoning_tokens || 0;
    }
    if (first) {
      r.local.firstResponseMs = tEnd - tStart;
      if (usage && tFirst) {
        r.local.promptEvalCount = usage.prompt_tokens ?? null;
        r.local.evalCount = usage.completion_tokens ?? null;
        // Client-side approximations: prefill ≈ prompt / (request → first token);
        // decode ≈ (completion − 1) / (first token → end of stream).
        r.local.prefillTokS = usage.prompt_tokens ? usage.prompt_tokens / Math.max(0.001, (tFirst - tStart) / 1000) : null;
        r.local.decodeTokS = usage.completion_tokens > 1 && tEnd > tFirst ? (usage.completion_tokens - 1) / ((tEnd - tFirst) / 1000) : null;
        r.local.timingSource = 'client';
      }
    }
    const toolCalls = [...byIndex.values()].map((tc) => ({
      id: tc.id, name: tc.name, args: parseArgs(tc.argText), atMs: firstCallDoneAt - t0,
      wire: { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.argText || '{}' } },
    }));
    return { content, toolCalls };
  };
  return {
    provider: 'openai-chat',
    model,
    settings: { baseUrl, temperature, tool_choice: 'auto', toolSchema: 'normalized (untyped → string|number|boolean)', context: 'stateless request per phrase', ...extraBody },
    async open() {},
    async close() {},
    runDialogue: ({ turns, onCall, contexts }) => runChatDialogue({ turns, onCall, contexts, request, turnTimeoutMs }),
    runTurn: async ({ text, onCall, context }) => (await runChatDialogue({ turns: [text], onCall, contexts: [context], request, turnTimeoutMs }))[0],
  };
}

// ── Ollama native (/api/chat, NDJSON) ───────────────────────────────────────

export function createOllamaAdapter({ model, baseUrl = 'http://localhost:11434', temperature = 0.8, numCtx = 32768, think = false, keepAlive = '30m', turnTimeoutMs = 300_000 }) {
  const tools = toChatTools(GEV_REALTIME_TOOLS);
  let thinkParam = think;
  const request = async (messages, r, t0, first, deadline) => {
    const wireMessages = messages.map((m) => {
      if (m.role === 'assistant' && m.tool_calls) {
        return { role: 'assistant', content: m.content, tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.function.name, arguments: parseArgs(tc.function.arguments) } })) };
      }
      if (m.role === 'tool') return { role: 'tool', tool_name: m.tool_name, content: m.content };
      return m;
    });
    const body = { model, messages: wireMessages, tools, stream: true, keep_alive: keepAlive, options: { temperature, num_ctx: numCtx } };
    if (thinkParam !== null) body.think = thinkParam;
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (/does not support thinking/i.test(errText) && thinkParam !== null) {
        thinkParam = null;
        return request(messages, r, t0, first, deadline);
      }
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    let content = '';
    const toolCalls = [];
    let final = null;
    for await (const line of lines(res.body)) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.error) throw new Error(m.error);
      const now = Date.now();
      const msg = m.message || {};
      if ((msg.content || msg.thinking || msg.tool_calls?.length) && r.tFirstTokenMs === null) r.tFirstTokenMs = now - t0;
      if (msg.content) content += msg.content;
      for (const tc of msg.tool_calls || []) {
        if (r.tFirstCallMs === null) r.tFirstCallMs = now - t0;
        const i = `${messages.length}_${toolCalls.length}`;
        const args = parseArgs(tc.function?.arguments);
        toolCalls.push({
          id: `call_${i}`, name: tc.function?.name, args, atMs: now - t0,
          wire: { id: `call_${i}`, type: 'function', function: { name: tc.function?.name, arguments: JSON.stringify(args) } },
        });
      }
      if (m.done) final = m;
    }
    if (final) {
      r.usage.inputTokens += final.prompt_eval_count || 0;
      r.usage.outputTokens += final.eval_count || 0;
      if (first) {
        const ns = 1e9;
        r.local.promptEvalCount = final.prompt_eval_count ?? null;
        r.local.evalCount = final.eval_count ?? null;
        r.local.prefillTokS = final.prompt_eval_duration ? final.prompt_eval_count / (final.prompt_eval_duration / ns) : null;
        r.local.decodeTokS = final.eval_duration ? final.eval_count / (final.eval_duration / ns) : null;
        r.local.loadMs = final.load_duration ? final.load_duration / 1e6 : null;
        r.local.firstResponseMs = final.total_duration ? final.total_duration / 1e6 : null;
        r.local.timingSource = 'ollama';
      }
    }
    return { content, toolCalls };
  };
  return {
    provider: 'ollama',
    model,
    get settings() {
      return { baseUrl, api: '/api/chat', temperature, num_ctx: numCtx, think: thinkParam === null ? 'unsupported by model (param omitted)' : thinkParam, keep_alive: keepAlive, toolSchema: 'normalized (untyped → string|number|boolean)', context: 'stateless request per phrase' };
    },
    async open() {},
    async close() {},
    runDialogue: ({ turns, onCall, contexts }) => runChatDialogue({ turns, onCall, contexts, request, turnTimeoutMs }),
    runTurn: async ({ text, onCall, context }) => (await runChatDialogue({ turns: [text], onCall, contexts: [context], request, turnTimeoutMs }))[0],
  };
}
