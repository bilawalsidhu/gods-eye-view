import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import { createRemoteHub } from '../../server/providers/ollama/remote.js';
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  PEERS_ROUTE,
  createPeerFederation,
  createPeerLink,
  parsePeerList,
  peerName,
  publicPeerUrl,
  sanitizePlace,
} from '../../server/providers/ollama/peers.js';
import {
  createPeersHandler,
  install as installPeersRoute,
} from '../../server/providers/ollama/routes/peers.js';
import { FEATURE_ROUTES } from '../../server/providers/ollama/routes/index.js';

/** ws-shaped client socket the link dials; the test opens, feeds and drops it. */
class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.OPEN = 1;
    this.readyState = 0;
    this.sent = [];
    this.handlers = {};
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  on(name, fn) {
    (this.handlers[name] ||= []).push(fn);
  }
  emit(name, ...args) {
    for (const fn of this.handlers[name] || []) fn(...args);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  receive(frame) {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}
class FailingSocket {
  constructor() {
    throw new Error('dial refused');
  }
}

function fakeTimers() {
  const queue = [];
  let nextId = 0;
  return {
    queue,
    setTimeout(fn, ms) {
      queue.push({ id: ++nextId, fn, ms });
      return nextId;
    },
    clearTimeout(id) {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    /** Run the oldest pending timer; returns its delay. */
    fire() {
      const entry = queue.shift();
      entry?.fn();
      return entry?.ms ?? null;
    },
  };
}

/** Hub-side remote (what remote.js adopts). */
function fakeRemote({ open = true } = {}) {
  const handlers = {};
  const remote = {
    OPEN: 1,
    readyState: open ? 1 : 3,
    frames: [],
    on(name, fn) {
      handlers[name] = fn;
    },
    emit(name, ...args) {
      handlers[name]?.(...args);
    },
    send(text) {
      remote.frames.push(JSON.parse(text));
    },
  };
  return remote;
}
const json = (frame) => Buffer.from(JSON.stringify(frame));

function newLink(overrides = {}) {
  FakeSocket.instances.length = 0;
  const timers = fakeTimers();
  const frames = [];
  const link = createPeerLink({
    url: 'ws://peer.local:4327/api/voice/remote',
    me: 'desk',
    WebSocketImpl: FakeSocket,
    timers,
    now: () => 1234,
    onFrame: (frame, from) => frames.push({ frame, from }),
    ...overrides,
  });
  return { link, timers, frames };
}

test('parsePeerList accepts bare host:port, ws URLs and http URLs, dedupes and drops junk', () => {
  assert.deepEqual(
    parsePeerList(
      ' 192.168.1.50:4327, ws://office:4173/api/voice/remote,http://lab:4326,  ws://office:4173/api/voice/remote ,wss://far.example.com/custom, ::nope, ',
    ),
    [
      { url: 'ws://192.168.1.50:4327/api/voice/remote', label: '192.168.1.50:4327' },
      { url: 'ws://office:4173/api/voice/remote', label: 'office:4173' },
      { url: 'ws://lab:4326/api/voice/remote', label: 'lab:4326' },
      { url: 'wss://far.example.com/custom', label: 'far.example.com' },
    ],
  );
  assert.deepEqual(parsePeerList(''), []);
  assert.deepEqual(parsePeerList(undefined), []);
  assert.deepEqual(parsePeerList('ftp://x:1'), []);
});

test('sanitizePlace keeps a flyable place and rejects the rest', () => {
  assert.deepEqual(
    sanitizePlace({
      name: '  home ',
      lat: '47.6',
      lon: -122.3,
      alt: 900,
      heading: null,
      pitch: -30,
      roll: 'nan',
      savedAt: 1,
      extra: true,
    }),
    { name: 'home', lat: 47.6, lon: -122.3, alt: 900, pitch: -30 },
  );
  assert.equal(sanitizePlace(null), null);
  assert.equal(sanitizePlace({ lat: 1, lon: 2 }), null);
  assert.equal(sanitizePlace({ name: 'x', lat: 91, lon: 0 }), null);
  assert.equal(sanitizePlace({ name: 'x', lat: 0, lon: 181 }), null);
  assert.equal(sanitizePlace({ name: 'x', lat: 'abc', lon: 0 }), null);
  assert.equal(sanitizePlace({ name: 'x', lat: 1 }), null);
});

test('peerName prefers GEV_PEER_NAME and falls back to the hostname', () => {
  assert.equal(peerName({ GEV_PEER_NAME: '  Office globe ' }), 'Office globe');
  assert.equal(peerName({ GEV_PEER_NAME: 'x'.repeat(200) }).length, 80);
  const fallback = peerName({});
  assert.equal(typeof fallback, 'string');
  assert.ok(fallback.length > 0);
});

test('a link says hello on open, learns the peer name from the reply and hands other frames on', () => {
  const { link, frames } = newLink();
  assert.equal(link.connected, false);
  link.connect();
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'ws://peer.local:4327/api/voice/remote');
  assert.equal(link.send({ type: 'x' }), false, 'nothing is sent before open');
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'hello', peer: { name: 'desk' } }]);
  assert.equal(link.connected, true);
  assert.equal(link.lastSeen, 1234);
  assert.deepEqual(link.status(), {
    name: 'peer.local:4327',
    url: 'ws://peer.local:4327/api/voice/remote',
    connected: true,
    lastSeen: 1234,
  });
  socket.receive({ type: 'hello', peer: { name: 'office' } });
  assert.equal(link.name, 'office');
  assert.equal(link.status().name, 'office');
  socket.receive({ type: 'sessions', active: [] });
  socket.emit('message', Buffer.from('not json'), false);
  socket.emit('message', Buffer.alloc(4), true);
  socket.receive({ noType: true });
  assert.deepEqual(
    frames.map((entry) => entry.frame),
    [{ type: 'sessions', active: [] }],
  );
  assert.equal(frames[0].from, link);
  assert.equal(link.connect(), undefined, 'connect is idempotent while open');
  assert.equal(FakeSocket.instances.length, 1);
});

