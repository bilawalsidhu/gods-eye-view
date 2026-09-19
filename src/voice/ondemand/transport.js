/**
 * src/voice/ondemand/transport.js — fetch wrappers for the same-origin
 * OnDemand proxy (api/ondemand/*.js) used by the turn-based voice pipeline.
 *
 * Every request shape here is a literal transcription of what the proxy
 * accepts (read the handler named in each method); nothing is invented:
 *
 *   media     POST /api/ondemand/media   multipart {file,name,sessionId,plugins,sizeBytes,responseMode}
 *   stt       POST /api/ondemand/stt     JSON {audioUrl}          → {message, data:{text}}
 *   sessions  POST /api/ondemand/sessions JSON {userId}           → {sessionId, reused}
 *   chat      POST /api/ondemand/chat    JSON {sessionId, query, responseMode:'stream'} → SSE
 *   workflow  POST /api/ondemand/workflow/execute (no input — contract §7.1) → {executionID}
 *             GET  /api/ondemand/workflow/status|logs|outputs?executionId=
 *   tts       POST /api/ondemand/tts?format=audio JSON {input, voice} → audio bytes (mp3)
 *   tools     GET  /api/tools                                       → {tools:[…]}
 *
 * The optional `x-ondemand-key` header is attached to every call when
 * localStorage `ondemand.apiKey` holds a value (Settings drawer). The key is
 * read at request time, never cached in module state, never logged and never
 * returned by any method here.
 *
 * Portable by construction: `fetch`, `storage`, timers and the clock are all
 * injectable so the unit tests run under node:test with no browser.
 */

import { GEV_ACTION_SCHEMAS } from '../actionSchemas.js';

export const KEY_STORAGE = 'ondemand.apiKey';
export const KEY_HEADER = 'x-ondemand-key';
/** §5 "file agents" Audio Agent — the plugin the live contract run attached to a raw audio upload. */
export const AUDIO_AGENT_PLUGIN_ID = 'plugin-1713958830';
export const PATHS = Object.freeze({
  media: '/api/ondemand/media',
  stt: '/api/ondemand/stt',
  tts: '/api/ondemand/tts',
  sessions: '/api/ondemand/sessions',
  chat: '/api/ondemand/chat',
  workflow: '/api/ondemand/workflow',
  workflowExecute: '/api/ondemand/workflow/execute',
  health: '/api/ondemand/health',
  tools: '/api/tools',
});
export const WORKFLOW_POLL = Object.freeze({
  timeoutMs: 90_000,
  initialDelayMs: 1_000,
  maxDelayMs: 3_000,
  backoff: 1.5,
});
const NON_TERMINAL = new Set(['executing', 'pending', 'running', 'queued']);
const TTS_MAX_CHARS = 4096;
const MAP_ACTION_NAMES = new Set(
  GEV_ACTION_SCHEMAS.map((schema) => schema.name),
);

export class TransportError extends Error {
  constructor(
    message,
    { status = 0, code = null, payload = null, path = '' } = {},
  ) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.path = path;
  }
  /** Proxy answered "this feature is off here" (not configured / not documented / serverless). */
  get unavailable() {
    return this.status === 501 || this.status === 503 || this.status === 404;
  }
}

/** Read the optional per-browser key; '' when absent or storage is unusable. */
export function readStoredKey(storage) {
  try {
    const value = storage?.getItem?.(KEY_STORAGE);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** Header object for one request — empty when no key is stored. */
export function keyHeaders(key) {
  return key ? { [KEY_HEADER]: key } : {};
}

/** Voice sessions are keyed per calendar day (UTC) so history stays bounded. */
export function voiceUserId(now = () => Date.now()) {
  return `ondemand-spatial-voice-${new Date(now()).toISOString().slice(0, 10)}`;
}

/**
 * Incremental SSE parser (contract §4 framing): `event:` / `data:` lines,
 * blank-line dispatch, multi-line data joined with '\n', `:` comments
 * ignored. Returns dispatched `{event, data}` records per push.
 */
export function createSseParser() {
  let buffer = '';
  let event = 'message';
  let dataLines = [];
  const flush = (out) => {
    if (dataLines.length) out.push({ event, data: dataLines.join('\n') });
    event = 'message';
    dataLines = [];
  };
  const consumeLine = (rawLine, out) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      flush(out);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    else if (field === 'data') dataLines.push(value);
  };
  return {
    push(chunk) {
      buffer += chunk;
      const out = [];
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        consumeLine(buffer.slice(0, nl), out);
        buffer = buffer.slice(nl + 1);
      }
      return out;
    },
    end() {
      const out = [];
      if (buffer.length) {
        consumeLine(buffer, out);
        buffer = '';
      }
      flush(out);
      return out;
    },
  };
}

