// ASK ONDEMAND entity chat controller (docs/ENTITY_CHAT.md).
// Drives the overlay with a fake DOM, a scripted fetch and a fake clock:
// one session per entity, the context on the first turn, streamed tokens
// accumulating, first-token latency recorded, the browser-only key sent as
// a header and nowhere else, proxy reasons rendered verbatim.
// Run with: node --test src/ondemand/entityChat.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_KEY_HEADER,
  API_KEY_STORAGE_KEY,
  ENTITY_CHAT_ID,
  SELECTORS,
  createEntityChat,
  createSseParser,
  externalUserIdFor,
  installEntityChat,
  proxyErrorMessage,
  readStoredApiKey,
  writeStoredApiKey,
  resolveSelectedEntity,
} from './entityChat.js';
import { ENTITY_CONTEXT_SCHEMA } from './entityContext.js';

const LEAK_KEY = 'test-key-DO-NOT-LEAK';

// ---------------------------------------------------------------- fake DOM
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
    focus() {
      document.activeElement = element;
    },
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

function findAll(root, selector) {
  const out = [];
  const matches = (node) => {
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    return node.tagName === selector.toUpperCase();
  };
  const walk = (node) => {
    for (const child of node.children) {
      if (matches(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Every string a user could see: text nodes, attributes and input values. */
function allVisibleStrings(root) {
  const out = [];
  const walk = (node) => {
    out.push(node._text, node.value, node.title, ...Object.values(node.attributes));
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out.filter((s) => typeof s === 'string' && s.length);
}

function makeDocument() {
  const document = { activeElement: null };
  document.createElement = (tag) => makeElement(document, tag);
  document.body = makeElement(document, 'body');
  document.documentElement = document.body;
  document.getElementById = (id) => findAll(document.body, `#${id}`)[0] || null;
  document.querySelector = (selector) => findAll(document.body, selector)[0] || null;
  return document;
}

function makeWindow() {
  const listeners = {};
  return {
    __gevContextStore: { entities: new Map(), selectedEntityId: null },
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
    listenerCount: (type) => (listeners[type] || []).length,
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

// ------------------------------------------------------------ fake fetch
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sse(frames, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frames[i]));
      i += 1;
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

const READY_FRAMES = [
  'event:message\ndata:{"eventType":"statusLog","status":"processing","currentStatusLog":{"statusType":"fulfilling","statusMessage":"Fulfilling the prompt..."}}\n\n',
  'event:heartbeat\ndata:{"time":"t"}\n\n',
  'event:message\ndata:{"eventType":"fulfillment","answer":"Hello","eventIndex":1}\n\nevent:message\ndata:{"eventType":"fulfillment","answer":" world","eventIndex":2}\n\n',
  'event:message\ndata:{"eventType":"fulfillment","answer":".","eventIndex":3}\n\nevent:message\ndata:{"eventType":"metricsLog","publicMetrics":{"totalTokens":3}}\n\n',
  'event:message\ndata:[DONE]\n\n',
];

function makeFetch(overrides = {}) {
  const calls = [];
  let sessionCounter = 0;
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const path = call.url.split('?')[0];
    if (overrides[path]) return overrides[path](call);
    if (path === '/api/tools')
      return json(200, {
        ok: true,
        tools: [
          {
            id: 'ondemand-spatial-satellites',
            name: 'Satellites',
            tools: [{ name: 'list_satellites_in_scene', path: '/api/tools/list_satellites_in_scene', params: { lat: {}, lon: {} } }],
          },
        ],
      });
    if (path === '/api/ondemand/health')
      return json(200, { ondemand: 'healthy', configured: true, config: { flowVersion: { source: 'default', resolvedVia: 'default' }, spatialFlowId: { source: 'default' } } });
    if (path === '/api/tools/list_satellites_in_scene') return json(404, { ok: false, error: { code: 'unknown_tool' } });
    if (path === '/api/ondemand/sessions') {
      sessionCounter += 1;
      return json(201, { sessionId: `sess-${sessionCounter}-abc123def456`, externalUserId: call.body.userId, reused: false });
    }
    if (path === '/api/ondemand/chat') {
      if (call.body.responseMode === 'sync')
        return json(200, { message: 'ok', data: { sessionId: call.body.sessionId, messageId: 'm1', answer: 'READY', status: 'completed' } });
      return sse(READY_FRAMES);
    }
    return json(404, { error: 'not_found' });
  };
  return { fetchImpl, calls };
}

function makeClock() {
  let t = 1000;
  return {
    performanceNow: () => {
      t += 5;
      return t;
    },
    now: () => Date.parse('2026-09-18T12:00:00Z'),
  };
}

const AIRCRAFT = {
  icao24: 'a1b2c3',
  callsign: 'UAL1234',
  latitude: 30.2672,
  longitude: -97.7431,
  altitudeM: 10668,
  velocityMps: 236,
  track: 272,
};
const VESSEL = { mmsi: '366999999', name: 'TEXAS STAR', latitude: 29.9, longitude: -95.9, speedKt: 12 };

function harness({ storage = makeStorage(), fetchOverrides, dataManager } = {}) {
  const document = makeDocument();
  const window = makeWindow();
  const { fetchImpl, calls } = makeFetch(fetchOverrides);
  const clock = makeClock();
  const controller = createEntityChat({
    document,
    window,
    fetch: fetchImpl,
    storage,
    now: clock.now,
    performanceNow: clock.performanceNow,
    dataManager: dataManager ?? { getAll: () => [{ id: 'flights', name: 'Live Flights', enabled: true, source: 'OpenSky', stats: { count: 3, lastUpdate: clock.now() - 1000, source: 'OpenSky' } }], layers: new Map() },
  });
  const byId = (selector) => document.getElementById(selector.slice(1));
  return { document, window, calls, controller, storage, byId };
}

describe('createEntityChat — sessions and the context turn', () => {
  test('open() creates ONE session per entity and sends the context as the first (sync) turn', async () => {
    const h = harness();
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });

    const overlay = h.byId(SELECTORS.overlay);
    assert.ok(overlay, 'overlay appended to document.body');
    assert.equal(overlay.hidden, false);
    assert.equal(overlay.getAttribute('data-open'), 'true');
    assert.equal(h.byId(SELECTORS.title).textContent, 'AIRCRAFT · UAL1234');
    assert.equal(h.byId(SELECTORS.mgrs).textContent, 'MGRS 14R PU 2090 4906');

    const sessionCalls = h.calls.filter((c) => c.url === '/api/ondemand/sessions');
    assert.equal(sessionCalls.length, 1);
    assert.equal(sessionCalls[0].init.method, 'POST');
    assert.deepEqual(sessionCalls[0].body, { userId: 'ondemand-spatial-entity-2026-09-18', reuse: false });

    const chatCalls = h.calls.filter((c) => c.url === '/api/ondemand/chat');
    assert.equal(chatCalls.length, 1, 'exactly one context turn');
    const prime = chatCalls[0].body;
    assert.equal(prime.sessionId, 'sess-1-abc123def456');
    assert.equal(prime.responseMode, 'sync');
    assert.equal(prime.fulfillmentOnly, true);
    assert.match(prime.query, /^You are the OnDemand Spatial analyst/);
    const [, contextJson] = prime.query.split('\nCONTEXT_JSON:\n');
    const context = JSON.parse(contextJson);
    assert.equal(context.schema, ENTITY_CONTEXT_SCHEMA);
    assert.equal(context.entity.icao24, 'a1b2c3');
    assert.equal(context.layers[0].id, 'flights');
    assert.equal(context.tools.catalogue[0].tools[0].name, 'list_satellites_in_scene');
    assert.ok(new TextEncoder().encode(prime.query).length <= 32 * 1024);
    assert.deepEqual(
      Object.keys(prime).sort(),
      ['fulfillmentOnly', 'query', 'responseMode', 'sessionId'],
      'only documented proxy fields are sent',
    );

    const state = h.controller.getState();
    assert.equal(state.sessionId, 'sess-1-abc123def456');
    assert.equal(state.sessionCount, 1);
    assert.match(state.statusText, /^READY · 1\/1 layers on · 0 nearby · session …def456$/);
    assert.equal(state.messages[0].role, 'system');
    assert.match(state.messages[0].text, /Context loaded .* OnDemand: READY/);
  });

  test('reopening the same entity reuses the session; another entity gets its own', async () => {
    const h = harness();
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    h.controller.close();
    assert.equal(h.byId(SELECTORS.overlay).hidden, true);
    await h.controller.open({ entity: { ...AIRCRAFT, altitudeM: 11000 }, kind: 'aircraft' });
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/sessions').length, 1);
    assert.equal(h.controller.getState().messages.length, 1, 'transcript kept');

    await h.controller.open({ entity: VESSEL, kind: 'vessel' });
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/sessions').length, 2);
    assert.equal(h.controller.getState().sessionId, 'sess-2-abc123def456');
    assert.equal(h.controller.getState().sessionCount, 2);
    assert.equal(h.byId(SELECTORS.title).textContent, 'VESSEL · TEXAS STAR');
    assert.equal(h.controller.getState().messages.length, 1, 'fresh transcript per entity');

    await h.controller.open({ entity: AIRCRAFT, layerId: 'flights' });
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/sessions').length, 2, 'kind derived from layerId, session reused');
  });

  test('a proxy failure on session create renders the proxy reason', async () => {
    const h = harness({
      fetchOverrides: {
        '/api/ondemand/sessions': () => json(503, { error: 'not_configured', message: 'ONDEMAND_API_KEY is not set on the server.' }),
      },
    });
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    const state = h.controller.getState();
    assert.equal(state.sessionId, null);
    assert.equal(state.statusText, 'SESSION FAILED');
    assert.equal(state.messages.at(-1).role, 'error');
    assert.equal(state.messages.at(-1).text, 'proxy 503 · not_configured · ONDEMAND_API_KEY is not set on the server.');
    // the failed entry is dropped, so a retry goes upstream again
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    assert.equal(h.calls.filter((c) => c.url === '/api/ondemand/sessions').length, 2);
  });
});

describe('createEntityChat — streaming turns', () => {
  test('send() streams fulfillment deltas into the assistant bubble and records first-token latency', async () => {
    const h = harness();
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    const turn = await h.controller.send('  Where is it heading?  ');

    const streamCall = h.calls.filter((c) => c.url === '/api/ondemand/chat').at(-1);
    assert.deepEqual(streamCall.body, { sessionId: 'sess-1-abc123def456', query: 'Where is it heading?', responseMode: 'stream' });
    assert.equal(streamCall.init.headers.Accept, 'text/event-stream');

    const messages = h.controller.getState().messages;
    assert.deepEqual(messages.slice(-2).map((m) => [m.role, m.text]), [
      ['user', 'Where is it heading?'],
      ['assistant', 'Hello world.'],
    ]);
    const bubbles = h.byId(SELECTORS.transcript).querySelectorAll(SELECTORS.assistantMessage);
    assert.equal(bubbles.at(-1).textContent, 'Hello world.');
    assert.equal(bubbles.at(-1).getAttribute('data-streaming'), null, 'streaming flag cleared');

    assert.equal(turn.ok, true);
    assert.ok(turn.firstTokenMs > 0, `firstTokenMs=${turn.firstTokenMs}`);
    assert.ok(turn.totalMs >= turn.firstTokenMs);
    assert.equal(turn.chars, 12);
    const badge = h.byId(SELECTORS.latencyBadge);
    assert.equal(badge.hidden, false);
    assert.match(badge.textContent, /^first token in \d+ ms$/);
    assert.equal(badge.getAttribute('data-ms'), String(turn.firstTokenMs));
    assert.equal(h.controller.getState().lastFirstTokenMs, turn.firstTokenMs);
    assert.match(h.controller.getState().statusText, /^READY · session …def456 · last turn \d+ ms$/);
    assert.equal(h.byId(SELECTORS.input).value, '', 'composer cleared');
    assert.equal(h.byId(SELECTORS.send).disabled, false);
  });

  test('the send button / form submit drive send() and empty input is ignored', async () => {
    const h = harness();
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    h.byId(SELECTORS.input).value = '   ';
    h.byId(SELECTORS.send).click();
    assert.equal(h.calls.filter((c) => c.body?.responseMode === 'stream').length, 0);
    h.byId(SELECTORS.input).value = 'hi';
    h.byId(SELECTORS.send).click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.calls.filter((c) => c.body?.responseMode === 'stream').length, 1);
  });

  test('a non-2xx stream response renders the proxy reason; a [ERROR] frame renders the upstream message', async () => {
    let mode = 'rate';
    const h = harness({
      fetchOverrides: {
        '/api/ondemand/chat': (call) => {
          if (call.body.responseMode === 'sync') return json(200, { data: { answer: 'READY' } });
          if (mode === 'rate') return json(429, { error: 'rate_limit_exceeded', message: 'slow down' });
          return sse(['event:message\ndata:{"eventType":"fulfillment","answer":"Par"}\n\n', 'event:message\ndata:[ERROR]:{"message":"Model context length exceeded","errorCode":"context_length_exceeded"}\n\n']);
        },
      },
    });
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    const first = await h.controller.send('q1');
    assert.equal(first.ok, false);
    assert.equal(first.error, 'proxy 429 · rate_limit_exceeded · slow down');
    assert.equal(h.controller.getState().messages.at(-1).role, 'error');
    assert.equal(h.controller.getState().messages.at(-1).text, 'proxy 429 · rate_limit_exceeded · slow down');

    mode = 'error-frame';
    const second = await h.controller.send('q2');
    assert.equal(second.ok, false);
    assert.equal(second.error, 'stream error · Model context length exceeded');
    assert.equal(h.controller.getState().messages.at(-1).text, 'Par\n\n[stream error · Model context length exceeded]');
  });
});

describe('createEntityChat — browser-only key', () => {
  test('a stored key travels ONLY as the x-ondemand-key header: never in a body, never in the DOM', async () => {
    const storage = makeStorage({ [API_KEY_STORAGE_KEY]: LEAK_KEY });
    const h = harness({ storage });
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    await h.controller.send('anything');

    const proxyCalls = h.calls.filter((c) => c.url === '/api/ondemand/sessions' || c.url === '/api/ondemand/chat');
    assert.equal(proxyCalls.length, 3, 'session create + context turn + one streamed turn');
    for (const call of proxyCalls) {
      assert.equal(call.init.headers[API_KEY_HEADER], LEAK_KEY, call.url);
      assert.equal(String(call.init.body || '').includes(LEAK_KEY), false, `body leak on ${call.url}`);
      assert.equal(call.url.includes(LEAK_KEY), false, 'url leak');
    }
    // Diagnostics and the tool catalogue never receive the key at all.
    for (const call of h.calls.filter((c) => !proxyCalls.includes(c))) {
      assert.equal(API_KEY_HEADER in (call.init.headers || {}), false, call.url);
    }
    for (const call of h.calls) {
      assert.equal(JSON.stringify(call.body || {}).includes(LEAK_KEY), false);
    }
    const strings = allVisibleStrings(h.document.body);
    assert.ok(strings.length > 10);
    assert.equal(strings.some((s) => s.includes(LEAK_KEY)), false, 'the key must never be rendered');
    assert.equal(JSON.stringify(h.controller.getState()).includes(LEAK_KEY), false);
    assert.equal(h.byId(SELECTORS.keyState).textContent, 'using your key');
    assert.equal(h.byId(SELECTORS.keyState).getAttribute('data-key-source'), 'request');
    assert.equal(h.controller.getState().hasStoredKey, true);
  });

  test('without a stored key no header is sent and the indicator says "server key"', async () => {
    const h = harness();
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    for (const call of h.calls) assert.equal(API_KEY_HEADER in call.init.headers, false, call.url);
    assert.equal(h.byId(SELECTORS.keyState).textContent, 'server key');
    assert.equal(h.controller.getState().hasStoredKey, false);
  });

  test('the overlay key field writes localStorage and the next request picks it up; CLEAR removes it', async () => {
    const h = harness();
    await h.controller.open({ entity: AIRCRAFT, kind: 'aircraft' });
    h.byId(SELECTORS.keyToggle).click();
    assert.equal(h.byId(SELECTORS.keyRow).hidden, false);
    const input = h.byId(SELECTORS.keyInput);
    assert.equal(input.getAttribute('type'), 'password');
    input.value = `  ${LEAK_KEY}  `;
    h.byId(SELECTORS.keySave).click();
    assert.equal(h.storage.dump()[API_KEY_STORAGE_KEY], LEAK_KEY);
    assert.equal(input.value, '', 'the field is emptied after saving');
    assert.equal(h.byId(SELECTORS.keyState).textContent, 'using your key');
    await h.controller.send('now with key');
    assert.equal(h.calls.at(-1).init.headers[API_KEY_HEADER], LEAK_KEY);
    assert.equal(allVisibleStrings(h.document.body).some((s) => s.includes(LEAK_KEY)), false);

    h.byId(SELECTORS.keyClear).click();
    assert.equal(API_KEY_STORAGE_KEY in h.storage.dump(), false);
    assert.equal(h.byId(SELECTORS.keyState).textContent, 'server key');
    await h.controller.send('without key again');
    assert.equal(API_KEY_HEADER in h.calls.at(-1).init.headers, false);
  });

  test('readStoredApiKey / writeStoredApiKey reject unusable values and never throw', () => {
    const storage = makeStorage();
    assert.equal(writeStoredApiKey(storage, 'has space'), null);
    assert.equal(readStoredApiKey(storage), null);
    assert.equal(writeStoredApiKey(storage, 'k'.repeat(129)), null);
    assert.equal(writeStoredApiKey(storage, LEAK_KEY), LEAK_KEY);
    assert.equal(readStoredApiKey(storage), LEAK_KEY);
    assert.equal(writeStoredApiKey(storage, ''), null);
    assert.equal(readStoredApiKey(storage), null);
    assert.equal(readStoredApiKey({ getItem() { throw new Error('blocked'); } }), null);
    assert.equal(readStoredApiKey(null), null);
  });
});

describe('helpers', () => {
  test('externalUserIdFor uses the UTC date', () => {
    assert.equal(externalUserIdFor(new Date('2026-09-18T23:59:59Z')), 'ondemand-spatial-entity-2026-09-18');
    assert.equal(externalUserIdFor(Date.parse('2026-01-02T00:00:01Z')), 'ondemand-spatial-entity-2026-01-02');
  });

  test('proxyErrorMessage names the status and the proxy envelope', () => {
    assert.equal(proxyErrorMessage(501, { error: 'not_documented', message: 'webhook payload schema (§3.3)' }), 'proxy 501 · not_documented · webhook payload schema (§3.3)');
    assert.equal(proxyErrorMessage(502, null), 'proxy 502');
    assert.equal(proxyErrorMessage(500, 'Internal'), 'proxy 500 · Internal');
  });

  test('createSseParser handles frames split across chunks, heartbeats, [DONE] and [ERROR]', () => {
    const parser = createSseParser();
    const a = parser.push('event:message\ndata:{"eventType":"fulfill');
    assert.deepEqual(a, []);
    const b = parser.push('ment","answer":"Hi"}\n\nevent:heartbeat\ndata:{"time":"t"}\n\n:\n\n');
    assert.deepEqual(b.map((e) => e.type), ['fulfillment', 'heartbeat']);
    assert.equal(b[0].answer, 'Hi');
    const c = parser.push('event:message\ndata: {"eventType":"fulfillment","answer":" there"}\r\n\r\nevent:message\ndata:[DONE]\n\n');
    assert.deepEqual(c.map((e) => [e.type, e.answer]), [['fulfillment', ' there'], ['done', undefined]]);
    const d = createSseParser().push('event:message\ndata:[ERROR]:{"message":"boom","errorCode":"x"}\n\n');
    assert.deepEqual(d, [{ event: 'message', type: 'error', message: 'boom', errorCode: 'x' }]);
    const e = createSseParser().push('data:{"eventType":"fulfillment","answer":"tail"}');
    assert.deepEqual(e, []);
    assert.equal(createSseParser().flush().length, 0);
    const f = createSseParser();
    f.push('data:{"eventType":"fulfillment","answer":"tail"}');
    assert.equal(f.flush()[0].answer, 'tail');
  });

  test('resolveSelectedEntity merges the context-store record with the layer accessor', () => {
    const window = makeWindow();
    window.__gevContextStore.selectedEntityId = 'a1b2c3';
    window.__gevContextStore.entities.set('a1b2c3', {
      id: 'a1b2c3',
      layerId: 'flights',
      label: 'UAL1234',
      source: 'OpenSky',
      latitude: 1,
      longitude: 2,
      properties: { operator: 'United' },
      entity: { __gevContextId: 'a1b2c3' },
    });
    const dataManager = {
      layers: new Map([
        ['flights', { module: { getTrackedInfo: () => ({ icao24: 'a1b2c3', callsign: 'UAL1234', latitude: 30.1, longitude: -97.2, altitudeM: 9000 }) } }],
      ]),
    };
    const resolved = resolveSelectedEntity({ dataManager, window });
    assert.equal(resolved.kind, 'aircraft');
    assert.equal(resolved.layerId, 'flights');
    assert.equal(resolved.entity.icao24, 'a1b2c3');
    assert.equal(resolved.entity.latitude, 30.1, 'live descriptor wins');
    assert.equal(resolved.entity.operator, 'United');
    assert.equal(resolved.entity.sourceFeed, 'OpenSky');
    assert.equal(resolveSelectedEntity({ dataManager, window: makeWindow() }), null);
    assert.equal(resolveSelectedEntity({ dataManager, window, selection: { layerId: 'earthquakes', id: 'q' } }), null);
  });
});

describe('installEntityChat — selection lanes and the ASK ONDEMAND button', () => {
  test('a subject selection reveals the button, the click opens the chat, clearing hides it, abort tears down', async () => {
    const document = makeDocument();
    const button = document.createElement('button');
    button.id = 'ask-ondemand-btn';
    button.hidden = true;
    document.body.appendChild(button);
    const window = makeWindow();
    const { fetchImpl, calls } = makeFetch();
    const abort = new AbortController();
    const dataManager = {
      getAll: () => [],
      layers: new Map([
        ['flights', { module: { getTrackedInfo: () => AIRCRAFT } }],
        ['ais-live-vessels', { module: { getSelectedInfo: () => VESSEL } }],
      ]),
    };
    const controller = installEntityChat({ dataManager, signal: abort.signal, document, window, fetch: fetchImpl, storage: makeStorage() });

    window.dispatchEvent({ type: 'gev:awareness-subject-selected', detail: { layerId: 'earthquakes', id: 'q1', label: 'M4' } });
    assert.equal(button.hidden, true, 'non-entity layers do not arm the button');
    window.dispatchEvent({ type: 'gev:awareness-subject-selected', detail: { layerId: 'flights', id: 'a1b2c3', label: 'UAL1234' } });
    assert.equal(button.hidden, false);
    assert.equal(button.getAttribute('data-entity-kind'), 'aircraft');
    assert.equal(document.getElementById(ENTITY_CHAT_ID), null, 'nothing opens until the click');

    button.click();
    await new Promise((r) => setTimeout(r, 30));
    const overlay = document.getElementById(ENTITY_CHAT_ID);
    assert.ok(overlay);
    assert.equal(overlay.hidden, false);
    assert.equal(controller.getState().entityKey, 'aircraft:a1b2c3');
    assert.equal(calls.filter((c) => c.url === '/api/ondemand/sessions').length, 1);

    // switching to a vessel while open re-targets the chat
    window.dispatchEvent({ type: 'gev:entity-selected', detail: { id: 'ais-366999999', layerId: 'ais-live-vessels', label: 'TEXAS STAR' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(controller.getState().entityKey, 'vessel:366999999');
    assert.equal(calls.filter((c) => c.url === '/api/ondemand/sessions').length, 2);

    window.dispatchEvent({ type: 'gev:entity-selection-cleared', detail: { layerId: 'ais-live-vessels' } });
    assert.equal(button.hidden, true);
    assert.equal(controller.getState().selection, null);

    abort.abort();
    assert.equal(document.getElementById(ENTITY_CHAT_ID), null, 'overlay removed');
    assert.equal(window.listenerCount('gev:awareness-subject-selected'), 0);
    assert.equal(controller.getState().sessionCount, 0);
  });
});