test('a link reconnects with doubling backoff, resets on open and stops on close', () => {
  const { link, timers } = newLink();
  link.connect();
  FakeSocket.instances[0].emit('error', new Error('ECONNREFUSED'));
  FakeSocket.instances[0].emit('close', 1006);
  assert.equal(timers.queue.length, 1, 'error and close schedule one retry');
  assert.equal(timers.queue[0].ms, BACKOFF_MIN_MS);
  const delays = [];
  for (let i = 0; i < 7; i++) {
    delays.push(timers.fire());
    FakeSocket.instances.at(-1).emit('close', 1006);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(link.nextDelay(), BACKOFF_MAX_MS);
  assert.equal(link.attempts, 8);
  timers.fire();
  FakeSocket.instances.at(-1).open();
  assert.equal(link.nextDelay(), BACKOFF_MIN_MS, 'a successful open resets the backoff');
  FakeSocket.instances.at(-1).emit('close', 1000);
  assert.equal(link.connected, false);
  assert.equal(timers.queue.at(-1).ms, BACKOFF_MIN_MS);
  const before = FakeSocket.instances.length;
  link.close();
  assert.equal(timers.queue.length, 0, 'close cancels the pending retry');
  link.connect();
  assert.equal(FakeSocket.instances.length, before, 'a closed link never dials again');
});

test('a link whose constructor throws keeps retrying instead of crashing', () => {
  const timers = fakeTimers();
  const events = [];
  const link = createPeerLink({
    url: 'ws://down:1/api/voice/remote',
    me: 'desk',
    WebSocketImpl: FailingSocket,
    timers,
    log: (event, payload) => events.push({ event, payload }),
  });
  link.connect();
  assert.equal(events[0].event, 'peer.dial_failed');
  assert.equal(timers.queue.length, 1);
  assert.equal(timers.fire(), BACKOFF_MIN_MS);
  assert.equal(timers.queue[0].ms, 2 * BACKOFF_MIN_MS);
  link.close();
});

function federationWithHub({ session = null } = {}) {
  FakeSocket.instances.length = 0;
  const hub = createRemoteHub();
  const remote = fakeRemote();
  hub.attachRemote(remote);
  if (session) hub.registerSession(session.id, session.handlers);
  const federation = createPeerFederation({
    peers: [
      { url: 'ws://a:4326/api/voice/remote', label: 'a:4326' },
      { url: 'ws://b:4327/api/voice/remote', label: 'b:4327' },
    ],
    name: 'desk',
    hub,
    WebSocketImpl: FakeSocket,
    timers: fakeTimers(),
  });
  return { hub, remote, federation, sessionFrames: () => remote.frames.filter((f) => f.type === 'session') };
}

test('createPeerFederation names the hub and wires one link per peer', () => {
  const { hub, federation } = federationWithHub();
  assert.equal(hub.name, 'desk');
  assert.equal(federation.name, 'desk');
  assert.equal(federation.links.length, 2);
  assert.deepEqual(
    federation.status().map((s) => [s.name, s.connected]),
    [
      ['a:4326', false],
      ['b:4327', false],
    ],
  );
  federation.start();
  assert.equal(FakeSocket.instances.length, 2);
  FakeSocket.instances[0].open();
  assert.deepEqual(federation.status()[0], {
    name: 'a:4326',
    url: 'ws://a:4326/api/voice/remote',
    connected: true,
    lastSeen: federation.links[0].lastSeen,
  });
  federation.close();
  assert.ok(FakeSocket.instances.every((socket) => socket.closed));
});

test('a peer notice is spoken by the active session as "From <peer>" with its origin', () => {
  const spoken = [];
  const { federation, remote } = federationWithHub({
    session: {
      id: 's1',
      handlers: { notify: (text, extra) => spoken.push([text, extra]) },
    },
  });
  const link = federation.links[1];
  link.name = 'office';
  const result = federation.handlePeerFrame(
    {
      type: 'session',
      sessionId: 'remote-session',
      frame: { type: 'notice', turnId: 't', text: '  Fire near home  ' },
    },
    link,
  );
  assert.deepEqual(spoken, [['From office: Fire near home', { origin: 'office' }]]);
  assert.deepEqual(result, {
    type: 'notice',
    origin: 'office',
    text: 'From office: Fire near home',
    spoken: true,
  });
  // speakNotice publishes the spoken frame itself; nothing is published here.
  assert.deepEqual(
    remote.frames.filter((f) => f.type === 'session'),
    [],
  );
});

test('without a voice session a peer notice still reaches the local remotes, tagged origin', () => {
  const { federation, sessionFrames } = federationWithHub();
  const result = federation.handlePeerFrame(
    {
      type: 'session',
      sessionId: 'x',
      peer: 'lab',
      frame: { type: 'notice', text: 'Vessel entered the bay' },
    },
    federation.links[0],
  );
  assert.equal(result.spoken, false);
  assert.deepEqual(sessionFrames(), [
    {
      type: 'session',
      sessionId: null,
      peer: 'desk',
      frame: {
        type: 'notice',
        text: 'From lab: Vessel entered the bay',
        origin: 'lab',
      },
    },
  ]);
});

test('the origin comes from the envelope, then the hello name, then the URL label', () => {
  const { federation } = federationWithHub();
  const link = federation.links[0];
  const notice = (peer) => ({
    type: 'session',
    ...(peer ? { peer } : {}),
    frame: { type: 'notice', text: 'hi' },
  });
  assert.equal(federation.handlePeerFrame(notice('envelope'), link).origin, 'envelope');
  assert.equal(federation.handlePeerFrame(notice(null), link).origin, 'a:4326');
  link.name = 'hello-name';
  assert.equal(federation.handlePeerFrame(notice(null), link).origin, 'hello-name');
  assert.equal(federation.handlePeerFrame(notice(null), null).origin, 'peer');
});

test('frames that already carry an origin, non-session envelopes and other frame types are ignored', () => {
  const spoken = [];
  const { federation, sessionFrames } = federationWithHub({
    session: { id: 's1', handlers: { notify: (text) => spoken.push(text) } },
  });
  const link = federation.links[0];
  const ignored = [
    null,
    { type: 'sessions', active: ['s9'] },
    { type: 'ack', command: 'text' },
    { type: 'session', frame: null },
    { type: 'session', frame: { text: 'no type' } },
    { type: 'session', frame: { type: 'notice', text: 'looped', origin: 'desk' } },
    { type: 'session', frame: { type: 'notice', text: 'third hop', origin: 'lab' } },
    { type: 'session', frame: { type: 'peer_place', place: { name: 'p', lat: 1, lon: 2 }, origin: 'lab' } },
    { type: 'session', frame: { type: 'notice', text: '   ' } },
    { type: 'session', frame: { type: 'transcript', text: 'hello globe' } },
    { type: 'session', frame: { type: 'text', text: 'reply' } },
    { type: 'session', frame: { type: 'tool_call', name: 'fly_to' } },
    { type: 'session', frame: { type: 'peer_place', place: { name: 'bad' } } },
  ];
  for (const envelope of ignored)
    assert.equal(federation.handlePeerFrame(envelope, link), null, JSON.stringify(envelope));
  assert.deepEqual(spoken, []);
  assert.deepEqual(sessionFrames(), []);
});

test('an origin-less peer_place is mirrored to remotes and delivered to the session', () => {
  const delivered = [];
  const { federation, sessionFrames } = federationWithHub({
    session: { id: 's1', handlers: { deliver: (frame) => delivered.push(frame) } },
  });
  const result = federation.handlePeerFrame(
    {
      type: 'session',
      peer: 'office',
      frame: {
        type: 'peer_place',
        place: { name: 'marina', lat: 1.5, lon: 2.5, alt: 300, junk: 1 },
      },
    },
    federation.links[0],
  );
  const expected = {
    type: 'peer_place',
    place: { name: 'marina', lat: 1.5, lon: 2.5, alt: 300 },
    origin: 'office',
  };
  assert.deepEqual(result, { type: 'peer_place', origin: 'office', place: expected.place });
  assert.deepEqual(delivered, [expected]);
  assert.deepEqual(sessionFrames(), [
    { type: 'session', sessionId: 's1', peer: 'desk', frame: expected },
  ]);
});

test('sharePlace fans a sanitized, origin-tagged peer_place out to every connected link only', () => {
  const { federation } = federationWithHub();
  federation.start();
  const [a, b] = FakeSocket.instances;
  a.open();
  a.receive({ type: 'hello', peer: { name: 'office' } });
  const result = federation.sharePlace({
    name: 'home',
    lat: 47.6,
    lon: -122.3,
    alt: 800,
    heading: 10,
    pitch: -40,
    roll: 0,
    savedAt: 99,
  });
  const place = { name: 'home', lat: 47.6, lon: -122.3, alt: 800, heading: 10, pitch: -40, roll: 0 };
  assert.deepEqual(result, { ok: true, place, sent: ['office'], peers: 2 });
  assert.deepEqual(a.sent.at(-1), { type: 'peer_place', place, origin: 'desk' });
  assert.deepEqual(b.sent, [], 'an unconnected link is skipped');
  assert.deepEqual(federation.sharePlace({ name: 'nowhere' }), {
    ok: false,
    error: 'A place needs a name, lat and lon',
  });
  b.open();
  assert.deepEqual(federation.sharePlace(place).sent, ['office', 'b:4327']);
  federation.close();
});

test('the hub answers hello with its own name and remembers the remote as a peer', () => {
  const hub = createRemoteHub({ name: 'desk' });
  const remote = fakeRemote();
  hub.attachRemote(remote);
  hub.handleMessage(remote, json({ type: 'hello', peer: { name: 'office' } }), false);
  assert.deepEqual(remote.frames.at(-1), { type: 'hello', peer: { name: 'desk' } });
  const unnamed = createRemoteHub();
  const other = fakeRemote();
  unnamed.attachRemote(other);
  unnamed.handleMessage(other, json({ type: 'hello' }), false);
  assert.deepEqual(other.frames.at(-1), { type: 'hello', peer: { name: null } });
  // Envelopes name the hub only once it has a name.
  assert.equal(hub.publish('s1', { type: 'text', text: 'hi' }), 1);
  assert.deepEqual(remote.frames.at(-1), {
    type: 'session',
    sessionId: 's1',
    peer: 'desk',
    frame: { type: 'text', text: 'hi' },
  });
  unnamed.publish('s1', { type: 'text', text: 'hi' });
  assert.deepEqual(other.frames.at(-1), {
    type: 'session',
    sessionId: 's1',
    frame: { type: 'text', text: 'hi' },
  });
});

test('the hub accepts peer_place from a remote: mirrors it to remotes, delivers it to the session, acks', () => {
  const hub = createRemoteHub({ name: 'desk' });
  const sender = fakeRemote();
  const viewer = fakeRemote();
  hub.attachRemote(sender);
  hub.attachRemote(viewer);
  const delivered = [];
  hub.registerSession('s1', { deliver: (frame) => delivered.push(frame) });
  assert.deepEqual(hub.activeSession.id, 's1');
  const place = { name: 'home', lat: 1, lon: 2 };
  hub.handleMessage(sender, json({ type: 'peer_place', place, origin: 'office' }), false);
  const frame = { type: 'peer_place', place, origin: 'office' };
  assert.deepEqual(delivered, [frame]);
  assert.deepEqual(viewer.frames.at(-1), {
    type: 'session',
    sessionId: 's1',
    peer: 'desk',
    frame,
  });
  assert.deepEqual(sender.frames.at(-1), {
    type: 'ack',
    command: 'peer_place',
    sessionId: 's1',
  });
  // Without an explicit origin the hello name is used; without a session the frame is still mirrored.
  hub.unregisterSession('s1');
  assert.equal(hub.activeSession, null);
  hub.handleMessage(sender, json({ type: 'hello', peer: { name: 'lab' } }), false);
  hub.handleMessage(sender, json({ type: 'peer_place', place }), false);
  assert.deepEqual(viewer.frames.at(-1).frame, { type: 'peer_place', place, origin: 'lab' });
  assert.deepEqual(sender.frames.at(-1), { type: 'ack', command: 'peer_place', sessionId: null });
  hub.handleMessage(sender, json({ type: 'peer_place', place: { name: 'x' } }), false);
  assert.deepEqual(sender.frames.at(-1), { type: 'error', error: 'Invalid place' });
});

function fakeResponse() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.end = (text) => {
    res.body = text ? JSON.parse(text) : null;
    res.done?.();
  };
  return res;
}
async function call(handler, { method, body }) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body)]);
  req.method = method;
  req.url = '/';
  const res = fakeResponse();
  const finished = new Promise((resolve) => (res.done = resolve));
  await handler(req, res);
  await finished;
  return res;
}