/**
 * Fold the chat SSE frames into an answer: `fulfillment` deltas are kept by
 * `eventIndex` (contract §4: "use it to re-order out-of-order chunks"),
 * `statusLog`/`metricsLog`/`fulfillment_thinking`/heartbeats are recorded
 * but never spoken. `[DONE]` ends the fold; `[ERROR]:` throws.
 */
export function createAnswerAccumulator() {
  const deltas = new Map();
  const statusLogs = [];
  let metrics = null;
  let messageId = null;
  let done = false;
  let arrival = 0;
  return {
    consume({ event, data }) {
      if (event === 'heartbeat') return null;
      if (data === '[DONE]') {
        done = true;
        return null;
      }
      if (data.startsWith('[ERROR]:')) {
        let detail = data.slice(8).trim();
        try {
          const parsed = JSON.parse(detail);
          detail = parsed?.message || detail;
        } catch {
          // plain text error
        }
        throw new TransportError(`OnDemand stream error: ${detail}`, {
          status: 502,
          code: 'stream_error',
          path: PATHS.chat,
        });
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return null;
      }
      if (payload?.messageId) messageId = payload.messageId;
      const type = payload?.eventType;
      if (type === 'fulfillment' && typeof payload.answer === 'string') {
        const index = Number.isFinite(payload.eventIndex)
          ? payload.eventIndex
          : 1_000_000 + arrival;
        arrival += 1;
        deltas.set(index, payload.answer);
        return payload.answer;
      }
      if (type === 'statusLog' && payload.currentStatusLog)
        statusLogs.push(payload.currentStatusLog);
      if (type === 'metricsLog' && payload.publicMetrics)
        metrics = payload.publicMetrics;
      return null;
    },
    get text() {
      return [...deltas.keys()]
        .sort((a, b) => a - b)
        .map((key) => deltas.get(key))
        .join('');
    },
    get done() {
      return done;
    },
    get statusLogs() {
      return statusLogs;
    },
    get metrics() {
      return metrics;
    },
    get messageId() {
      return messageId;
    },
  };
}

/** Parse a workflow node value (JSON string, fenced JSON, or object). */
export function parseNodeValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const unfenced = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Normalise `{name, args}` (voice contract) or `{name, params}` (workflow
 * StructuredResponse `actions`) into `{name, args, reason?}` and drop any
 * name outside the 28 known MapActions.
 */
export function normalizeMapActions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!MAP_ACTION_NAMES.has(name)) continue;
    const args =
      item.args && typeof item.args === 'object'
        ? item.args
        : item.params && typeof item.params === 'object'
          ? item.params
          : {};
    const action = { name, args };
    if (typeof item.reason === 'string') action.reason = item.reason;
    out.push(action);
  }
  return out;
}

export function isTerminalStatus(status, endedAt) {
  if (typeof endedAt === 'number' && endedAt > 0) return true;
  if (typeof status !== 'string' || !status) return false;
  return !NON_TERMINAL.has(status.toLowerCase());
}

function describeStatus(status, payload) {
  const code = payload?.error || payload?.errorCode || null;
  if (status === 503) return 'OnDemand is not configured on this deployment';
  if (status === 501)
    return `OnDemand proxy does not support this call${code ? ` (${code})` : ''}`;
  if (status === 404) return 'OnDemand proxy route not found (dev server?)';
  if (status === 401 || status === 403) return 'OnDemand rejected the key';
  if (status === 429) return 'OnDemand rate limit reached';
  return payload?.message || `OnDemand proxy error ${status}`;
}

/**
 * @param {{
 *   fetch?: typeof fetch, storage?: Storage|null, now?: () => number,
 *   setTimeout?: Function, clearTimeout?: Function, base?: string,
 *   FormData?: typeof FormData,
 * }} [options]
 */
