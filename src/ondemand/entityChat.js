/**
 * @module ondemand/entityChat
 * @description The "ASK ONDEMAND" mini chatbot that opens on a selected
 * aircraft / vessel / satellite (docs/ENTITY_CHAT.md).
 *
 * Everything goes through the same-origin proxy — never to OnDemand
 * directly, never with the server key:
 *
 *   POST /api/ondemand/sessions  { userId: 'ondemand-spatial-entity-<yyyy-mm-dd>', reuse: false }
 *   POST /api/ondemand/chat      { sessionId, query: <system prompt + JSON context>, responseMode: 'sync', fulfillmentOnly: true }
 *   POST /api/ondemand/chat      { sessionId, query: <user text>, responseMode: 'stream' }   (per message, SSE)
 *
 * One OnDemand session per entity id, cached in memory for the page's
 * lifetime. The first turn carries the context built by
 * src/ondemand/entityContext.js (the proxy forwards only documented query
 * fields, and session `contextMetadata` is undocumented upstream — see the
 * doc). Streaming replies render `fulfillment` deltas as they arrive and the
 * badge shows the time to the first token.
 *
 * Optional per-request key: when localStorage `ondemand.apiKey` holds a key
 * it is sent ONLY as the `x-ondemand-key` request header — never in a body,
 * never rendered, never logged. The overlay shows "using your key" instead.
 *
 * The transport (`fetch`), clock, storage and document are injectable so
 * the whole controller runs under node:test with a fake DOM.
 */
import {
  buildEntityContext,
  entitySystemPrompt,
  kindForLayer,
  normalizeEntity,
  SATELLITE_RADIUS_KM,
  MAX_NEARBY,
} from './entityContext.js';

export const ENTITY_CHAT_ID = 'ondemand-entity-chat';
export const API_KEY_STORAGE_KEY = 'ondemand.apiKey';
export const API_KEY_HEADER = 'x-ondemand-key';
export const API_KEY_MAX_LEN = 128;
export const EXTERNAL_USER_PREFIX = 'ondemand-spatial-entity-';
export const ASK_BUTTON_ID = 'ask-ondemand-btn';
/** Every selector a harness needs to drive the overlay headlessly. */
export const SELECTORS = Object.freeze({
  askButton: `#${ASK_BUTTON_ID}`,
  overlay: `#${ENTITY_CHAT_ID}`,
  title: `#${ENTITY_CHAT_ID}-title`,
  mgrs: `#${ENTITY_CHAT_ID}-mgrs`,
  status: `#${ENTITY_CHAT_ID}-status`,
  latencyBadge: `#${ENTITY_CHAT_ID}-latency`,
  keyState: `#${ENTITY_CHAT_ID}-key-state`,
  keyToggle: `#${ENTITY_CHAT_ID}-key-toggle`,
  keyRow: `#${ENTITY_CHAT_ID}-key-row`,
  keyInput: `#${ENTITY_CHAT_ID}-key`,
  keySave: `#${ENTITY_CHAT_ID}-key-save`,
  keyClear: `#${ENTITY_CHAT_ID}-key-clear`,
  transcript: `#${ENTITY_CHAT_ID}-transcript`,
  input: `#${ENTITY_CHAT_ID}-input`,
  send: `#${ENTITY_CHAT_ID}-send`,
  close: `#${ENTITY_CHAT_ID}-close`,
  message: '.od-chat__msg',
  assistantMessage: '.od-chat__msg--assistant',
});
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const KIND_LABEL = Object.freeze({
  aircraft: 'AIRCRAFT',
  vessel: 'VESSEL',
  satellite: 'SATELLITE',
});

/** A usable key: printable ASCII, 1..128 chars (mirrors the proxy rule). */
export function isUsableApiKey(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= API_KEY_MAX_LEN &&
    PRINTABLE_ASCII.test(value)
  );
}