test('the /api/voice/peers handler reports status, shares places and rejects bad input', async () => {
  const federation = {
    name: 'desk',
    status: () => [{ name: 'office', url: 'ws://o', connected: true, lastSeen: 5 }],
    calls: [],
    sharePlace(place) {
      federation.calls.push(place);
      return place?.name ? { ok: true, place, sent: ['office'], peers: 1 } : { ok: false, error: 'bad' };
    },
  };
  const handler = createPeersHandler(federation);
  const got = await call(handler, { method: 'GET' });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['Content-Type'], 'application/json');
  assert.deepEqual(got.body, { name: 'desk', peers: federation.status() });

  const shared = await call(handler, {
    method: 'POST',
    body: JSON.stringify({ op: 'share_place', place: { name: 'home', lat: 1, lon: 2 } }),
  });
  assert.equal(shared.statusCode, 200);
  assert.deepEqual(shared.body.sent, ['office']);
  assert.deepEqual(federation.calls, [{ name: 'home', lat: 1, lon: 2 }]);

  const invalid = await call(handler, { method: 'POST', body: JSON.stringify({ op: 'share_place', place: {} }) });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.body, { ok: false, error: 'bad' });

  const badJson = await call(handler, { method: 'POST', body: '{nope' });
  assert.equal(badJson.statusCode, 400);
  assert.equal(badJson.body.error, 'Invalid JSON body');

  const unknown = await call(handler, { method: 'POST', body: JSON.stringify({ op: 'dance' }) });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.error, 'Unknown op: dance');

  const put = await call(handler, { method: 'PUT', body: '{}' });
  assert.equal(put.statusCode, 405);
  assert.equal(put.headers.Allow, 'GET, POST');
});