export function createTransport({
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  storage = null,
  now = () => Date.now(),
  setTimeout: setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout?.bind(globalThis),
  base = '',
  FormData: FormDataImpl = globalThis.FormData,
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('createTransport requires a fetch implementation');

  const url = (path) => `${base}${path}`;

  function headersFor(extra = {}) {
    return { ...keyHeaders(readStoredKey(storage)), ...extra };
  }

  async function readErrorPayload(response) {
    try {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return text ? { message: text.slice(0, 200) } : null;
      }
    } catch {
      return null;
    }
  }

  async function request(
    path,
    { method = 'GET', json, body, headers = {}, signal } = {},
  ) {
    const init = { method, headers: headersFor(headers), signal };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }
    let response;
    try {
      response = await fetchImpl(url(path), init);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new TransportError('OnDemand proxy unreachable', {
        status: 0,
        code: 'network',
        path,
      });
    }
    if (!response.ok) {
      const payload = await readErrorPayload(response);
      throw new TransportError(describeStatus(response.status, payload), {
        status: response.status,
        code: payload?.error || payload?.errorCode || null,
        payload,
        path,
      });
    }
    return response;
  }

  async function requestJson(path, options) {
    const response = await request(path, options);
    try {
      return await response.json();
    } catch {
      throw new TransportError('OnDemand proxy returned non-JSON', {
        status: response.status,
        code: 'invalid_json',
        path,
      });
    }
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const handle = setTimer(() => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimer(handle);
        reject(abortError());
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  // ---- media + STT ---------------------------------------------------------

  /**
   * §5.2 raw upload through api/ondemand/media.js (multipart forwarded
   * verbatim). Returns the hosted `data.url` the STT call needs.
   */
  async function uploadAudio(blob, { sessionId, filename, signal } = {}) {
    if (typeof FormDataImpl !== 'function')
      throw new TransportError('FormData unavailable', { code: 'no_formdata' });
    const type = blob?.type || 'audio/webm';
    const name = filename || `utterance.${extensionFor(type)}`;
    const form = new FormDataImpl();
    form.append('file', blob, name);
    form.append('name', name);
    if (sessionId) form.append('sessionId', sessionId);
    form.append('plugins', AUDIO_AGENT_PLUGIN_ID);
    form.append('sizeBytes', String(blob?.size ?? 0));
    form.append('responseMode', 'sync');
    const json = await requestJson(PATHS.media, {
      method: 'POST',
      body: form,
      signal,
    });
    const hosted = json?.data?.url ?? json?.url;
    if (typeof hosted !== 'string' || !/^https?:\/\//i.test(hosted)) {
      throw new TransportError('media upload returned no data.url', {
        status: 502,
        code: 'no_media_url',
        payload: json,
        path: PATHS.media,
      });
    }
    return { url: hosted, id: json?.data?.id ?? null };
  }

  /** Upload → `POST /api/ondemand/stt {audioUrl}` → `data.text`. */
  async function transcribe(blob, { sessionId, signal } = {}) {
    const t0 = now();
    const uploaded = await uploadAudio(blob, { sessionId, signal });
    const uploadMs = now() - t0;
    const json = await requestJson(PATHS.stt, {
      method: 'POST',
      json: { audioUrl: uploaded.url }, // §6.1: exactly one field
      signal,
    });
    const text =
      typeof json?.data?.text === 'string' ? json.data.text.trim() : '';
    return { text, audioUrl: uploaded.url, uploadMs, totalMs: now() - t0 };
  }

  // ---- sessions + chat -----------------------------------------------------

  async function createSession({ userId, pluginIds, signal } = {}) {
    const body = { userId: userId || voiceUserId(now) };
    if (Array.isArray(pluginIds)) body.pluginIds = pluginIds;
    const json = await requestJson(PATHS.sessions, {
      method: 'POST',
      json: body,
      signal,
    });
    if (typeof json?.sessionId !== 'string')
      throw new TransportError('session create returned no sessionId', {
        status: 502,
        code: 'no_session',
        payload: json,
        path: PATHS.sessions,
      });
    return {
      sessionId: json.sessionId,
      reused: Boolean(json.reused),
      userId: body.userId,
    };
  }

  /**
   * `POST /api/ondemand/chat {sessionId, query, responseMode:'stream'}` and
   * fold the SSE into an answer. `onDelta(text, delta)` fires per
   * fulfillment chunk with the running text.
   */
  async function chatStream({
    sessionId,
    query,
    onDelta,
    onStatus,
    signal,
    pluginIds,
  } = {}) {
    if (!sessionId)
      throw new TransportError('sessionId required', { code: 'no_session' });
    const body = { sessionId, query, responseMode: 'stream' };
    if (Array.isArray(pluginIds)) body.pluginIds = pluginIds;
    const t0 = now();
    const response = await request(PATHS.chat, {
      method: 'POST',
      json: body,
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    const accumulator = createAnswerAccumulator();
    const parser = createSseParser();
    let firstDeltaMs = null;
    let reportedStatusLogs = 0;
    const handle = (frames) => {
      for (const frame of frames) {
        const delta = accumulator.consume(frame);
        if (delta !== null) {
          if (firstDeltaMs === null) firstDeltaMs = now() - t0;
          onDelta?.(accumulator.text, delta);
        } else if (
          onStatus &&
          accumulator.statusLogs.length > reportedStatusLogs
        ) {
          reportedStatusLogs = accumulator.statusLogs.length;
          onStatus(accumulator.statusLogs[reportedStatusLogs - 1]);
        }
        if (accumulator.done) return true;
      }
      return false;
    };
    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      // A sync-shaped answer (proxy fallback) — still honour it.
      let json = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      const answer = json?.data?.answer;
      return {
        text: typeof answer === 'string' ? answer : '',
        messageId: json?.data?.messageId ?? null,
        statusLogs: [],
        metrics: json?.data?.metrics ?? null,
        firstDeltaMs: now() - t0,
        totalMs: now() - t0,
        streamed: false,
      };
    }
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (handle(parser.push(decoder.decode(value, { stream: true }))))
            break;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
    } else {
      handle(parser.push(await response.text()));
    }
    handle(parser.end());
    return {
      text: accumulator.text,
      messageId: accumulator.messageId,
      statusLogs: accumulator.statusLogs,
      metrics: accumulator.metrics,
      firstDeltaMs,
      totalMs: now() - t0,
      streamed: true,
    };
  }

  // ---- workflow (execute + documented polling) -----------------------------

  /**
   * `POST /api/ondemand/workflow/execute` — the contract defines NO request
   * body for execute (§7.1) and the proxy answers 501 to `input`/`payload`,
   * so the utterance is never sent here; it travels via the chat query.
   */
  async function workflowExecute({ workflowId, signal } = {}) {
    const json = await requestJson(PATHS.workflowExecute, {
      method: 'POST',
      json: workflowId ? { workflowId } : {},
      signal,
    });
    const executionId =
      json?.executionID ??
      json?.data?.executionID ??
      json?.executionId ??
      json?.data?.id;
    if (typeof executionId !== 'string' || !executionId)
      throw new TransportError('execute returned no executionID', {
        status: 502,
        code: 'no_execution_id',
        payload: json,
        path: PATHS.workflowExecute,
      });
    return { executionId, raw: json };
  }

  const workflowGet = (sub, executionId, signal) =>
    requestJson(
      `${PATHS.workflow}/${sub}?executionId=${encodeURIComponent(executionId)}`,
      {
        signal,
      },
    );
  const workflowStatus = (executionId, { signal } = {}) =>
    workflowGet('status', executionId, signal);
  const workflowLogs = (executionId, { signal } = {}) =>
    workflowGet('logs', executionId, signal);
  const workflowOutputs = (executionId, { signal } = {}) =>
    workflowGet('outputs', executionId, signal);

  /**
   * execute → poll status+logs (1 s → 3 s backoff, ≤ timeoutMs) → outputs.
   * Resolves `{ ok, status, executionId, timeToFirstLogMs, totalMs, logs,
   * structured, message, mapActions, error }`; never throws for a workflow
   * failure/timeout — only for an aborted signal or an execute error.
   */
  async function runWorkflow({
    workflowId,
    signal,
    onLog,
    onStatus,
    timeoutMs = WORKFLOW_POLL.timeoutMs,
    initialDelayMs = WORKFLOW_POLL.initialDelayMs,
    maxDelayMs = WORKFLOW_POLL.maxDelayMs,
  } = {}) {
    const t0 = now();
    const { executionId } = await workflowExecute({ workflowId, signal });
    const executeMs = now() - t0;
    const seen = new Set();
    const logs = [];
    let timeToFirstLogMs = null;
    let status = null;
    let ended = null;
    let delayMs = initialDelayMs;
    let polls = 0;
    let lastError = null;
    for (;;) {
      if (signal?.aborted) throw abortError();
      polls += 1;
      try {
        const [statusJson, logsJson] = await Promise.all([
          workflowStatus(executionId, { signal }),
          workflowLogs(executionId, { signal }),
        ]);
        const record = statusJson?.data ?? statusJson ?? {};
        status = typeof record.status === 'string' ? record.status : status;
        ended = record.endedAtInMilliseconds ?? ended;
        onStatus?.({ executionId, status, elapsedMs: now() - t0, polls });
        const entries = Array.isArray(logsJson?.data) ? logsJson.data : [];
        for (const entry of entries) {
          const id = `${entry?.timestamp ?? ''}|${entry?.nodeKey ?? ''}|${entry?.message ?? ''}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const row = {
            timestamp: entry?.timestamp ?? null,
            nodeKey: entry?.nodeKey ?? null,
            message: entry?.message ?? null,
          };
          logs.push(row);
          if (timeToFirstLogMs === null) timeToFirstLogMs = now() - t0;
          onLog?.(row);
        }
        if (entries.length && timeToFirstLogMs === null)
          timeToFirstLogMs = now() - t0;
        if (isTerminalStatus(status, ended)) break;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastError = error;
        // transient poll failures are retried until the budget ends
      }
      if (now() - t0 + delayMs > timeoutMs) {
        status = 'timeout';
        break;
      }
      await delay(delayMs, signal);
      delayMs = Math.min(
        maxDelayMs,
        Math.round(delayMs * WORKFLOW_POLL.backoff),
      );
    }
    const result = {
      ok: false,
      status: status || (lastError ? 'error' : 'unknown'),
      executionId,
      executeMs,
      timeToFirstLogMs,
      totalMs: now() - t0,
      polls,
      logs,
      structured: null,
      message: '',
      mapActions: [],
      error: lastError ? lastError.message : null,
    };
    if (result.status === 'timeout' || result.status === 'error') return result;
    try {
      const outputsJson = await workflowOutputs(executionId, { signal });
      const outputs = outputsJson?.data?.outputs || {};
      const finalNode = outputs.structured_response;
      const structured = finalNode ? parseNodeValue(finalNode.value) : null;
      result.structured = structured;
      result.nodeKeys = Object.keys(outputs);
      if (structured && typeof structured === 'object') {
        result.message =
          typeof structured.message === 'string' ? structured.message : '';
        result.mapActions = normalizeMapActions(
          structured.mapActions ?? structured.actions,
        );
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      result.error = error.message;
    }
    result.ok = /^(success|succeeded|completed|complete|done)$/i.test(
      result.status,
    );
    return result;
  }

  // ---- TTS ---------------------------------------------------------------

  /**
   * `POST /api/ondemand/tts?format=audio {input, voice}` → mp3 bytes.
   * Resolves `{kind:'blob', blob}` or, when the proxy fell back to the JSON
   * envelope, `{kind:'url', url}` (the hosted audio the browser can play).
   */
  async function synthesize(text, { voice = 'alloy', model, signal } = {}) {
    const input = String(text || '').slice(0, TTS_MAX_CHARS);
    if (!input)
      throw new TransportError('nothing to speak', { code: 'empty_input' });
    const json = { input, voice };
    if (model) json.model = model;
    const t0 = now();
    const response = await request(`${PATHS.tts}?format=audio`, {
      method: 'POST',
      json,
      headers: { Accept: 'audio/mpeg, audio/*;q=0.9, application/json;q=0.8' },
      signal,
    });
    const contentType = (
      response.headers?.get?.('content-type') || ''
    ).toLowerCase();
    if (contentType.includes('application/json')) {
      const envelope = await response.json();
      const hosted = envelope?.data?.audioUrl;
      if (typeof hosted !== 'string')
        throw new TransportError('tts returned no audio', {
          status: 502,
          code: 'no_audio',
          payload: envelope,
          path: PATHS.tts,
        });
      return { kind: 'url', url: hosted, ms: now() - t0 };
    }
    let blob = await response.blob();
    if (!blob.type || !blob.type.startsWith('audio/'))
      blob = new Blob([blob], { type: 'audio/mpeg' });
    return { kind: 'blob', blob, ms: now() - t0, bytes: blob.size };
  }

  // ---- catalogue + health -------------------------------------------------

  let toolsCache = null;
  async function tools({ signal, maxAgeMs = 300_000 } = {}) {
    if (toolsCache && now() - toolsCache.at < maxAgeMs) return toolsCache.value;
    try {
      const json = await requestJson(PATHS.tools, { signal });
      const value = Array.isArray(json?.tools) ? json.tools : [];
      toolsCache = { at: now(), value };
      return value;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return [];
    }
  }

  async function health({ signal } = {}) {
    return requestJson(PATHS.health, { signal });
  }

  return {
    request,
    requestJson,
    uploadAudio,
    transcribe,
    createSession,
    chatStream,
    workflowExecute,
    workflowStatus,
    workflowLogs,
    workflowOutputs,
    runWorkflow,
    synthesize,
    tools,
    health,
    /** True when a per-browser key is present (never returns the key itself). */
    hasKey: () => readStoredKey(storage).length > 0,
  };
}

function extensionFor(mime) {
  if (/ogg/.test(mime)) return 'ogg';
  if (/mp4|m4a|aac/.test(mime)) return 'm4a';
  if (/wav/.test(mime)) return 'wav';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  return 'webm';
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
