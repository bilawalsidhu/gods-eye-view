import {
  Backend,
  Engine,
  LiteRtLm,
  SamplerType,
  hasGlobalLiteRtLm,
  setGlobalLiteRtLm,
  setGlobalLiteRtLmPromise,
} from '@litert-lm/core';
import { litertRuntimes, requireRuntime } from './runtimeAssets.js';
import { openModelStream } from './modelCache.js';

// Relaxed SIMD probe: (func (result v128) i32.const 1 i8x16.splat
// i32.const 2 i8x16.splat i8x16.relaxed_swizzle)
const RELAXED_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1,
  13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11,
]);

// The runtime ships with the application build; nothing is fetched from a
// CDN or evaluated from text.
async function ensureRuntime() {
  if (hasGlobalLiteRtLm()) return 0;
  const started = performance.now();
  const modern =
    'Suspending' in WebAssembly && WebAssembly.validate(RELAXED_SIMD_PROBE);
  const runtimes = requireRuntime(litertRuntimes, 'LiteRT-LM');
  const runtime = modern ? runtimes.internal : runtimes.compatAsyncify;
  const module = await runtime.ModuleFactory({
    locateFile: () => runtime.wasmUrl,
  });
  const liteRtLm = new LiteRtLm(module);
  setGlobalLiteRtLm(liteRtLm);
  setGlobalLiteRtLmPromise(Promise.resolve(liteRtLm));
  return performance.now() - started;
}

let engine = null;
let engineModelUrl = null;
let base = null;
let baseKey = null;
// Cancellation can arrive before a queued turn starts.
const cancelledTurns = new Set();
// Deleting the conversation most recently cloned from the base invalidates
// the base's task chain (LiteRT-LM 0.17). Keep a spare clone so that a turn
// is never the latest clone when it is released.
let spare = null;
let lastClone = null;
const turns = new Map();

const post = (message) => self.postMessage(message);

// Work runs one message at a time so clones, releases and prepares never
// interleave; cancel bypasses the queue to stop a running stream.
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  if (data?.type === 'cancel') {
    cancel(data.turnId);
    return;
  }
  queue = queue.then(() => handle(data));
};

async function handle(data) {
  const { type, id } = data || {};
  try {
    if (type === 'load') await load(data);
    else if (type === 'prepare') await prepare(data);
    else if (type === 'turn') await turn(data);
    else if (type === 'tool_result') await continueTurn(data);
    else if (type === 'release') await release(data.turnId);
    else if (type === 'unload') await unload();
    else return;
    if (type === 'release' || type === 'unload') post({ type: 'ok', id });
  } catch (error) {
    post({
      type: 'error',
      id,
      turnId: data?.turnId,
      message: error?.message || String(error),
    });
  }
}

async function load({ id, modelUrl, sha256, bytes, maxNumTokens = 8192 }) {
  if (engine && engineModelUrl === modelUrl) {
    post({ type: 'loaded', id, ms: 0, fromCache: true, reused: true });
    return;
  }
  await unload();
  const started = performance.now();
  const wasmMs = await ensureRuntime();
  const { stream, fromCache, total, finish, cacheWrite } =
    await openModelStream(modelUrl, {
      sha256,
      bytes,
      onProgress: (loaded, size, phase) =>
        post({ type: 'progress', id, loaded, total: size, phase }),
    });
  post({ type: 'progress', id, loaded: 0, total, phase: 'compile' });
  engine = await Engine.create({
    model: stream,
    backend: Backend.GPU_ARTISAN,
    mainExecutorSettings: {
      maxNumTokens,
      backendConfig: {
        num_output_candidates: 1,
        wait_for_weight_uploads: true,
        num_decode_steps_per_sync: 1,
        sequence_batch_size: 0,
        supported_lora_ranks: [],
        max_top_k: 1,
        enable_decode_logits: false,
        enable_external_embeddings: false,
        use_submodel: true,
        use_autosized_ringbuffers: true,
      },
    },
    benchmarkEnabled: true,
  });
  try {
    await finish();
  } catch (error) {
    // The engine may have read an altered or truncated file; discard it.
    await unload();
    throw error;
  }
  engineModelUrl = modelUrl;
  post({
    type: 'loaded',
    id,
    ms: performance.now() - started,
    wasmMs,
    fromCache,
    bytes: total,
    cache: await cacheWrite,
  });
}

function conversationConfig({ system, tools, constrained, maxOutputTokens }) {
  return {
    sessionConfig: {
      maxOutputTokens,
      samplerParams: { type: SamplerType.GREEDY, temperature: 0, k: 1 },
    },
    preface: {
      messages: [{ role: 'system', content: system }],
      tools,
      extra_context: { enable_thinking: false },
    },
    enableConstrainedDecoding: Boolean(constrained),
    prefillPrefaceOnInit: true,
    filterChannelContentFromKvCache: true,
  };
}