test('the peers route is registered as a feature route and installs idle without an HTTP server', async (t) => {
  assert.ok(FEATURE_ROUTES.includes(installPeersRoute));
  const old = { GEV_PEERS: process.env.GEV_PEERS, GEV_PEER_NAME: process.env.GEV_PEER_NAME };
  process.env.GEV_PEERS = '127.0.0.1:1, ws://127.0.0.1:2/api/voice/remote';
  process.env.GEV_PEER_NAME = 'unit';
  t.after(() => {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const routes = new Map();
  const federation = installPeersRoute(
    { use: (route, handler) => routes.set(route, handler) },
    { middlewares: {} },
  );
  assert.equal(typeof routes.get(PEERS_ROUTE), 'function');
  assert.equal(federation.name, 'unit');
  assert.deepEqual(
    federation.status().map((s) => [s.name, s.connected]),
    [
      ['127.0.0.1:1', false],
      ['127.0.0.1:2', false],
    ],
  );
  const got = await call(routes.get(PEERS_ROUTE), { method: 'GET' });
  assert.equal(got.body.name, 'unit');
  assert.equal(got.body.peers.length, 2);
});

async function until(check, label, timeoutMs = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function liveHub(name) {
  const hub = createRemoteHub({ name });
  const server = createServer((_req, res) => res.end('ok'));
  hub.attachRemoteWebSocket({ httpServer: server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/api/voice/remote`;
  return { hub, server, url };
}
async function liveRemote(url) {
  const ws = new WebSocket(url);
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, frames };
}

test('two live hubs federated over real sockets exchange one notice and one place each way without echo', async (t) => {
  const A = await liveHub('A');
  const B = await liveHub('B');
  const fedA = createPeerFederation({ peers: [{ url: B.url, label: 'b' }], name: 'A', hub: A.hub, WebSocketImpl: WebSocket }).start();
  const fedB = createPeerFederation({ peers: [{ url: A.url, label: 'a' }], name: 'B', hub: B.hub, WebSocketImpl: WebSocket }).start();
  const onA = await liveRemote(A.url);
  const onB = await liveRemote(B.url);
  t.after(() => {
    fedA.close();
    fedB.close();
    onA.ws.close();
    onB.ws.close();
    A.server.close();
    B.server.close();
  });
  await until(() => fedA.links[0].connected && fedB.links[0].connected, 'both links');
  await until(() => fedA.links[0].name === 'B' && fedB.links[0].name === 'A', 'hello replies');
  assert.equal(A.hub.remoteCount, 2, "A's hub sees B's link and the local remote");

  // A spoken alert on A reaches B's remotes once, as "From A", tagged origin.
  A.hub.publish('sA', { type: 'notice', turnId: 't1', text: 'Quake M5.1 near home' });
  await until(() => onB.frames.some((f) => f.frame?.type === 'notice'), 'notice on B');
  const noticesOnB = onB.frames.filter((f) => f.frame?.type === 'notice');
  assert.deepEqual(noticesOnB, [
    {
      type: 'session',
      sessionId: null,
      peer: 'B',
      frame: { type: 'notice', text: 'From A: Quake M5.1 near home', origin: 'A' },
    },
  ]);

  // A place shared from A lands on B's remotes as peer_place with origin A.
  const place = { name: 'home', lat: 47.6, lon: -122.3, alt: 900, heading: 0, pitch: -45, roll: 0 };
  assert.deepEqual(fedA.sharePlace(place).sent, ['B']);
  await until(() => onB.frames.some((f) => f.frame?.type === 'peer_place'), 'place on B');
  assert.deepEqual(onB.frames.filter((f) => f.frame?.type === 'peer_place'), [
    { type: 'session', sessionId: null, peer: 'B', frame: { type: 'peer_place', place, origin: 'A' } },
  ]);

  // Give any echo time to arrive, then prove there was none: A's remote saw only
  // A's own notice (no origin) and no peer_place; B's remote saw each frame once.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const noticesOnA = onA.frames.filter((f) => f.frame?.type === 'notice');
  assert.deepEqual(noticesOnA, [
    {
      type: 'session',
      sessionId: 'sA',
      peer: 'A',
      frame: { type: 'notice', turnId: 't1', text: 'Quake M5.1 near home' },
    },
  ]);
  assert.equal(onA.frames.filter((f) => f.frame?.type === 'peer_place').length, 0);
  assert.equal(onB.frames.filter((f) => f.frame?.type === 'notice').length, 1);
  assert.equal(onB.frames.filter((f) => f.frame?.type === 'peer_place').length, 1);
});

test('publicPeerUrl drops userinfo credentials and leaves everything else alone', () => {
  assert.equal(
    publicPeerUrl('wss://desk:hunter2@far.example.com:4173/api/voice/remote'),
    'wss://far.example.com:4173/api/voice/remote',
  );
  assert.equal(
    publicPeerUrl('ws://office:4173/api/voice/remote'),
    'ws://office:4173/api/voice/remote',
  );
  assert.equal(publicPeerUrl('not a url'), 'not a url');
});

test('a peer link dials with credentials but never logs or reports them', () => {
  const dialed = [];
  const logs = [];
  class FakeWebSocket {
    constructor(url) {
      dialed.push(url);
      this.handlers = {};
      this.readyState = 0;
      this.OPEN = 1;
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    send() {}
    close() {}
  }
  const url = 'wss://desk:hunter2@far.example.com/api/voice/remote';
  const link = createPeerLink({
    url,
    me: 'unit',
    WebSocketImpl: FakeWebSocket,
    log: (event, payload) => logs.push([event, payload]),
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  link.start?.();
  link.connect?.();
  assert.equal(link.status().url, 'wss://far.example.com/api/voice/remote');
  assert.equal(link.status().name, 'far.example.com');
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('hunter2'), false, serialized);
  if (dialed.length) assert.equal(dialed[0], url);
  link.close?.();
});
