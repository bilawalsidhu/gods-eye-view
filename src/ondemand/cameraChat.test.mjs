/**
 * Camera chat (ASK ONDEMAND on a live street camera) — controller behaviour
 * under a fake DOM: one persisted session per camera, camera profile on
 * every turn, frame attach through the Media API proxy, cursor-paginated
 * history reload, keyless "not configured" state, lucide-only controls.
 * docs/ONDEMAND_CAMERA_CHAT_ADDENDUM_2026-09-21.md
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityChat,
  installEntityChat,
  historyRows,
  readStoredSession,
  writeStoredSession,
  SELECTORS,
  SESSION_STORAGE_PREFIX,
  CAMERA_PROFILE,
} from './entityChat.js';

// ------------------------------------------------------------ fake DOM
function makeElement(document, tagName) {
  const element = {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    hidden: false,
    disabled: false,
    value: '',
    title: '',
    scrollTop: 0,
    parentNode: null,
    attributes: {},
    listeners: {},
    children: [],
    _text: '',
    innerHTML: '',
    classList: {
      add(...names) {
        const set = new Set(element.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        element.className = [...set].join(' ');
      },
      remove(...names) {
        const set = new Set(element.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.delete(n);
        element.className = [...set].join(' ');
      },
      contains(name) {
        return element.className.split(/\s+/).includes(name);
      },
    },
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      element.children = element.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
    replaceChildren(...nodes) {
      element.children = [];
      for (const node of nodes) element.appendChild(node);
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
      if (name === 'id') element.id = String(value);
    },
    getAttribute(name) {
      return element.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete element.attributes[name];
    },
    addEventListener(type, handler) {
      (element.listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      element.listeners[type] = (element.listeners[type] || []).filter((h) => h !== handler);
    },
    dispatch(type, event = {}) {
      for (const handler of element.listeners[type] || []) handler({ type, preventDefault() {}, ...event });
    },
    click() {
      element.dispatch('click');
    },
    focus() {},
    get firstChild() {
      return element.children[0] || null;
    },
    querySelector(selector) {
      return findAll(element, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return findAll(element, selector);
    },
  };
  Object.defineProperty(element, 'textContent', {
    get() {
      if (element.children.length) return element.children.map((c) => c.textContent).join('');
      return element._text;
    },
    set(value) {
      element.children = [];
      element._text = String(value);
    },
  });
  return element;
}
function matches(el, selector) {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('[')) {
    const [, name, value] = /\[([^=\]]+)(?:="([^"]*)")?\]/.exec(selector) || [];
    return value === undefined ? name in el.attributes : el.attributes[name] === value;
  }
  return el.tagName === selector.toUpperCase();
}
function findAll(root, selector) {
  const out = [];
  const walk = (el) => {
    for (const child of el.children || []) {
      if (matches(child, selector)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}
function makeDocument() {
  const document = { activeElement: null };
  document.createElement = (tag) => makeElement(document, tag);
  document.createElementNS = (_ns, tag) => makeElement(document, tag);
  document.createTextNode = (text) => ({ textContent: text, children: [], parentNode: null });
  document.body = makeElement(document, 'body');
  document.documentElement = document.body;
  document.getElementById = (id) => findAll(document.body, `#${id}`)[0] || null;
  document.querySelector = (selector) => findAll(document.body, selector)[0] || null;
  return document;
}
function makeWindow() {
  const listeners = {};
  return {
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((h) => h !== handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners[event.type] || []) handler(event);
      return true;
    },
  };
}
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function sse(frames) {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (i >= frames.length) return controller.close();
        controller.enqueue(encoder.encode(frames[i++]));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}
const ANSWER_FRAMES = [
  'event:message\ndata:{"eventType":"statusLog","status":"processing","currentStatusLog":{"statusType":"executing","statusMessage":"Running Internet Agent","executedAgents":[{"agentId":"agent-1713924030"}]}}\n\n',
  'event:heartbeat\ndata:{"time":"t"}\n\n',
  'event:message\ndata:{"eventType":"fulfillment","answer":"Two","eventIndex":1}\n\nevent:message\ndata:{"eventType":"fulfillment","answer":" lanes each way.","eventIndex":2}\n\n',
  'event:message\ndata:{"eventType":"metricsLog","publicMetrics":{"totalTokens":3}}\n\nevent:message\ndata:[DONE]\n\n',
];

const CAMERA = {
  layerId: 'cctv',
  id: 'atd-mlk-comal',
  cameraId: 'atd-mlk-comal',
  name: 'MARTIN LUTHER KING JR BLVD / COMAL ST',
  label: 'MARTIN LUTHER KING JR BLVD / COMAL ST',
  streets: ['Martin Luther King Jr Blvd', 'Comal St'],
  city: 'Austin',
  provider: 'ATD',
  lat: 30.28108,
  lon: -97.72259,
  headingDeg: 95,
  fovDeg: 62,
  frame: { url: '/api/cctv/frame/atd-mlk-comal?ts=42', capturedAtUtc: '2026-09-21T10:00:10.000Z', ageSec: 3, status: 'shown' },
  roads: [{ name: 'East Martin Luther King Jr Boulevard', highway: 'primary', lanes: 4, lanesForward: 2, lanesBackward: 2 }],
  traffic: { layerEnabled: true, mode: 'live', closedRoads: 0 },
};

function makeFetch({ configured = true, history = null, mediaStatus = 200 } = {}) {
  const calls = [];
  let sessions = 0;
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), init, method: init.method || 'GET' };
    if (typeof init.body === 'string') call.body = JSON.parse(init.body);
    if (init.body && typeof init.body.get === 'function') call.form = init.body;
    calls.push(call);
    const path = call.url.split('?')[0];
    if (path === '/api/tools') return json(404, { ok: false });
    if (path === '/api/ondemand/health')
      return json(200, {
        ondemand: configured ? 'healthy' : 'not configured',
        configured,
        cameraChat: { profile: 'camera', endpointId: 'predefined-cerebras-qwen-3.8-27b', pluginIds: ['agent-1713924030'], reasoningMode: 'low', imagePluginId: 'plugin-1713958591', historyLimit: 20 },
      });
    if (path === '/api/cctv/frame/atd-mlk-comal')
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (path === '/api/ondemand/media') {
      if (!configured) return json(503, { error: 'not_configured' });
      return json(mediaStatus, mediaStatus === 200 ? { message: 'Media Created', data: { id: 'media-777', name: 'x.jpg', source: 'image', actionStatus: 'completed', context: 'two cars, empty crosswalk' } } : { error: 'upstream' });
    }
    if (path === '/api/ondemand/sessions') {
      if (!configured) return json(503, { error: 'not_configured', message: 'ONDEMAND_API_KEY is not set on the server.' });
      if (call.method === 'GET') {
        const params = new URL(call.url, 'http://x').searchParams;
        if (!history) return json(404, { error: 'not_found' });
        const page = params.get('cursor') ? history[1] : history[0];
        return json(200, page);
      }
      sessions += 1;
      return json(201, { sessionId: `sess-${sessions}-camera`, externalUserId: call.body.userId, reused: false, createdAt: '2026-09-21T10:00:00.000Z' });
    }
    if (path === '/api/ondemand/chat') {
      if (!configured) return json(503, { error: 'not_configured' });
      if (call.body.responseMode === 'sync') return json(200, { data: { answer: 'READY', status: 'completed' } });
      return sse(ANSWER_FRAMES);
    }
    return json(404, { error: 'not_found' });
  };
  return { fetchImpl, calls };
}

function harness(options = {}) {
  const document = makeDocument();
  const window = makeWindow();
  const storage = options.storage ?? makeStorage();
  const { fetchImpl, calls } = makeFetch(options);
  let t = 1000;
  const controller = createEntityChat({
    document,
    window,
    fetch: fetchImpl,
    storage,
    now: () => Date.parse('2026-09-21T10:00:30Z'),
    performanceNow: () => (t += 7),
    dataManager: { getAll: () => [{ id: 'traffic', name: 'Street Traffic', enabled: true, source: 'TomTom', stats: { count: 12, lastUpdate: Date.now() } }], layers: new Map() },
    resolveCamera: async ({ cameraId } = {}) => ({ kind: 'camera', layerId: 'cctv', entity: { ...CAMERA, id: cameraId || CAMERA.id, cameraId: cameraId || CAMERA.id } }),
  });
  const byId = (selector) => document.getElementById(selector.slice(1));
  return { document, window, storage, calls, controller, byId };
}

describe('camera chat — one persisted session per camera, camera profile on every turn', () => {
  test('openCamera() opens ONE session, primes it with profile camera, stores the id per camera, shows the lucide attach button', async () => {
    const h = harness();
    await h.controller.openCamera();
    const state = h.controller.getState();
    assert.equal(state.kind, 'camera');
    assert.equal(state.entityKey, 'camera:atd-mlk-comal');
    assert.equal(state.sessionId, 'sess-1-camera');
    assert.equal(h.byId(SELECTORS.title).textContent, 'CAMERA · MARTIN LUTHER KING JR BLVD / COMAL ST');
    assert.match(h.byId(SELECTORS.mgrs).textContent, /^MGRS 14R PU \d{4} \d{4}$/);

    const sessionCalls = h.calls.filter((c) => c.url === '/api/ondemand/sessions' && c.method === 'POST');
    assert.equal(sessionCalls.length, 1);
    const prime = h.calls.find((c) => c.url === '/api/ondemand/chat');
    assert.equal(prime.body.profile, CAMERA_PROFILE);
    assert.equal(prime.body.responseMode, 'sync');
    assert.ok(prime.body.query.includes('live street camera'));
    assert.ok(prime.body.query.includes('"cameraId":"atd-mlk-comal"'));
    assert.ok(prime.body.query.includes('"lanesForward":2'));
    assert.ok(prime.body.query.includes('Street Traffic'));

    const stored = readStoredSession(h.storage, 'camera:atd-mlk-comal');
    assert.equal(stored.sessionId, 'sess-1-camera');
    assert.equal(h.storage.getItem(`${SESSION_STORAGE_PREFIX}camera:atd-mlk-comal`).includes('sess-1-camera'), true);

    const attach = h.byId(SELECTORS.attach);
    assert.equal(attach.hidden, false, 'attach-frame button shown for the camera kind');
    assert.equal(attach.getAttribute('aria-pressed'), 'false');
    assert.ok(attach.querySelector('[data-icon="image-plus"]'), 'lucide inline SVG, no emoji/ligature');
    assert.equal(attach.querySelector('svg').getAttribute('stroke-width'), '1.75');
    assert.ok(h.byId(SELECTORS.close).querySelector('[data-icon="x"]'));
    assert.match(h.byId(SELECTORS.status).textContent, /^READY · 1\/1 layers on · 1 ways \(1 named\) · lanes tagged on 1 · frame 2026-09-21T10:00:10.000Z/);

    // Reopening the same camera reuses the in-memory session — no second create.
    await h.controller.openCamera({ cameraId: 'atd-mlk-comal' });
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/sessions' && c.method === 'POST').length, 1);
    assert.equal(h.controller.getState().sessionCount, 1);
  });

  test('send() streams with profile camera + per-turn fulfillmentPrompt context; attach-next uploads the frame via the Media API proxy and names it in the query', async () => {
    const h = harness();
    await h.controller.openCamera();
    h.byId(SELECTORS.attach).click();
    assert.equal(h.controller.getState().attachNext, true);
    assert.equal(h.byId(SELECTORS.attach).getAttribute('aria-pressed'), 'true');

    const turn = await h.controller.send('Are there any vehicles or pedestrians in the crosswalk right now?');
    assert.equal(turn.ok, true);
    assert.equal(turn.events > 0, true, 'SSE events counted');
    assert.equal(turn.attachment.mediaId, 'media-777');

    const upload = h.calls.find((c) => c.url === '/api/ondemand/media');
    assert.ok(upload, 'media upload went through the same-origin proxy');
    assert.equal(upload.method, 'POST');
    assert.equal(upload.form.get('sessionId'), 'sess-1-camera');
    assert.equal(upload.form.get('plugins'), 'plugin-1713958591');
    assert.equal(upload.form.get('responseMode'), 'sync');
    assert.equal(upload.form.get('sizeBytes'), '7');
    assert.match(upload.form.get('name'), /^atd-mlk-comal-2026-09-21T10-00-10-000Z\.jpg$/);
    assert.ok(upload.form.get('file') instanceof Blob);
    assert.equal(upload.init.headers['Content-Type'], undefined, 'multipart boundary left to fetch');

    const frameFetch = h.calls.find((c) => c.url.startsWith('/api/cctv/frame/'));
    assert.ok(frameFetch, 'the frame is captured from the same-origin camera proxy');

    const stream = h.calls.filter((c) => c.url === '/api/ondemand/chat' && c.body?.responseMode === 'stream');
    assert.equal(stream.length, 1);
    assert.equal(stream[0].body.profile, CAMERA_PROFILE);
    assert.deepEqual(stream[0].body.attachment, { mediaId: 'media-777' });
    assert.equal(stream[0].body.endpointId, undefined, 'the server picks the (vision) endpoint for the profile');
    assert.ok(stream[0].body.modelConfigs.fulfillmentPrompt.includes('CONTEXT_JSON'));
    assert.ok(!stream[0].body.modelConfigs.fulfillmentPrompt.includes('exactly: READY'));
    assert.ok(Buffer.byteLength(stream[0].body.modelConfigs.fulfillmentPrompt) < 13 * 1024);
    assert.equal(stream[0].init.headers.Accept, 'text/event-stream');

    const messages = h.controller.getState().messages;
    assert.ok(messages.some((m) => m.role === 'system' && m.text.includes('frame attached') && m.text.includes('media-777')));
    assert.equal(messages.at(-1).role, 'assistant');
    assert.equal(messages.at(-1).text, 'Two lanes each way.');
    assert.equal(h.controller.getState().attachNext, false, 'attach flag resets after the turn');
    const calls = h.controller.getState().apiCalls.map((c) => c.call);
    assert.deepEqual(calls, ['sessions.create', 'chat.prime', 'media.upload', 'chat.stream']);
    assert.ok(h.controller.getState().apiCalls.every((c) => typeof c.status === 'number' && typeof c.ms === 'number' && /Z$/.test(c.atUtc)));

    // A text-only turn carries no attachment and does not touch the Media API.
    await h.controller.send('How many lanes are on MLK here?');
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/media').length, 1);
    const second = h.calls.filter((c) => c.url === '/api/ondemand/chat' && c.body?.responseMode === 'stream').at(-1);
    assert.equal(second.body.attachment, undefined);
    assert.equal(second.body.profile, CAMERA_PROFILE);
  });

  test('a stored session is reused across page loads and its history is reloaded through cursor pagination (oldest first)', async () => {
    const storage = makeStorage();
    writeStoredSession(storage, 'camera:atd-mlk-comal', { sessionId: 'sess-stored-1', createdAtUtc: '2026-09-21T09:00:00Z' });
    const history = [
      {
        data: [
          { id: 'm3', type: 'text', query: 'How many lanes?', answer: 'Four.', createdAt: '2026-09-21T09:02:00Z' },
          { id: 'm2', type: 'media', media: { id: 'media-1', name: 'atd-frame.jpg', source: 'image' }, createdAt: '2026-09-21T09:01:00Z' },
        ],
        pagination: { next: 'cursor-2', limit: 20 },
      },
      {
        data: [{ id: 'm1', type: 'text', query: 'You are the OnDemand Spatial analyst embedded…', answer: 'READY', createdAt: '2026-09-21T09:00:30Z' }],
        pagination: { next: '', limit: 20 },
      },
    ];
    const h = harness({ storage, history });
    await h.controller.openCamera();
    const state = h.controller.getState();
    assert.equal(state.sessionId, 'sess-stored-1');
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/sessions' && c.method === 'POST').length, 0, 'no new session created');
    const pages = h.calls.filter((c) => c.url.startsWith('/api/ondemand/sessions?') && c.method === 'GET');
    assert.equal(pages.length, 2);
    assert.ok(pages[0].url.includes('sessionId=sess-stored-1') && pages[0].url.includes('limit=20') && !pages[0].url.includes('cursor='));
    assert.ok(pages[1].url.includes('cursor=cursor-2'));
    assert.deepEqual(state.history, { loaded: true, pages: 2, rows: 4, error: null });
    assert.deepEqual(
      state.messages.map((m) => [m.role, m.text.slice(0, 22)]),
      [
        ['system', 'context loaded earlier'],
        ['system', 'frame attached · atd-f'],
        ['user', 'How many lanes?'],
        ['assistant', 'Four.'],
        ['system', 'Session resumed · 4 hi'],
      ],
    );
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/chat').length, 0, 'no re-prime on a reused session');
    assert.equal(findAll(h.byId(SELECTORS.transcript), '[data-history="true"]').length, 4);
  });

  test('a stored session that no longer exists upstream (404 on history) is forgotten and a fresh one opened', async () => {
    const storage = makeStorage();
    writeStoredSession(storage, 'camera:atd-mlk-comal', { sessionId: 'sess-gone' });
    const h = harness({ storage, history: null });
    await h.controller.openCamera();
    assert.equal(h.controller.getState().sessionId, 'sess-1-camera');
    assert.equal(readStoredSession(storage, 'camera:atd-mlk-comal').sessionId, 'sess-1-camera');
    assert.match(h.controller.getState().history.error, /proxy 404/);
  });

  test('keyless server: the panel states NOT CONFIGURED instead of failing silently', async () => {
    const h = harness({ configured: false });
    await h.controller.openCamera();
    const state = h.controller.getState();
    assert.equal(state.serverConfigured, false);
    assert.ok(state.messages.some((m) => m.role === 'error' && m.text.includes('not configured') && m.text.includes('ONDEMAND_API_KEY')));
    assert.equal(state.sessionId, null);
    assert.match(h.byId(SELECTORS.status).textContent, /SESSION FAILED/);
    assert.ok(state.messages.some((m) => m.role === 'error' && /proxy 503 · not_configured/.test(m.text)));
  });

  test('a failed frame upload fails the turn loudly and never sends the query without its frame', async () => {
    const h = harness({ mediaStatus: 502 });
    await h.controller.openCamera();
    h.controller.setAttachNext(true);
    const turn = await h.controller.send('What is in the crosswalk?');
    assert.equal(turn.ok, false);
    assert.match(turn.error, /proxy 502/);
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/chat' && c.body?.responseMode === 'stream').length, 0);
  });

  test('historyRows collapses media + prime messages and orders by createdAt', () => {
    const rows = historyRows([
      { data: [{ type: 'text', query: 'b', answer: 'B', createdAt: '2026-01-01T00:00:02Z' }, { type: 'media', media: { name: 'f.jpg' }, createdAt: '2026-01-01T00:00:01Z' }] },
    ]);
    assert.deepEqual(rows.map((r) => r.role), ['system', 'user', 'assistant']);
    assert.deepEqual(historyRows(null), []);
  });

  test('installEntityChat wires the CCTV panel ASK button event (gev:ask-camera) to openCamera', async () => {
    const document = makeDocument();
    const window = makeWindow();
    const { fetchImpl, calls } = makeFetch();
    const abort = new AbortController();
    const controller = installEntityChat({ dataManager: { getAll: () => [], layers: new Map() }, signal: abort.signal, document, window, fetch: fetchImpl, storage: makeStorage() });
    // No CCTV layer in this fake → openCamera reports the missing camera.
    window.dispatchEvent({ type: 'gev:ask-camera', detail: { cameraId: 'atd-mlk-comal' } });
    await new Promise((r) => setTimeout(r, 0));
    assert.match(controller.getState().error, /no active camera/);
    assert.equal(calls.filter((c) => c.url === '/api/ondemand/sessions').length, 0);
    abort.abort();
  });
});