async function prepare({
  id,
  system,
  tools,
  constrained = false,
  maxOutputTokens = 256,
}) {
  if (!engine) throw new Error('Model is not loaded');
  const key = JSON.stringify({ system, tools, constrained, maxOutputTokens });
  if (base && baseKey === key) {
    post({ type: 'prepared', id, ms: 0, reused: true });
    return;
  }
  const started = performance.now();
  await dropBase();
  base = await engine.createConversation(
    conversationConfig({ system, tools, constrained, maxOutputTokens }),
  );
  baseKey = key;
  const tokens = await base.getTokenCount().catch(() => null);
  const prefillMs = performance.now() - started;
  await cloneBase();
  post({
    type: 'prepared',
    id,
    ms: performance.now() - started,
    prefillMs,
    tokens,
  });
}

// LiteRT-LM 0.17 keeps one KV cache per engine: clones continue from the
// prepared prefix, while a second independent conversation would overwrite
// it. Every turn therefore runs on a clone of the single prepared base.
async function openTurnConversation() {
  if (!engine) throw new Error('Model is not loaded');
  if (!base) throw new Error('Conversation is not prepared');
  if (!spare) await cloneBase();
  const conversation = spare;
  spare = null;
  return conversation;
}

async function cloneBase() {
  spare = await base.clone();
  lastClone = spare;
}

async function dropBase() {
  for (const turnId of [...turns.keys()]) await release(turnId, true);
  await spare?.delete().catch(() => {});
  spare = null;
  lastClone = null;
  await base?.delete().catch(() => {});
  base = null;
  baseKey = null;
}

async function turn(data) {
  const { turnId, text } = data;
  const state = {
    conversation: null,
    cancelled: cancelledTurns.delete(turnId),
    idle: true,
  };
  turns.set(turnId, state);
  if (state.cancelled) {
    post({ type: 'done', turnId, cancelled: true });
    return;
  }
  const started = performance.now();
  const conversation = await openTurnConversation();
  if (state.cancelled || turns.get(turnId) !== state) {
    // Unused clone of the prepared prefix: keep it as the next spare.
    if (!spare) spare = conversation;
    else await conversation.delete().catch(() => {});
    if (turns.get(turnId) === state)
      post({ type: 'done', turnId, cancelled: true });
    return;
  }
  state.conversation = conversation;
  const cloneMs = performance.now() - started;
  await stream(turnId, state, { role: 'user', content: text }, { cloneMs });
}

async function continueTurn({ turnId, results }) {
  const state = turns.get(turnId);
  if (!state) throw new Error('Turn is no longer active');
  if (state.cancelled || !state.conversation) {
    post({ type: 'done', turnId, cancelled: true });
    return;
  }
  const content = results.map(({ name, response }) => ({
    type: 'tool_response',
    name,
    response,
  }));
  await stream(turnId, state, { role: 'tool', content }, {});
}

async function stream(turnId, state, message, extra) {
  if (state.cancelled) {
    post({ type: 'done', turnId, cancelled: true });
    return;
  }
  state.idle = false;
  const started = performance.now();
  let firstChunkMs = null;
  let text = '';
  const calls = [];
  const reader = state.conversation.sendMessageStreaming(message).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || state.cancelled) break;
    if (firstChunkMs === null) firstChunkMs = performance.now() - started;
    if (value?.tool_calls?.length) {
      for (const call of value.tool_calls) {
        calls.push({
          name: call.function?.name,
          arguments: call.function?.arguments || {},
        });
      }
      post({
        type: 'tool_calls',
        turnId,
        calls: calls.slice(),
        ms: performance.now() - started,
      });
    }
    const delta = chunkText(value);
    if (delta) {
      text += delta;
      post({ type: 'delta', turnId, text: delta });
    }
  }
  state.idle = true;
  if (state.cancelled) {
    await reader.cancel().catch(() => {});
    post({ type: 'done', turnId, cancelled: true });
    return;
  }
  const bench = await state.conversation.getBenchmarkInfo().catch(() => null);
  post({
    type: 'done',
    turnId,
    text,
    calls,
    stats: {
      ...extra,
      totalMs: performance.now() - started,
      firstChunkMs,
      prefillTokens: bench?.lastPrefillTokenCount ?? null,
      prefillTokensPerSecond: bench?.lastPrefillTokensPerSecond ?? null,
      decodeTokens: bench?.lastDecodeTokenCount ?? null,
      decodeTokensPerSecond: bench?.lastDecodeTokensPerSecond ?? null,
      timeToFirstTokenS: bench?.timeToFirstTokenInSecond ?? null,
    },
  });
}

function chunkText(message) {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('');
}

function cancel(turnId) {
  const state = turns.get(turnId);
  if (!state) {
    cancelledTurns.add(turnId);
    return;
  }
  state.cancelled = true;
  if (!state.idle) state.conversation?.cancel();
}

async function release(turnId, droppingBase = false) {
  const state = turns.get(turnId);
  turns.delete(turnId);
  cancelledTurns.delete(turnId);
  if (!state?.conversation) return;
  if (!droppingBase && state.conversation === lastClone && base)
    await cloneBase();
  if (!state.idle) {
    state.cancelled = true;
    try {
      state.conversation.cancel();
    } catch {
      /* already idle */
    }
  }
  await state.conversation.delete().catch(() => {});
}

async function unload() {
  await dropBase();
  await engine?.delete().catch(() => {});
  engine = null;
  engineModelUrl = null;
}
