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
  entitySystemInstruction,
  fitContextToBudget,
  kindForLayer,
  normalizeEntity,
  SATELLITE_RADIUS_KM,
  MAX_NEARBY,
} from './entityContext.js';
import { resolveCameraEntity, summarizeRoads } from './cameraContext.js';
import { setIconContent } from '../ui/icons/layerIcon.js';

export const ENTITY_CHAT_ID = 'ondemand-entity-chat';
export const API_KEY_STORAGE_KEY = 'ondemand.apiKey';
export const API_KEY_HEADER = 'x-ondemand-key';
export const API_KEY_MAX_LEN = 128;
export const EXTERNAL_USER_PREFIX = 'ondemand-spatial-entity-';
export const ASK_BUTTON_ID = 'ask-ondemand-btn';
/** localStorage prefix for the per-camera session id (one session per camera). */
export const SESSION_STORAGE_PREFIX = 'ondemand.session.';
/** Proxy profile name for camera turns (server applies endpoint/agents/mode). */
export const CAMERA_PROFILE = 'camera';
/** Pages of history pulled on open (limit per page comes from the server). */
export const HISTORY_MAX_PAGES = 3;
/** Byte budget for the per-turn fulfillmentPrompt context (camera turns). */
export const TURN_CONTEXT_BYTES = 12 * 1024;
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
  attach: `#${ENTITY_CHAT_ID}-attach`,
  message: '.od-chat__msg',
  assistantMessage: '.od-chat__msg--assistant',
  historyMessage: '.od-chat__msg[data-history="true"]',
});
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const KIND_LABEL = Object.freeze({
  aircraft: 'AIRCRAFT',
  vessel: 'VESSEL',
  satellite: 'SATELLITE',
  camera: 'CAMERA',
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

/** Stored `{ sessionId, createdAtUtc }` for an entity key, or null. */
export function readStoredSession(storage, entityKey) {
  try {
    const raw = storage?.getItem?.(`${SESSION_STORAGE_PREFIX}${entityKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.sessionId === 'string' && parsed.sessionId
      ? {
          sessionId: parsed.sessionId,
          createdAtUtc: parsed.createdAtUtc || null,
        }
      : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, for null) the entity key → session id mapping. */
export function writeStoredSession(storage, entityKey, record) {
  try {
    const key = `${SESSION_STORAGE_PREFIX}${entityKey}`;
    if (!record?.sessionId) storage?.removeItem?.(key);
    else
      storage?.setItem?.(
        key,
        JSON.stringify({
          sessionId: String(record.sessionId),
          createdAtUtc: record.createdAtUtc || new Date().toISOString(),
        }),
      );
  } catch {
    // storage unavailable — the session stays in memory only
  }
}

/**
 * Flatten a cursor-paginated `GET …/messages` payload list (oldest first)
 * into transcript rows. Media messages become a system line; the context
 * prime turn (its query starts with the analyst instruction) is collapsed.
 */
export function historyRows(pages) {
  const messages = [];
  for (const page of Array.isArray(pages) ? pages : [])
    for (const message of Array.isArray(page?.data) ? page.data : [])
      messages.push(message);
  messages.sort((a, b) =>
    String(a?.createdAt || '').localeCompare(String(b?.createdAt || '')),
  );
  const rows = [];
  for (const message of messages) {
    if (message?.type === 'media') {
      rows.push({
        role: 'system',
        text: `frame attached · ${message.media?.name || message.media?.id || 'media'}${message.createdAt ? ` · ${message.createdAt}` : ''}`,
        id: message.id || null,
      });
      continue;
    }
    const query = typeof message?.query === 'string' ? message.query : '';
    const answer = typeof message?.answer === 'string' ? message.answer : '';
    if (query.startsWith('You are the OnDemand Spatial analyst')) {
      rows.push({
        role: 'system',
        text: `context loaded earlier · OnDemand: ${answer || 'ok'}`,
        id: message.id || null,
      });
      continue;
    }
    if (query) rows.push({ role: 'user', text: query, id: message.id || null });
    if (answer)
      rows.push({ role: 'assistant', text: answer, id: message.id || null });
  }
  return rows;
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
  if (!kind || kind === 'camera') return null;
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
  const resolveCamera =
    deps.resolveCamera ??
    ((input) =>
      resolveCameraEntity({
        dataManager: deps.dataManager,
        document,
        fetch: fetchImpl,
        ...input,
      }));
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
    attachNext: false,
    lastAttachment: null,
    history: { loaded: false, pages: 0, rows: 0, error: null },
    cameraConfig: null,
    apiCalls: [],
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
      attrs: { type: 'button', 'aria-label': 'Close ASK ONDEMAND' },
    });
    // Inline Lucide close icon; the button's aria-label names it.
    setIconContent(ui.close, 'x', {}, document);
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
    // Camera kind only: attach the current frame to the next question
    // (inline Lucide image-plus; the aria-label names it).
    ui.attach = el(document, 'button', {
      id: `${ENTITY_CHAT_ID}-attach`,
      className: 'od-chat__icon-btn od-chat__attach',
      attrs: {
        type: 'button',
        'aria-label': 'Attach the current camera frame to the next question',
        'aria-pressed': 'false',
        title: 'Attach current camera frame',
      },
    });
    setIconContent(ui.attach, 'image-plus', {}, document);
    ui.attach.hidden = true;
    composer.appendChild(ui.attach);
    composer.appendChild(ui.input);
    composer.appendChild(ui.send);
    overlay.appendChild(composer);
    ui.attach.addEventListener('click', (event) => {
      event?.preventDefault?.();
      setAttachNext(!state.attachNext);
    });

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

  function setAttachNext(on) {
    state.attachNext = Boolean(on) && state.kind === 'camera';
    if (!ui.attach) return;
    ui.attach.setAttribute('aria-pressed', state.attachNext ? 'true' : 'false');
    ui.attach.setAttribute(
      'data-attach',
      state.attachNext ? 'pending' : 'idle',
    );
    ui.attach.title = state.attachNext
      ? 'Frame will be attached to the next question (click to cancel)'
      : 'Attach current camera frame';
  }

  function noteApiCall(entry) {
    state.apiCalls.push({ atUtc: new Date(now()).toISOString(), ...entry });
    if (state.apiCalls.length > 50) state.apiCalls.shift();
  }

  /** Camera turns: the analyst instruction + a budget-fitted fresh context. */
  function turnPrompt(context) {
    const instruction = entitySystemInstruction(context).replace(
      /\nReply to this first message with exactly: READY$/,
      '',
    );
    const fitted = fitContextToBudget(context, TURN_CONTEXT_BYTES);
    return `${instruction}\n\nCONTEXT_JSON:\n${JSON.stringify(fitted)}`;
  }

  /**
   * Capture the frame the panel shows (same-origin proxy URL) and upload it
   * through the Media API proxy, linked to the session by `sessionId`
   * (docs/media-api: multipart file, name, sessionId, plugins, sizeBytes,
   * responseMode). Resolves `{ mediaId, name, bytes, capturedAtUtc }`.
   */
  async function attachFrame(entry, context) {
    const frame = context?.entity?.frame;
    if (!frame?.url) throw new Error('no camera frame to attach');
    const started = performanceNow();
    const frameResponse = await fetchImpl(frame.url, { cache: 'no-store' });
    if (!frameResponse?.ok)
      throw new Error(`frame fetch failed · HTTP ${frameResponse?.status}`);
    const blob = await frameResponse.blob();
    const mime =
      blob.type && /^image\//.test(blob.type) ? blob.type : 'image/jpeg';
    const extension = mime === 'image/png' ? 'png' : 'jpg';
    const capturedAtUtc = frame.capturedAtUtc || new Date(now()).toISOString();
    const name = `${(context?.entity?.cameraId || 'camera').replace(/[^A-Za-z0-9_-]+/g, '_')}-${capturedAtUtc.replace(/[:.]/g, '-')}.${extension}`;
    const plugin = state.cameraConfig?.imagePluginId;
    if (!plugin)
      throw new Error('image plugin id unavailable (health not loaded)');
    const form = new FormData();
    form.append('file', blob, name);
    form.append('name', name);
    form.append('sessionId', entry.sessionId);
    form.append('plugins', plugin);
    form.append('sizeBytes', String(blob.size));
    form.append('responseMode', 'sync');
    const response = await fetchImpl(`${apiBase}/api/ondemand/media`, {
      method: 'POST',
      headers: keyHeaders({ Accept: 'application/json' }),
      body: form,
    });
    const json = await readJsonSafe(response);
    noteApiCall({
      call: 'media.upload',
      url: '/api/ondemand/media',
      status: response.status,
      ms: Math.round(performanceNow() - started),
    });
    if (!response.ok) throw new Error(proxyErrorMessage(response.status, json));
    const mediaId = json?.data?.id;
    if (!mediaId) throw new Error('media upload returned no data.id');
    return {
      mediaId: String(mediaId),
      name,
      bytes: blob.size,
      mime,
      capturedAtUtc,
      actionStatus: json?.data?.actionStatus || null,
      context:
        typeof json?.data?.context === 'string' ? json.data.context : null,
    };
  }

  /**
   * Cursor-paginated history (GET …/messages via the proxy, docs reference
   * getchatmessages): first page without `cursor`, then `pagination.next`
   * until it is an empty string or HISTORY_MAX_PAGES is reached.
   */
  async function loadHistory(entry) {
    const pages = [];
    let cursor = null;
    const limit = state.cameraConfig?.historyLimit || 20;
    for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        sessionId: entry.sessionId,
        limit: String(limit),
        sort: 'desc',
      });
      if (cursor) params.set('cursor', cursor);
      const started = performanceNow();
      const response = await fetchImpl(
        `${apiBase}/api/ondemand/sessions?${params.toString()}`,
        { headers: keyHeaders({ Accept: 'application/json' }) },
      );
      const json = await readJsonSafe(response);
      noteApiCall({
        call: 'sessions.messages',
        url: `/api/ondemand/sessions?sessionId=…&limit=${limit}${cursor ? '&cursor=…' : ''}`,
        status: response.status,
        ms: Math.round(performanceNow() - started),
      });
      if (!response.ok)
        throw new Error(proxyErrorMessage(response.status, json));
      pages.push(json);
      cursor =
        typeof json?.pagination?.next === 'string' ? json.pagination.next : '';
      if (!cursor) break;
    }
    return pages;
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
    if (ui.attach) ui.attach.hidden = entity.kind !== 'camera';
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
    const isCamera = input?.kind === 'camera';
    const entry = {
      sessionId: null,
      context: null,
      primedOk: false,
      error: null,
      primeMs: null,
      reused: false,
      historyRows: [],
    };
    entry.promise = (async () => {
      setStatus('BUILDING CONTEXT…');
      const context = await buildContext(input);
      entry.context = context;
      if (state.entityKey === entityKey) {
        state.context = context;
        renderHeader(context);
      }
      // One session per camera, persisted across page loads: reuse the
      // stored id (history is reloaded below) instead of opening another.
      const stored = isCamera ? readStoredSession(storage, entityKey) : null;
      if (stored) {
        entry.sessionId = stored.sessionId;
        entry.reused = true;
        if (state.entityKey === entityKey) state.sessionId = entry.sessionId;
        setStatus(
          `RELOADING HISTORY · session ${shortSession(entry.sessionId)}`,
        );
        try {
          const pages = await loadHistory(entry);
          entry.historyRows = historyRows(pages);
          state.history = {
            loaded: true,
            pages: pages.length,
            rows: entry.historyRows.length,
            error: null,
          };
          entry.primedOk = true;
          entry.primeAnswer = `history ${entry.historyRows.length} rows`;
          entry.primeMs = 0;
          return entry;
        } catch (error) {
          // The stored session is gone (404) or unreadable — forget it and
          // open a fresh one below.
          state.history = {
            loaded: false,
            pages: 0,
            rows: 0,
            error: error?.message || String(error),
          };
          writeStoredSession(storage, entityKey, null);
          entry.sessionId = null;
          entry.reused = false;
        }
      }
      setStatus('OPENING SESSION…');
      const startedSession = performanceNow();
      const sessionResponse = await postJson('/api/ondemand/sessions', {
        userId: externalUserIdFor(new Date(now())),
        reuse: false,
      });
      const sessionBody = await readJsonSafe(sessionResponse);
      noteApiCall({
        call: 'sessions.create',
        url: '/api/ondemand/sessions',
        status: sessionResponse.status,
        ms: Math.round(performanceNow() - startedSession),
      });
      if (!sessionResponse.ok || !sessionBody?.sessionId) {
        throw new Error(proxyErrorMessage(sessionResponse.status, sessionBody));
      }
      entry.sessionId = String(sessionBody.sessionId);
      if (isCamera)
        writeStoredSession(storage, entityKey, {
          sessionId: entry.sessionId,
          createdAtUtc: sessionBody.createdAt || new Date(now()).toISOString(),
        });
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
      if (isCamera) primeBody.profile = CAMERA_PROFILE;
      const primeResponse = await postJson('/api/ondemand/chat', primeBody);
      const primeJson = await readJsonSafe(primeResponse);
      entry.primeMs = Math.round(performanceNow() - started);
      noteApiCall({
        call: 'chat.prime',
        url: '/api/ondemand/chat',
        status: primeResponse.status,
        ms: entry.primeMs,
      });
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
    if (context?.entity?.kind === 'camera') {
      const frame = context.entity.frame?.capturedAtUtc
        ? `frame ${context.entity.frame.capturedAtUtc}`
        : 'no frame';
      return `${enabled}/${layers.length} layers on · ${summarizeRoads(context.entity.roads)} · ${frame}`;
    }
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
    setAttachNext(false);
    ui.input.focus?.();
    if (resolvedKind === 'camera' && !state.cameraConfig) {
      const health = await fetchJsonTolerant(
        fetchImpl,
        `${apiBase}/api/ondemand/health`,
        keyHeaders(),
      );
      state.cameraConfig = health?.cameraChat || null;
      state.serverConfigured = health?.configured === true;
      if (health && health.configured !== true && !readStoredApiKey(storage)) {
        setStatus('NOT CONFIGURED · ONDEMAND_API_KEY is not set on the server');
        appendMessage(
          'error',
          'OnDemand is not configured on this deployment (health: "not configured"). Set ONDEMAND_API_KEY on the server, or paste a key under KEY, to chat about this camera.',
        );
      }
    }
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
    if (fresh && entry.reused && entry.historyRows.length) {
      for (const row of entry.historyRows) {
        const message = appendMessage(row.role, row.text);
        message.node?.setAttribute?.('data-history', 'true');
        if (row.id) message.node?.setAttribute?.('data-message-id', row.id);
      }
    }
    if (entry.primedOk) {
      setStatus(
        `READY · ${summarizeContext(entry.context)} · session ${shortSession(entry.sessionId)}`,
      );
      if (fresh && entry.reused)
        appendMessage(
          'system',
          `Session resumed · ${entry.historyRows.length} history rows · ${summarizeContext(entry.context)}`,
        );
      else if (fresh)
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
  async function send(text, options = {}) {
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
    // The assistant bubble is created once the turn is ready to stream so a
    // camera "frame attached" note lands between the question and the answer.
    let assistant = null;
    const turn = {
      query,
      firstTokenMs: null,
      totalMs: null,
      chars: 0,
      ok: false,
      error: null,
      attachment: null,
      events: 0,
      status: null,
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
      const body = {
        sessionId: entry.sessionId,
        query,
        responseMode: 'stream',
      };
      if (endpointId) body.endpointId = endpointId;
      if (state.kind === 'camera') {
        body.profile = CAMERA_PROFILE;
        // Fresh context every turn (frame time, traffic sample, layers).
        let context = entry.context;
        try {
          const refreshed = await resolveCamera({
            cameraId:
              entry.context?.entity?.cameraId || state.entity?.cameraId || null,
          });
          if (refreshed?.entity) {
            context = await buildContext({
              entity: refreshed.entity,
              kind: 'camera',
            });
            entry.context = context;
            state.context = context;
            renderHeader(context);
          }
        } catch {
          // keep the last context
        }
        body.modelConfigs = { fulfillmentPrompt: turnPrompt(context) };
        if (state.attachNext || options.attachFrame) {
          setStatus('ATTACHING FRAME…');
          const attachment = await attachFrame(entry, context);
          state.lastAttachment = attachment;
          turn.attachment = attachment;
          body.attachment = { mediaId: attachment.mediaId };
          appendMessage(
            'system',
            `frame attached · ${attachment.name} · ${attachment.bytes} B · media ${attachment.mediaId}${attachment.actionStatus ? ` · ${attachment.actionStatus}` : ''}`,
          );
          setAttachNext(false);
        }
      }
      assistant = appendMessage('assistant', '');
      assistant.node?.setAttribute?.('data-streaming', 'true');
      setStatus('STREAMING…');
      setLatency(null);
      abortController =
        typeof AbortController === 'function' ? new AbortController() : null;
      const started = performanceNow();
      const response = await fetchImpl(`${apiBase}/api/ondemand/chat`, {
        method: 'POST',
        headers: keyHeaders({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }),
        body: JSON.stringify(body),
        signal: abortController?.signal,
      });
      turn.status = response.status;
      noteApiCall({
        call: 'chat.stream',
        url: '/api/ondemand/chat',
        status: response.status,
        ms: Math.round(performanceNow() - started),
        attachment: body.attachment?.mediaId || null,
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
          if (event.type !== 'heartbeat') turn.events += 1;
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
      if (!assistant) assistant = appendMessage('assistant', '');
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
      assistant?.node?.removeAttribute?.('data-streaming');
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
    if (kindForLayer(state.selection?.layerId) === 'camera')
      return openCamera({ cameraId: state.selection?.id ?? null });
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
   * Open the chat for the CCTV layer's active camera (or `cameraId`):
   * resolves the camera entity with lanes/traffic/frame and opens ONE
   * session for it (docs/ONDEMAND_CAMERA_CHAT_ADDENDUM_2026-09-21.md).
   */
  async function openCamera({ cameraId = null } = {}) {
    // Show the panel immediately; the lanes lookup (Overpass) can take a
    // few seconds and must never make the button feel dead.
    buildDom();
    if (!state.open) {
      ui.overlay.hidden = false;
      ui.overlay.setAttribute('data-open', 'true');
      ui.overlay.setAttribute('data-entity-kind', 'camera');
      state.open = true;
      setStatus('RESOLVING CAMERA…');
    }
    let resolved = null;
    try {
      resolved = await resolveCamera({ cameraId });
    } catch (error) {
      state.error = error?.message || String(error);
      return null;
    }
    if (!resolved?.entity?.id) {
      state.error = 'no active camera — enable CCTV and select a camera first';
      setStatus('NO ACTIVE CAMERA');
      if (!state.entityKey) appendMessage('error', state.error);
      return null;
    }
    state.selection = {
      layerId: 'cctv',
      id: resolved.entity.id,
      label: resolved.entity.name,
    };
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
      attachNext: state.attachNext,
      lastAttachment: state.lastAttachment ? { ...state.lastAttachment } : null,
      history: { ...state.history },
      cameraConfig: state.cameraConfig ? { ...state.cameraConfig } : null,
      serverConfigured: state.serverConfigured ?? null,
      apiCalls: state.apiCalls.map((call) => ({ ...call })),
    };
  }

  return {
    open,
    openSelected,
    openFirstVisible,
    openCamera,
    setAttachNext,
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
  // CCTV panel ASK button (src/ui/cctvBindings.js) — the camera chat.
  const onAskCamera = (event) =>
    void controller.openCamera({ cameraId: event?.detail?.cameraId ?? null });
  win?.addEventListener?.('gev:ask-camera', onAskCamera);
  const teardown = () => {
    win?.removeEventListener?.(
      'gev:awareness-subject-selected',
      onSubjectSelected,
    );
    win?.removeEventListener?.('gev:entity-selected', onEntitySelected);
    win?.removeEventListener?.('gev:awareness-subject-cleared', onCleared);
    win?.removeEventListener?.('gev:entity-selection-cleared', onCleared);
    button?.removeEventListener?.('click', onAsk);
    win?.removeEventListener?.('gev:ask-camera', onAskCamera);
    controller.destroy();
  };
  if (signal?.aborted) teardown();
  else signal?.addEventListener?.('abort', teardown, { once: true });
  return controller;
}