/** The stored key, or null. Never throws (private mode, blocked storage). */
export function readStoredApiKey(storage) {
  try {
    const value = storage?.getItem?.(API_KEY_STORAGE_KEY);
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return isUsableApiKey(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/** Store (or clear, for an empty value) the browser-only key. */
export function writeStoredApiKey(storage, value) {
  try {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      storage?.removeItem?.(API_KEY_STORAGE_KEY);
      return null;
    }
    if (!isUsableApiKey(trimmed)) return readStoredApiKey(storage);
    storage?.setItem?.(API_KEY_STORAGE_KEY, trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

/** `ondemand-spatial-entity-<yyyy-mm-dd>` (UTC date). */
export function externalUserIdFor(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return `${EXTERNAL_USER_PREFIX}${date.toISOString().slice(0, 10)}`;
}

/** Stable cache key for one entity. */
export function entityKeyFor(kind, entity) {
  const normalized = normalizeEntity(kind, entity);
  return `${normalized.kind}:${normalized.id ?? 'unknown'}`;
}

/**
 * Human reason for a proxy / upstream failure — the proxy's own envelope
 * (`{ error, message }`, 501 not-documented, 503 not_configured, 429
 * rate_limit_exceeded, …) wins; the HTTP status is always named.
 */
export function proxyErrorMessage(status, body) {
  const parts = [`proxy ${status}`];
  if (body && typeof body === 'object') {
    const code = body.error || body.errorCode || body.code;
    const message = body.message || body.detail || body.reason;
    if (code) parts.push(String(code));
    if (message && message !== code) parts.push(String(message));
  } else if (typeof body === 'string' && body.trim()) {
    parts.push(body.trim().slice(0, 200));
  }
  return parts.join(' · ');
}

/**
 * Incremental SSE parser for the proxied OnDemand stream (contract §4):
 * `event:` lines name the event, `data:` lines carry JSON, `data:[DONE]`
 * ends the stream, `data:[ERROR]:<json>` reports a failure, `:` lines are
 * keepalive comments. `push(text)` returns the events completed so far.
 */
export function createSseParser() {
  let buffer = '';
  let event = 'message';
  const emit = (line, out) => {
    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') {
      out.push({ event, type: 'done' });
      return;
    }
    if (data.startsWith('[ERROR]')) {
      const raw = data.slice('[ERROR]'.length).replace(/^:/, '');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      out.push({
        event,
        type: 'error',
        message: parsed?.message || raw || 'stream error',
        errorCode: parsed?.errorCode || null,
      });
      return;
    }
    if (event === 'heartbeat') {
      out.push({ event, type: 'heartbeat' });
      return;
    }
    try {
      const payload = JSON.parse(data);
      if (
        payload?.eventType === 'fulfillment' &&
        typeof payload.answer === 'string'
      ) {
        out.push({
          event,
          type: 'fulfillment',
          answer: payload.answer,
          payload,
        });
      } else if (payload?.eventType === 'statusLog') {
        out.push({
          event,
          type: 'status',
          statusType: payload.currentStatusLog?.statusType || null,
          statusMessage: payload.currentStatusLog?.statusMessage || null,
          payload,
        });
      } else if (payload?.eventType === 'metricsLog') {
        out.push({
          event,
          type: 'metrics',
          metrics: payload.publicMetrics || null,
          payload,
        });
      } else if (typeof payload?.answer === 'string') {
        out.push({
          event,
          type: 'fulfillment',
          answer: payload.answer,
          payload,
        });
      } else {
        out.push({ event, type: 'other', payload });
      }
    } catch {
      out.push({ event, type: 'raw', data });
    }
  };
  return {
    push(text) {
      buffer += text;
      const out = [];
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line === '') {
          event = 'message';
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          event = line.slice('event:'.length).trim() || 'message';
          continue;
        }
        if (line.startsWith('data:')) emit(line, out);
      }
      return out;
    },
    flush() {
      const out = [];
      if (buffer.trim().startsWith('data:')) emit(buffer.trim(), out);
      buffer = '';
      return out;
    },
  };
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchJsonTolerant(fetchImpl, url, headers) {
  try {
    const response = await fetchImpl(url, { headers });
    if (!response?.ok) return null;
    return await readJsonSafe(response);
  } catch {
    return null;
  }
}

/** Scene name from the location mini-status, when the dock has one. */
function sceneNameFrom(document) {
  try {
    const text = document?.getElementById?.('location-mini-city')?.textContent;
    if (typeof text !== 'string') return null;
    const cleaned = text.replace(/^[^A-Za-z0-9]*Location:\s*/i, '').trim();
    return cleaned && cleaned !== '--' ? cleaned : null;
  } catch {
    return null;
  }
}

/**
 * Gather the live inputs and build the context payload. Tool catalogue,
 * health and satellites-overhead requests are tolerant — a 404 (tool not
 * deployed yet) or a network failure just leaves that block empty.
 */
export async function collectEntityContext({
  entity,
  kind,
  viewer,
  dataManager,
  fetch: fetchImpl,
  document,
  headers = {},
  now = Date.now(),
  apiBase = '',
} = {}) {
  const normalized = normalizeEntity(kind, entity);
  const hasPosition = normalized.lat !== null && normalized.lon !== null;
  const satelliteUrl = hasPosition
    ? `${apiBase}/api/tools/list_satellites_in_scene?lat=${normalized.lat}&lon=${normalized.lon}&radiusKm=${SATELLITE_RADIUS_KM}&limit=${MAX_NEARBY}`
    : null;
  const [tools, health, satellitesEnvelope] = await Promise.all([
    fetchJsonTolerant(fetchImpl, `${apiBase}/api/tools`, headers),
    fetchJsonTolerant(fetchImpl, `${apiBase}/api/ondemand/health`, headers),
    satelliteUrl ? fetchJsonTolerant(fetchImpl, satelliteUrl, headers) : null,
  ]);
  const satellitesOverhead = Array.isArray(satellitesEnvelope?.data?.satellites)
    ? satellitesEnvelope.data.satellites
    : null;
  return buildEntityContext({
    entity,
    kind,
    viewer,
    dataManager,
    scene: { name: sceneNameFrom(document) },
    tools,
    health,
    now,
    satellitesOverhead,
    sourceFeed: entity?.sourceFeed ?? entity?.source ?? null,
  });
}

/**
 * Resolve the currently selected subject (tracking layers' shared slot,
 * src/data/contextStore.js) to `{ entity, kind, layerId }` using the
 * layer's own accessor for the live descriptor.
 */
export function resolveSelectedEntity({
  dataManager,
  window: win,
  selection,
} = {}) {
  const store = win?.__gevContextStore;
  const selectedId = selection?.id ?? store?.selectedEntityId ?? null;
  const record =
    (selectedId !== null && store?.entities?.get?.(String(selectedId))) ||
    (selection?.layerId ? { ...selection } : null);
  const layerId = selection?.layerId || record?.layerId || null;
  const kind = kindForLayer(layerId);
  if (!kind) return null;
  const module = dataManager?.layers?.get?.(layerId)?.module;
  let live = null;
  try {
    if (kind === 'vessel') live = module?.getSelectedInfo?.() || null;
    else live = module?.getTrackedInfo?.() || null;
  } catch {
    live = null;
  }
  const rawRecord =
    record?.entity && typeof record.entity === 'object' ? record.entity : {};
  const entity = {
    ...(record?.properties && typeof record.properties === 'object'
      ? record.properties
      : {}),
    ...rawRecord,
    ...(live || {}),
    layerId,
    label: record?.label ?? live?.name ?? live?.callsign ?? null,
    sourceFeed: record?.source ?? null,
  };
  if (entity.id === undefined && record?.id !== undefined)
    entity.id = String(record.id).replace(/^ais-/, '');
  if (kind === 'aircraft' && !entity.icao24 && entity.id)
    entity.icao24 = String(entity.id);
  if (kind === 'vessel' && !entity.mmsi && entity.id)
    entity.mmsi = String(entity.id);
  if (kind === 'satellite' && !entity.noradId && entity.id)
    entity.noradId = String(entity.id);
  if (
    entity.latitude === undefined &&
    entity.lat === undefined &&
    record?.latitude !== undefined
  ) {
    entity.latitude = record.latitude;
    entity.longitude = record.longitude;
  }
  return { entity, kind, layerId };
}

function el(document, tag, { id, className, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (id) node.id = id;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs)
    for (const [name, value] of Object.entries(attrs))
      node.setAttribute(name, String(value));
  return node;
}

/**
 * Build the controller. Nothing touches the network until `open()`.
 * @param {{
 *   document?: Document, window?: Window, fetch?: typeof fetch, storage?: Storage,
 *   now?: () => number, performanceNow?: () => number,
 *   viewer?: object, dataManager?: object, endpointId?: string|null,
 *   buildContext?: (input: object) => Promise<object>|object, apiBase?: string,
 * }} [deps]
 */
export function createEntityChat(deps = {}) {
  const document = deps.document ?? globalThis.document;
  const win = deps.window ?? globalThis.window;
  const fetchImpl = deps.fetch ?? ((...args) => globalThis.fetch(...args));
  const storage =
    deps.storage ??
    (() => {
      try {
        return win?.localStorage ?? null;
      } catch {
        return null;
      }
    })();
  const now = deps.now ?? (() => Date.now());
  const performanceNow =
    deps.performanceNow ??
    (() =>
      globalThis.performance?.now ? globalThis.performance.now() : Date.now());
  const apiBase = deps.apiBase ?? '';
  const endpointId = deps.endpointId ?? null;
  const buildContext =
    deps.buildContext ??
    ((input) =>
      collectEntityContext({
        ...input,
        viewer: deps.viewer,
        dataManager: deps.dataManager,
        fetch: fetchImpl,
        document,
        apiBase,
      }));

  const state = {
    open: false,
    entityKey: null,
    kind: null,
    entity: null,
    context: null,
    sessionId: null,
    selection: null,
    busy: false,
    lastFirstTokenMs: null,
    turns: [],
    messages: [],
    error: null,
  };
  /** entityKey → { promise, sessionId, context, primedOk, error } */
  const sessions = new Map();
  let abortController = null;
  const ui = {};
  let destroyed = false;

  function keyHeaders(extra = {}) {
    const headers = { ...extra };
    const key = readStoredApiKey(storage);
    if (key) headers[API_KEY_HEADER] = key;
    return headers;
  }

  function buildDom() {
    if (ui.overlay) return;
    const overlay = el(document, 'aside', {
      id: ENTITY_CHAT_ID,
      className: 'od-chat',
      attrs: {
        role: 'dialog',
        'aria-labelledby': `${ENTITY_CHAT_ID}-title`,
        'aria-modal': 'false',
        'data-open': 'false',
      },
    });
    overlay.hidden = true;

    const header = el(document, 'header', { className: 'od-chat__header' });
    header.appendChild(
      el(document, 'span', {
        className: 'od-chat__brand',
        text: 'ASK ONDEMAND',
      }),
    );
    const titles = el(document, 'div', { className: 'od-chat__titles' });
    ui.title = el(document, 'strong', {
      id: `${ENTITY_CHAT_ID}-title`,
      className: 'od-chat__title',
      text: 'NO ENTITY',
    });
    ui.mgrs = el(document, 'span', {
      id: `${ENTITY_CHAT_ID}-mgrs`,
      className: 'od-chat__mgrs',
      text: 'MGRS ---',
    });
    titles.appendChild(ui.title);
    titles.appendChild(ui.mgrs);
    header.appendChild(titles);
    ui.keyState = el(document, 'span', {
      id: `${ENTITY_CHAT_ID}-key-state`,
      className: 'od-chat__key-state',
      text: 'server key',
      attrs: {
        title: 'Which OnDemand key the proxy will use for your requests',
      },
    });
    header.appendChild(ui.keyState);
    ui.keyToggle = el(document, 'button', {
      id: `${ENTITY_CHAT_ID}-key-toggle`,
      className: 'od-chat__icon-btn',
      text: 'KEY',
      attrs: {
        type: 'button',
        'aria-expanded': 'false',
        'aria-controls': `${ENTITY_CHAT_ID}-key-row`,
        title: 'OnDemand API key (optional, stored in this browser only)',
      },
    });
    header.appendChild(ui.keyToggle);
    ui.close = el(document, 'button', {
      id: `${ENTITY_CHAT_ID}-close`,
      className: 'od-chat__icon-btn od-chat__close',
      text: '×',
      attrs: { type: 'button', 'aria-label': 'Close ASK ONDEMAND' },
    });
    header.appendChild(ui.close);
    overlay.appendChild(header);

    ui.keyRow = el(document, 'div', {
      id: `${ENTITY_CHAT_ID}-key-row`,
      className: 'od-chat__key-row',
    });
    ui.keyRow.hidden = true;
    const keyLabel = el(document, 'label', {
      className: 'od-chat__key-label',
      text: 'OnDemand API key (optional, stored in this browser only)',
      attrs: { for: `${ENTITY_CHAT_ID}-key` },
    });
    ui.keyInput = el(document, 'input', {
      id: `${ENTITY_CHAT_ID}-key`,
      className: 'od-chat__key-input',
      attrs: {
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'paste a key to use it instead of the server key',
      },
    });
    ui.keySave = el(document, 'button', {
      id: `${ENTITY_CHAT_ID}-key-save`,
      className: 'od-chat__btn',
      text: 'SAVE',
      attrs: { type: 'button' },
    });
    ui.keyClear = el(document, 'button', {
      id: `${ENTITY_CHAT_ID}-key-clear`,
      className: 'od-chat__btn od-chat__btn--ghost',
      text: 'CLEAR',
      attrs: { type: 'button' },
    });
    ui.keyRow.appendChild(keyLabel);
    ui.keyRow.appendChild(ui.keyInput);
    ui.keyRow.appendChild(ui.keySave);
    ui.keyRow.appendChild(ui.keyClear);
    overlay.appendChild(ui.keyRow);

    const statusRow = el(document, 'div', { className: 'od-chat__status-row' });
    ui.status = el(document, 'span', {
      id: `${ENTITY_CHAT_ID}-status`,
      className: 'od-chat__status',
      text: 'IDLE',
    });
    ui.latency = el(document, 'span', {
      id: `${ENTITY_CHAT_ID}-latency`,
      className: 'od-chat__badge',
      text: 'first token —',
    });
    ui.latency.hidden = true;
    statusRow.appendChild(ui.status);
    statusRow.appendChild(ui.latency);
    overlay.appendChild(statusRow);

    ui.transcript = el(document, 'div', {
      id: `${ENTITY_CHAT_ID}-transcript`,
      className: 'od-chat__transcript',
      attrs: {
        role: 'log',
        'aria-live': 'polite',
        'aria-relevant': 'additions text',
      },
    });
    overlay.appendChild(ui.transcript);

    const composer = el(document, 'form', { className: 'od-chat__composer' });
    ui.input = el(document, 'input', {
      id: `${ENTITY_CHAT_ID}-input`,
      className: 'od-chat__input',
      attrs: {
        type: 'text',
        autocomplete: 'off',
        placeholder: 'Ask about this entity…',
        'aria-label': 'Message OnDemand about the selected entity',
      },
    });
    ui.send = el(document, 'button', {
      id: `${ENTITY_CHAT_ID}-send`,
      className: 'od-chat__btn od-chat__send',
      text: 'SEND',
      attrs: { type: 'submit' },
    });
    composer.appendChild(ui.input);
    composer.appendChild(ui.send);
    overlay.appendChild(composer);

    composer.addEventListener('submit', (event) => {
      event?.preventDefault?.();
      void send(ui.input.value);
    });
    ui.send.addEventListener('click', (event) => {
      event?.preventDefault?.();
      void send(ui.input.value);
    });
    ui.close.addEventListener('click', () => close());
    ui.keyToggle.addEventListener('click', () => {
      const show = ui.keyRow.hidden;
      ui.keyRow.hidden = !show;
      ui.keyToggle.setAttribute('aria-expanded', show ? 'true' : 'false');
      ui.keyInput.value = '';
      if (show) ui.keyInput.focus?.();
    });
    ui.keySave.addEventListener('click', () => {
      setApiKey(ui.keyInput.value);
      ui.keyInput.value = '';
    });
    ui.keyClear.addEventListener('click', () => {
      setApiKey('');
      ui.keyInput.value = '';
    });
    overlay.addEventListener('keydown', (event) => {
      if (event?.key === 'Escape') close();
    });

    ui.overlay = overlay;
    (document.body || document.documentElement).appendChild(overlay);
    syncKeyState();
  }

  function syncKeyState() {
    if (!ui.keyState) return;
    const hasKey = Boolean(readStoredApiKey(storage));
    ui.keyState.textContent = hasKey ? 'using your key' : 'server key';
    ui.keyState.setAttribute('data-key-source', hasKey ? 'request' : 'server');
    if (ui.keyInput)
      ui.keyInput.setAttribute(
        'placeholder',
        hasKey
          ? 'a key is stored in this browser (••••) — paste a new one to replace it'
          : 'paste a key to use it instead of the server key',
      );
  }

  function setApiKey(value) {
    writeStoredApiKey(storage, value);
    syncKeyState();
    return Boolean(readStoredApiKey(storage));
  }

  function setStatus(text) {
    state.statusText = text;
    if (ui.status) ui.status.textContent = text;
  }

  function appendMessage(role, text) {
    const message = { role, text: text ?? '' };
    state.messages.push(message);
    if (ui.transcript) {
      const node = el(document, 'div', {
        className: `od-chat__msg od-chat__msg--${role}`,
        text: message.text,
        attrs: { 'data-role': role },
      });
      message.node = node;
      ui.transcript.appendChild(node);
      if (typeof ui.transcript.scrollTop === 'number')
        ui.transcript.scrollTop = 1e9;
    }
    return message;
  }

  function updateMessage(message, text) {
    message.text = text;
    if (message.node) message.node.textContent = text;
    if (ui.transcript && typeof ui.transcript.scrollTop === 'number')
      ui.transcript.scrollTop = 1e9;
  }

  function clearTranscript() {
    state.messages = [];
    // Setting textContent drops every child node in one step.
    if (ui.transcript) ui.transcript.textContent = '';
  }

  function shortSession(id) {
    const text = String(id || '');
    return text.length > 8 ? `…${text.slice(-6)}` : text;
  }

  function setLatency(ms) {
    state.lastFirstTokenMs = ms;
    if (!ui.latency) return;
    if (ms === null) {
      ui.latency.hidden = true;
      ui.latency.textContent = 'first token —';
      ui.latency.removeAttribute?.('data-ms');
      return;
    }
    ui.latency.hidden = false;
    ui.latency.textContent = `first token in ${Math.round(ms)} ms`;
    ui.latency.setAttribute('data-ms', String(Math.round(ms)));
  }

  function renderHeader(context) {
    const entity = context?.entity || {};
    const kind = KIND_LABEL[entity.kind] || 'ENTITY';
    const label = entity.callsign || entity.name || entity.id || 'UNKNOWN';
    if (ui.title) ui.title.textContent = `${kind} · ${label}`;
    if (ui.mgrs)
      ui.mgrs.textContent = `MGRS ${context?.scene?.coordinates?.mgrs || '---'}`;
    if (ui.input)
      ui.input.setAttribute(
        'placeholder',
        `Ask about this ${kind.toLowerCase()}…`,
      );
  }

  async function postJson(path, body) {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method: 'POST',
      headers: keyHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return response;
  }

  /** Create-or-reuse the per-entity session and run the context turn once. */
  function ensureSession(entityKey, input) {
    const existing = sessions.get(entityKey);
    if (existing) return existing;
    const entry = {
      sessionId: null,
      context: null,
      primedOk: false,
      error: null,
      primeMs: null,
    };
    entry.promise = (async () => {
      setStatus('BUILDING CONTEXT…');
      const context = await buildContext(input);
      entry.context = context;
      if (state.entityKey === entityKey) {
        state.context = context;
        renderHeader(context);
      }
      setStatus('OPENING SESSION…');
      const sessionResponse = await postJson('/api/ondemand/sessions', {
        userId: externalUserIdFor(new Date(now())),
        reuse: false,
      });
      const sessionBody = await readJsonSafe(sessionResponse);
      if (!sessionResponse.ok || !sessionBody?.sessionId) {
        throw new Error(proxyErrorMessage(sessionResponse.status, sessionBody));
      }
      entry.sessionId = String(sessionBody.sessionId);
      if (state.entityKey === entityKey) state.sessionId = entry.sessionId;
      setStatus(`LOADING CONTEXT · session ${shortSession(entry.sessionId)}`);
      const started = performanceNow();
      const query = entitySystemPrompt(context);
      const primeBody = {
        sessionId: entry.sessionId,
        query,
        responseMode: 'sync',
        fulfillmentOnly: true,
      };
      if (endpointId) primeBody.endpointId = endpointId;
      const primeResponse = await postJson('/api/ondemand/chat', primeBody);
      const primeJson = await readJsonSafe(primeResponse);
      entry.primeMs = Math.round(performanceNow() - started);
      if (!primeResponse.ok) {
        entry.error = proxyErrorMessage(primeResponse.status, primeJson);
        entry.primedOk = false;
      } else {
        entry.primedOk = true;
        entry.primeAnswer =
          typeof primeJson?.data?.answer === 'string'
            ? primeJson.data.answer
            : null;
      }
      return entry;
    })().catch((error) => {
      entry.error = error?.message || String(error);
      sessions.delete(entityKey);
      throw error;
    });
    sessions.set(entityKey, entry);
    return entry;
  }

  function summarizeContext(context) {
    const layers = Array.isArray(context?.layers) ? context.layers : [];
    const enabled = layers.filter((row) => row.enabled).length;
    const nearby = ['aircraft', 'vessels', 'satellites'].reduce(
      (sum, key) =>
        sum +
        (Array.isArray(context?.nearby?.[key])
          ? context.nearby[key].length
          : 0),
      0,
    );
    return `${enabled}/${layers.length} layers on · ${nearby} nearby`;
  }

  /**
   * Open the overlay for an entity. `kind` may be omitted when the entity
   * carries a selection-lane `layerId`.
   * @param {{ entity: object, kind?: 'aircraft'|'vessel'|'satellite', layerId?: string }} input
   */
  async function open({ entity, kind, layerId } = {}) {
    if (destroyed) return null;
    const resolvedKind = kind || kindForLayer(layerId || entity?.layerId);
    if (!resolvedKind || !entity) {
      state.error = 'nothing selected';
      return null;
    }
    buildDom();
    const entityKey = entityKeyFor(resolvedKind, entity);
    const switching = state.entityKey !== entityKey;
    state.entityKey = entityKey;
    state.kind = resolvedKind;
    state.entity = entity;
    state.open = true;
    state.error = null;
    ui.overlay.hidden = false;
    ui.overlay.setAttribute('data-open', 'true');
    ui.overlay.setAttribute('data-entity-kind', resolvedKind);
    ui.overlay.setAttribute('data-entity-key', entityKey);
    if (switching) {
      clearTranscript();
      setLatency(null);
      state.sessionId = null;
      state.context = null;
      renderHeader(buildEntityContext({ entity, kind: resolvedKind }));
    }
    syncKeyState();
    ui.input.focus?.();
    const entry = ensureSession(entityKey, { entity, kind: resolvedKind });
    const fresh = !entry.sessionId && !entry.error;
    try {
      await entry.promise;
    } catch (error) {
      if (state.entityKey !== entityKey) return null;
      setStatus('SESSION FAILED');
      appendMessage('error', error?.message || String(error));
      return null;
    }
    if (state.entityKey !== entityKey) return entry;
    state.sessionId = entry.sessionId;
    state.context = entry.context;
    renderHeader(entry.context);
    if (entry.primedOk) {
      setStatus(
        `READY · ${summarizeContext(entry.context)} · session ${shortSession(entry.sessionId)}`,
      );
      if (fresh)
        appendMessage(
          'system',
          `Context loaded (${summarizeContext(entry.context)}) in ${entry.primeMs} ms · OnDemand: ${entry.primeAnswer || 'ok'}`,
        );
    } else {
      setStatus(
        `CONTEXT TURN FAILED · session ${shortSession(entry.sessionId)}`,
      );
      if (fresh) appendMessage('error', entry.error || 'context turn failed');
    }
    return entry;
  }

  /** Stream one user message through the proxy. Resolves when the turn ends. */
  async function send(text) {
    const query = typeof text === 'string' ? text.trim() : '';
    if (!query || state.busy || !state.open || destroyed) return null;
    const entityKey = state.entityKey;
    const entry = sessions.get(entityKey);
    if (!entry) {
      appendMessage('error', 'no session for this entity — reopen the chat');
      return null;
    }
    state.busy = true;
    if (ui.send) ui.send.disabled = true;
    if (ui.input) ui.input.value = '';
    appendMessage('user', query);
    const assistant = appendMessage('assistant', '');
    assistant.node?.setAttribute?.('data-streaming', 'true');
    const turn = {
      query,
      firstTokenMs: null,
      totalMs: null,
      chars: 0,
      ok: false,
      error: null,
    };
    state.turns.push(turn);
    try {
      try {
        await entry.promise;
      } catch {
        // the open() path already reported the session failure
      }
      if (!entry.sessionId)
        throw new Error(entry.error || 'session unavailable');
      setStatus('STREAMING…');
      setLatency(null);
      abortController =
        typeof AbortController === 'function' ? new AbortController() : null;
      const started = performanceNow();
      const body = {
        sessionId: entry.sessionId,
        query,
        responseMode: 'stream',
      };
      if (endpointId) body.endpointId = endpointId;
      const response = await fetchImpl(`${apiBase}/api/ondemand/chat`, {
        method: 'POST',
        headers: keyHeaders({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }),
        body: JSON.stringify(body),
        signal: abortController?.signal,
      });
      if (!response.ok) {
        throw new Error(
          proxyErrorMessage(response.status, await readJsonSafe(response)),
        );
      }
      const parser = createSseParser();
      const decoder = new TextDecoder();
      let answer = '';
      let done = false;
      let streamError = null;
      const handle = (events) => {
        for (const event of events) {
          if (event.type === 'fulfillment') {
            if (turn.firstTokenMs === null) {
              turn.firstTokenMs = Math.round(performanceNow() - started);
              setLatency(turn.firstTokenMs);
            }
            answer += event.answer;
            updateMessage(assistant, answer);
          } else if (event.type === 'status' && event.statusMessage) {
            setStatus(`STREAMING · ${event.statusMessage}`);
          } else if (event.type === 'done') {
            done = true;
          } else if (event.type === 'error') {
            streamError = event.message;
          }
        }
      };
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          handle(parser.push(decoder.decode(value, { stream: true })));
          if (done || streamError) break;
        }
        handle(parser.push(decoder.decode()));
      } else {
        handle(parser.push(await response.text()));
      }
      handle(parser.flush());
      turn.totalMs = Math.round(performanceNow() - started);
      turn.chars = answer.length;
      if (streamError) throw new Error(`stream error · ${streamError}`);
      if (!answer)
        updateMessage(
          assistant,
          done ? '(empty answer)' : '(no answer received)',
        );
      turn.ok = true;
      setStatus(
        `READY · session ${shortSession(entry.sessionId)} · last turn ${turn.totalMs} ms`,
      );
    } catch (error) {
      turn.error = error?.message || String(error);
      if (!assistant.text) {
        assistant.node?.setAttribute?.('data-role', 'error');
        assistant.node?.classList?.remove?.('od-chat__msg--assistant');
        assistant.node?.classList?.add?.('od-chat__msg--error');
        assistant.role = 'error';
      }
      updateMessage(
        assistant,
        assistant.text ? `${assistant.text}\n\n[${turn.error}]` : turn.error,
      );
      setStatus('TURN FAILED');
    } finally {
      assistant.node?.removeAttribute?.('data-streaming');
      abortController = null;
      state.busy = false;
      if (ui.send) ui.send.disabled = false;
      ui.input?.focus?.();
    }
    return turn;
  }

  function close() {
    if (!ui.overlay) return;
    state.open = false;
    ui.overlay.hidden = true;
    ui.overlay.setAttribute('data-open', 'false');
    try {
      abortController?.abort();
    } catch {
      // nothing in flight
    }
  }

  function noteSelection(selection) {
    state.selection =
      selection && kindForLayer(selection.layerId) ? { ...selection } : null;
    const button = document?.getElementById?.(ASK_BUTTON_ID);
    if (button) {
      button.hidden = !state.selection;
      if (state.selection) {
        button.setAttribute(
          'data-entity-kind',
          kindForLayer(state.selection.layerId),
        );
        button.title = `Ask OnDemand about ${state.selection.label || state.selection.id}`;
      }
    }
    if (state.open && state.selection) void openSelected();
  }

  /** Open the chat for whatever the operator has selected on the globe. */
  function openSelected() {
    const resolved = resolveSelectedEntity({
      dataManager: deps.dataManager,
      window: win,
      selection: state.selection,
    });
    if (!resolved) {
      state.error = 'nothing selected';
      return Promise.resolve(null);
    }
    return open(resolved);
  }

  /**
   * Harness helper: select the first rendered contact of a kind through the
   * layer's own track/select API, then open the chat for it.
   */
  async function openFirstVisible(kind = 'aircraft') {
    const layerId = {
      aircraft: 'flights',
      vessel: 'ais-live-vessels',
      satellite: 'satellites',
    }[kind];
    const module = deps.dataManager?.layers?.get?.(layerId)?.module;
    const first = module?.getAllPositions?.(1)?.[0];
    if (!first) {
      state.error = `no rendered ${kind} to select`;
      return null;
    }
    try {
      if (kind === 'vessel') module.selectById?.(first.id);
      else module.trackById?.(first.id, { origin: 'programmatic' });
    } catch {
      // selection is best effort; the entity is still opened below
    }
    state.selection = { layerId, id: first.id, label: first.label };
    const resolved = resolveSelectedEntity({
      dataManager: deps.dataManager,
      window: win,
      selection: state.selection,
    });
    return open(
      resolved || {
        kind,
        entity: { ...first, layerId },
      },
    );
  }

  function destroy() {
    destroyed = true;
    close();
    if (ui.overlay?.parentNode?.removeChild)
      ui.overlay.parentNode.removeChild(ui.overlay);
    for (const key of Object.keys(ui)) delete ui[key];
    sessions.clear();
  }

  function getState() {
    return {
      open: state.open,
      entityKey: state.entityKey,
      kind: state.kind,
      sessionId: state.sessionId,
      sessionCount: sessions.size,
      busy: state.busy,
      lastFirstTokenMs: state.lastFirstTokenMs,
      turns: state.turns.map((turn) => ({ ...turn })),
      messages: state.messages.map(({ role, text }) => ({ role, text })),
      statusText: state.statusText || null,
      selection: state.selection ? { ...state.selection } : null,
      hasStoredKey: Boolean(readStoredApiKey(storage)),
      error: state.error,
    };
  }

  return {
    open,
    openSelected,
    openFirstVisible,
    send,
    close,
    destroy,
    noteSelection,
    setApiKey,
    getState,
    getContext: () => state.context,
    selectors: SELECTORS,
    elements: ui,
  };
}

/**
 * Production wiring: build the controller, follow the selection lanes the
 * tracking layers publish, and drive the ASK ONDEMAND button. Returns the
 * controller; tears itself down when `signal` aborts.
 */
export function installEntityChat({
  viewer,
  dataManager,
  signal,
  document = globalThis.document,
  window: win = globalThis.window,
  fetch: fetchImpl,
  storage,
  endpointId = null,
} = {}) {
  const controller = createEntityChat({
    viewer,
    dataManager,
    document,
    window: win,
    fetch: fetchImpl,
    storage,
    endpointId,
  });
  const onSubjectSelected = (event) => {
    const detail = event?.detail;
    if (!detail || !kindForLayer(detail.layerId)) return;
    controller.noteSelection({
      layerId: detail.layerId,
      id: detail.id,
      label: detail.label,
    });
  };
  const onEntitySelected = (event) => {
    const record = event?.detail;
    if (!record || !kindForLayer(record.layerId)) return;
    controller.noteSelection({
      layerId: record.layerId,
      id: record.id,
      label: record.label,
    });
  };
  const onCleared = (event) => {
    const layerId = event?.detail?.layerId;
    const current = controller.getState().selection;
    if (!current || !layerId || current.layerId === layerId)
      controller.noteSelection(null);
  };
  win?.addEventListener?.('gev:awareness-subject-selected', onSubjectSelected);
  win?.addEventListener?.('gev:entity-selected', onEntitySelected);
  win?.addEventListener?.('gev:awareness-subject-cleared', onCleared);
  win?.addEventListener?.('gev:entity-selection-cleared', onCleared);
  const button = document?.getElementById?.(ASK_BUTTON_ID);
  const onAsk = () => void controller.openSelected();
  button?.addEventListener?.('click', onAsk);
  const teardown = () => {
    win?.removeEventListener?.(
      'gev:awareness-subject-selected',
      onSubjectSelected,
    );
    win?.removeEventListener?.('gev:entity-selected', onEntitySelected);
    win?.removeEventListener?.('gev:awareness-subject-cleared', onCleared);
    win?.removeEventListener?.('gev:entity-selection-cleared', onCleared);
    button?.removeEventListener?.('click', onAsk);
    controller.destroy();
  };
  if (signal?.aborted) teardown();
  else signal?.addEventListener?.('abort', teardown, { once: true });
  return controller;
}
