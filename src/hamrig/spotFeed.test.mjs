import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  correctRestClockSkew,
  createSpotFeed,
  decodeWsMessage,
  reconnectDelayMs,
  spotMatchesFilter,
  DEDUPE_WINDOW_MS,
  REST_POLL_INTERVAL_MS,
} from './spotFeed.js';
import { spotKey } from './normalize.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const REST_FIXTURE = fixture('hamrig-spots.json');
const WS_FIXTURE = fixture('hamrig-ws-messages.json');

/** 2026-09-12 12:45:00Z — five minutes after the fixtures' 1240Z rows. */
const T0 = Date.UTC(2026, 8, 12, 12, 45, 0);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeTimers(start = T0) {
  let current = start;
  let nextId = 1;
  const pending = new Map();
  const timers = {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: current + Math.max(0, ms), ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Advance the clock, firing due timers in order (timers armed meanwhile included). */
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        let next = null;
        for (const [id, entry] of pending) {
          if (entry.at <= target && (next === null || entry.at < next.entry.at)) next = { id, entry };
        }
        if (!next) break;
        pending.delete(next.id);
        current = Math.max(current, next.entry.at);
        next.entry.fn();
        await flush();
      }
      current = target;
      await flush();
    },
    pendingDelays: () => [...pending.values()].map((e) => e.ms),
    get size() { return pending.size; },
  };
  return timers;
}

async function flush() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fakeWebSocketClass() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      instances.push(this);
    }

    send(data) {
      if (this.readyState !== 1) throw new Error('socket not open');
      this.sent.push(JSON.parse(data));
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }

    // --- test controls ---
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }

    message(value) {
      this.onmessage?.({ type: 'message', data: typeof value === 'string' ? value : JSON.stringify(value) });
    }

    serverClose(code = 1006) {
      this.readyState = 3;
      this.closed = true;
      this.onclose?.({ code });
    }

    error(message = 'ECONNREFUSED') {
      this.onerror?.({ message });
    }
  }
  FakeWebSocket.instances = instances;
  return FakeWebSocket;
}

function fakeClient({ spots = REST_FIXTURE.spots, fail = false } = {}) {
  const calls = [];
  const client = {
    calls,
    spots,
    fail,
    async get(p, opts = {}) {
      calls.push({ path: p, opts });
      if (client.fail) throw new Error('upstream down');
      return { status: 200, json: { success: true, spots: client.spots, source: 'live' }, text: '' };
    },
  };
  return client;
}

function fakeGeolocator() {
  const calls = [];
  return {
    calls,
    async locateMany(list, opts) {
      calls.push({ list: [...list], opts });
      const out = new Map();
      for (const call of list) {
        if (call.startsWith('DL') || call.startsWith('DH')) out.set(call, { lat: 51, lon: 10, precision: 'entity', entity: 'Fed. Rep. of Germany', continent: 'EU', adif: null, cq: 14 });
        else if (call === 'W3LPL') out.set(call, { lat: 39.2, lon: -77.2, precision: 'exact', entity: 'United States', continent: 'NA', adif: 291, cq: 5 });
        else if (call.startsWith('W') || call.startsWith('K') || call.startsWith('A')) out.set(call, { lat: 37, lon: -120, precision: 'area', entity: 'United States', continent: 'NA', adif: null, cq: 3 });
        else out.set(call, null);
      }
      return out;
    },
  };
}

const quiet = { warn() {}, info() {} };

function buildFeed(overrides = {}) {
  const timers = fakeTimers();
  const WebSocketImpl = fakeWebSocketClass();
  const client = fakeClient();
  const geolocator = fakeGeolocator();
  const feed = createSpotFeed({
    wsUrl: 'wss://hamrig.test:8777',
    client,
    geolocator,
    WebSocketImpl,
    now: timers.now,
    log: quiet,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    ...overrides,
  });
  return { feed, timers, WebSocketImpl, client, geolocator };
}

const wsSpot = (spotter, spotted, khz, comment, iso) => ({ spotter, frequency: khz, spotted, comment, time: `${iso.slice(11, 13)}${iso.slice(14, 16)}Z`, timestamp: iso });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('reconnectDelayMs doubles from 1 s and caps at 60 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map(reconnectDelayMs), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(reconnectDelayMs(-3), 1000);
  assert.equal(reconnectDelayMs('x'), 1000);
});

test('decodeWsMessage handles MessageEvents, strings, buffers, arrays and garbage', () => {
  const spot = WS_FIXTURE[2];
  assert.deepEqual(decodeWsMessage({ type: 'message', data: JSON.stringify(spot) }), [spot]);
  assert.deepEqual(decodeWsMessage(JSON.stringify(spot)), [spot]);
  assert.deepEqual(decodeWsMessage(Buffer.from(JSON.stringify(spot))), [spot]);
  assert.deepEqual(decodeWsMessage({ data: Buffer.from(JSON.stringify(spot)) }), [spot]);
  assert.deepEqual(decodeWsMessage(spot), [spot], 'bare object passes through');
  assert.deepEqual(decodeWsMessage(WS_FIXTURE[5]), [WS_FIXTURE[5]], 'historical_spot wrapper passes through');
  assert.deepEqual(decodeWsMessage({ data: JSON.stringify([spot, spot]) }).length, 2);
  assert.deepEqual(decodeWsMessage(`${JSON.stringify(spot)}\n${JSON.stringify(WS_FIXTURE[0])}`).length, 2, 'newline-delimited batch');
  assert.deepEqual(decodeWsMessage('not json'), []);
  assert.deepEqual(decodeWsMessage(''), []);
  assert.deepEqual(decodeWsMessage(null), []);
  assert.deepEqual(decodeWsMessage(42), []);
});

test('spotMatchesFilter: band, mode (incl. DIGI family), dx segments, all', () => {
  const spot = { dx: 'S79/DL2SBY', band: '12m', mode: 'FT8' };
  assert.equal(spotMatchesFilter(spot, {}), true);
  assert.equal(spotMatchesFilter(spot, { band: 'all', mode: 'ALL', dx: 'all' }), true);
  assert.equal(spotMatchesFilter(spot, { band: '12M' }), true);
  assert.equal(spotMatchesFilter(spot, { band: '20m' }), false);
  assert.equal(spotMatchesFilter(spot, { mode: 'ft8' }), true);
  assert.equal(spotMatchesFilter(spot, { mode: 'DIGI' }), true);
  assert.equal(spotMatchesFilter(spot, { mode: 'CW' }), false);
  assert.equal(spotMatchesFilter({ ...spot, mode: 'CW' }, { mode: 'DIGI' }), false);
  assert.equal(spotMatchesFilter({ ...spot, mode: null }, { mode: 'CW' }), false);
  assert.equal(spotMatchesFilter(spot, { dx: 'dl2sby' }), true);
  assert.equal(spotMatchesFilter(spot, { dx: 'S79/DL2SBY' }), true);
  assert.equal(spotMatchesFilter(spot, { dx: 'DL2SB' }), false);
  assert.equal(spotMatchesFilter(null, {}), false);
});

// ---------------------------------------------------------------------------
// Feed lifecycle
// ---------------------------------------------------------------------------

test('lazy start: nothing happens until getSpots; then REST seed + socket + get_spots', async () => {
  const { feed, client, WebSocketImpl, timers } = buildFeed();
  assert.equal(client.calls.length, 0);
  assert.equal(WebSocketImpl.instances.length, 0);
  assert.equal(feed.status().started, false);

  const first = await feed.getSpots();
  assert.equal(client.calls.length, 1, 'one REST seed');
  assert.equal(client.calls[0].path, '/api/spots');
  assert.deepEqual(client.calls[0].opts.query, { limit: 300 });
  assert.equal(WebSocketImpl.instances.length, 1);
  assert.equal(WebSocketImpl.instances[0].url, 'wss://hamrig.test:8777');
  assert.equal(first.live, false, 'socket not open yet');
  assert.equal(first.spots.length, REST_FIXTURE.spots.length, 'seed rows are visible immediately');
  assert.ok(first.updatedAt);

  const socket = WebSocketImpl.instances[0];
  socket.open();
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].type, 'get_spots');
  assert.equal(socket.sent[0].minutes_back, 60);
  assert.equal(socket.sent[0].max_spots, 1000);
  assert.ok(socket.sent[0].request_id);

  const second = await feed.getSpots();
  assert.equal(second.live, true);
  assert.equal(client.calls.length, 1, 'no extra seed while live');
  assert.equal(WebSocketImpl.instances.length, 1, 'no extra socket');

  await timers.advance(REST_POLL_INTERVAL_MS * 3);
  assert.equal(client.calls.length, 1, 'no REST polling while the socket is open');
  feed.stop();
});

test('seed + live merge: same spot with HHMMZ vs ISO timestamp stored once; typed messages ignored', async () => {
  const { feed, WebSocketImpl } = buildFeed();
  await feed.getSpots();
  const socket = WebSocketImpl.instances[0];
  socket.open();

  const before = feed.status().spotCount;
  // The REST fixture has UA9XO by IK6MNB at 14.023 MHz, 1240Z; the WS fixture
  // replays the same spot as a historical_spot with an ISO timestamp.
  for (const message of WS_FIXTURE) socket.message(message);
  const status = feed.status();
  assert.equal(status.spotCount, before + 3, 'three new spots (S79/DL2SBY, F5MQU/P, UP4L); UA9XO deduped');
  assert.equal(status.duplicates, 1);

  const { spots } = await feed.getSpots();
  const ua9xo = spots.filter((s) => s.dx === 'UA9XO');
  assert.equal(ua9xo.length, 1);
  assert.equal(ua9xo[0].source, 'ws', 'the live copy (authoritative timestamp) supersedes the REST copy');
  assert.equal(ua9xo[0].comment, 'CQ TEST');
  assert.equal(ua9xo[0].timeIso, '2026-09-12T12:40:12.000Z');
  assert.equal(ua9xo[0].spotterCall, 'IK6MNB');
  assert.equal(ua9xo[0].id, spotKey(ua9xo[0]));

  // Live bare spot (kHz float, skimmer suffix) → Spot with cleaned spotter.
  const f5 = spots.find((s) => s.dx === 'F5MQU/P');
  assert.ok(f5);
  assert.equal(f5.source, 'ws');
  assert.equal(f5.spotter, 'DL8LAS-#');
  assert.equal(f5.spotterCall, 'DL8LAS');
  assert.equal(f5.freqHz, 7024000);
  assert.equal(f5.band, '40m');
  assert.equal(f5.mode, 'CW');

  // Same spot again over the socket → still one copy.
  socket.message(WS_FIXTURE[3]);
  assert.equal(feed.status().spotCount, before + 3);
  assert.equal(feed.status().duplicates, 2);
  assert.equal(feed.status().lastError, 'spot_request_error: minutes_back too large', 'request errors are surfaced');
  feed.stop();
});

test('boundary dedupe both ways: live first, then a REST poll of the same spot', async () => {
  const { feed, WebSocketImpl, client, timers } = buildFeed();
  client.spots = [];
  await feed.getSpots();
  const socket = WebSocketImpl.instances[0];
  socket.open();
  socket.message(wsSpot('IK6MNB', 'UA9XO', 14023.0, '', '2026-09-12T12:44:12.000000+00:00'));
  assert.equal(feed.status().spotCount, 1);

  // Socket drops; the REST poll (at 12:46) brings the same spot with a 'HHMMZ' time and a comment.
  client.spots = [{ dx_callsign: 'UA9XO', spotter: 'IK6MNB', frequency: '14.023', mode: 'CW', band: '20m', time: '1244Z', comment: 'CQ TEST' }];
  socket.serverClose();
  await timers.advance(REST_POLL_INTERVAL_MS);
  assert.equal(client.calls.length, 2, 'polled');
  assert.equal(feed.status().spotCount, 1, 'still one copy');
  assert.equal(feed.status().duplicates, 1);
  const { spots } = await feed.getSpots();
  assert.equal(spots[0].source, 'ws', 'the live copy stays');
  assert.equal(spots[0].comment, 'CQ TEST', 'missing details are filled from the duplicate');
  feed.stop();
});

test('reconnect backoff progression 1,2,4,…,60 s and reset after a successful open', async () => {
  const { feed, WebSocketImpl, timers } = buildFeed();
  await feed.getSpots();
  const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
  for (let i = 0; i < expected.length; i += 1) {
    const socket = WebSocketImpl.instances[WebSocketImpl.instances.length - 1];
    assert.equal(WebSocketImpl.instances.length, i + 1);
    if (i % 2 === 0) socket.serverClose(); else socket.error('ECONNRESET');
    const status = feed.status();
    assert.equal(status.live, false);
    assert.equal(status.reconnectPending, true);
    assert.equal(status.reconnectAttempt, i + 1);
    assert.ok(timers.pendingDelays().includes(expected[i]), `attempt ${i} waits ${expected[i]} ms (pending: ${timers.pendingDelays()})`);
    await timers.advance(expected[i] - 1);
    assert.equal(WebSocketImpl.instances.length, i + 1, 'not yet');
    await timers.advance(1);
    assert.equal(WebSocketImpl.instances.length, i + 2, 'reconnected after the delay');
  }
  const last = WebSocketImpl.instances[WebSocketImpl.instances.length - 1];
  last.open();
  assert.equal(feed.status().reconnectAttempt, 0, 'backoff reset on open');
  assert.equal(feed.status().live, true);
  last.serverClose();
  assert.ok(timers.pendingDelays().includes(1000), 'backoff restarts at 1 s');
  feed.stop();
});

test('an error followed by close on the same socket schedules only one reconnect', async () => {
  const { feed, WebSocketImpl, timers } = buildFeed();
  await feed.getSpots();
  const socket = WebSocketImpl.instances[0];
  socket.error('boom');
  socket.serverClose();
  assert.equal(feed.status().reconnectAttempt, 1);
  assert.equal(timers.pendingDelays().filter((ms) => ms === 1000).length, 1);
  feed.stop();
});

test('REST polling every 60 s while the socket is down; stops once it is open', async () => {
  const { feed, WebSocketImpl, timers, client } = buildFeed();
  await feed.getSpots();
  assert.equal(client.calls.length, 1);
  const socket = WebSocketImpl.instances[0];
  socket.serverClose();
  await timers.advance(REST_POLL_INTERVAL_MS - 1);
  assert.equal(client.calls.length, 1);
  await timers.advance(1);
  assert.equal(client.calls.length, 2, 'polled after 60 s');
  assert.equal(feed.status().polling, true);
  // Reconnect attempts keep failing meanwhile.
  for (const s of WebSocketImpl.instances) if (!s.closed) s.serverClose();
  await timers.advance(REST_POLL_INTERVAL_MS);
  assert.equal(client.calls.length, 3);
  for (const s of WebSocketImpl.instances) if (!s.closed) s.serverClose();
  // Bring the socket back up.
  await timers.advance(60_000);
  const live = WebSocketImpl.instances.find((s) => !s.closed);
  assert.ok(live, 'a reconnect attempt is pending');
  const seeds = client.calls.length;
  live.open();
  assert.equal(feed.status().polling, false, 'polling stopped when the socket opened');
  await timers.advance(REST_POLL_INTERVAL_MS * 5);
  assert.equal(client.calls.length, seeds, 'no polls while live');
  feed.stop();
});

test('REST failures never throw out of getSpots and are reported in status', async () => {
  const { feed, client } = buildFeed();
  client.fail = true;
  const result = await feed.getSpots();
  assert.deepEqual(result.spots, []);
  assert.match(feed.status().lastError, /REST seed failed/);
  feed.stop();
});

test('without a WebSocket implementation the feed is REST-only and polls', async () => {
  const { feed, client, timers } = buildFeed({ WebSocketImpl: null });
  const result = await feed.getSpots();
  assert.equal(result.live, false);
  assert.equal(result.spots.length, REST_FIXTURE.spots.length);
  assert.equal(feed.status().socketAvailable, false);
  await timers.advance(REST_POLL_INTERVAL_MS);
  assert.equal(client.calls.length, 2);
  feed.stop();
});

test('WebSocket constructor throwing → backoff reconnect + polling, no crash', async () => {
  class Broken { constructor() { throw new Error('bad url'); } }
  const { feed, timers, client } = buildFeed({ WebSocketImpl: Broken });
  await feed.getSpots();
  assert.match(feed.status().lastError, /WebSocket constructor failed/);
  assert.equal(feed.status().reconnectPending, true);
  await timers.advance(REST_POLL_INTERVAL_MS);
  assert.equal(client.calls.length, 2);
  feed.stop();
});

test('idle shutdown closes the socket and clears timers; next getSpots restarts', async () => {
  const idleShutdownMs = 10 * 60 * 1000;
  const { feed, WebSocketImpl, timers, client } = buildFeed({ idleShutdownMs });
  await feed.getSpots();
  const socket = WebSocketImpl.instances[0];
  socket.open();
  await timers.advance(idleShutdownMs / 2);
  await feed.getSpots(); // activity resets the idle clock
  await timers.advance(idleShutdownMs / 2 + 1000);
  assert.equal(feed.status().started, true, 'still running: last access was 5 min ago');
  assert.equal(socket.closed, false);
  await timers.advance(idleShutdownMs / 2);
  assert.equal(feed.status().started, false, 'shut down after 10 min without access');
  assert.equal(socket.closed, true);
  assert.equal(feed.status().live, false);
  assert.equal(feed.status().socket, 'idle');
  assert.equal(timers.size, 0, 'every timer cleared');
  assert.equal(WebSocketImpl.instances.length, 1, 'no reconnect after an intentional close');

  const seeds = client.calls.length;
  const again = await feed.getSpots();
  assert.equal(feed.status().started, true);
  assert.equal(client.calls.length, seeds + 1, 're-seeded on restart');
  assert.equal(WebSocketImpl.instances.length, 2, 'new socket on restart');
  assert.ok(again.spots.length > 0);
  feed.stop();
});

test('stop() is idempotent and safe before start', () => {
  const { feed } = buildFeed();
  feed.stop();
  feed.stop();
  assert.equal(feed.status().started, false);
});

// ---------------------------------------------------------------------------
// getSpots: ordering, filters, limits, ages, geolocation
// ---------------------------------------------------------------------------

test('getSpots returns newest first with filters, sinceMs, limit', async () => {
  const { feed, WebSocketImpl, client } = buildFeed();
  client.spots = [];
  await feed.getSpots();
  const socket = WebSocketImpl.instances[0];
  socket.open();
  socket.message(wsSpot('DL8LAS-#', 'F5MQU/P', 7024.0, 'CW 15 dB 20 WPM CQ', '2026-09-12T12:20:00+00:00'));
  socket.message(wsSpot('W3LPL-2', 'UP4L', 14255.0, '', '2026-09-12T12:40:00+00:00'));
  socket.message(wsSpot('CT7AUT', 'S79/DL2SBY', 24915.0, 'FT8 +9 dB', '2026-09-12T12:44:00+00:00'));
  socket.message(wsSpot('KC1VGE', 'AC1RH', 7213.0, 'POTA US-4939 NH', '2026-09-12T12:30:00+00:00'));

  const all = await feed.getSpots();
  assert.deepEqual(all.spots.map((s) => s.dx), ['S79/DL2SBY', 'UP4L', 'AC1RH', 'F5MQU/P']);

  assert.deepEqual((await feed.getSpots({ band: '40m' })).spots.map((s) => s.dx), ['AC1RH', 'F5MQU/P']);
  assert.deepEqual((await feed.getSpots({ mode: 'CW' })).spots.map((s) => s.dx), ['F5MQU/P']);
  assert.deepEqual((await feed.getSpots({ mode: 'DIGI' })).spots.map((s) => s.dx), ['S79/DL2SBY']);
  assert.deepEqual((await feed.getSpots({ mode: 'ssb' })).spots.map((s) => s.dx), ['UP4L', 'AC1RH']);
  assert.deepEqual((await feed.getSpots({ dx: 'dl2sby' })).spots.map((s) => s.dx), ['S79/DL2SBY']);
  assert.deepEqual((await feed.getSpots({ limit: 2 })).spots.map((s) => s.dx), ['S79/DL2SBY', 'UP4L']);
  assert.deepEqual((await feed.getSpots({ sinceMs: T0 - 10 * 60 * 1000 })).spots.map((s) => s.dx), ['S79/DL2SBY', 'UP4L'], 'absolute sinceMs');
  assert.deepEqual((await feed.getSpots({ sinceMs: 16 * 60 * 1000 })).spots.map((s) => s.dx), ['S79/DL2SBY', 'UP4L', 'AC1RH'], 'duration sinceMs');
  assert.deepEqual((await feed.getSpots({ band: 'all', mode: 'all', dx: '' })).spots.length, 4);
  feed.stop();
});

test('spots older than maxAgeMs are dropped on arrival and on read; maxSpots keeps the newest', async () => {
  const { feed, WebSocketImpl, client, timers } = buildFeed({ maxAgeMs: 60 * 60 * 1000, maxSpots: 3 });
  client.spots = [];
  await feed.getSpots();
  const socket = WebSocketImpl.instances[0];
  socket.open();
  socket.message(wsSpot('DL1A', 'OLD1', 14001.0, '', '2026-09-12T11:30:00+00:00')); // 75 min old → dropped
  socket.message(wsSpot('DL1A', 'A1', 14002.0, '', '2026-09-12T12:00:00+00:00'));
  socket.message(wsSpot('DL1A', 'A2', 14003.0, '', '2026-09-12T12:10:00+00:00'));
  socket.message(wsSpot('DL1A', 'A3', 14004.0, '', '2026-09-12T12:20:00+00:00'));
  socket.message(wsSpot('DL1A', 'A4', 14005.0, '', '2026-09-12T12:30:00+00:00')); // overflows → A1 evicted
  assert.equal(feed.status().spotCount, 3);
  assert.deepEqual((await feed.getSpots()).spots.map((s) => s.dx), ['A4', 'A3', 'A2']);
  await timers.advance(30 * 60 * 1000); // now 13:15 → A2 (12:10) is 65 min old, A3 (12:20) 55 min
  assert.deepEqual((await feed.getSpots()).spots.map((s) => s.dx), ['A4', 'A3']);
  feed.stop();
});

test('getSpots attaches dxLoc/spotterLoc from geolocator.locateMany(precise:false) with precision propagated', async () => {
  const { feed, WebSocketImpl, client, geolocator } = buildFeed();
  client.spots = [];
  await feed.getSpots();
  const socket = WebSocketImpl.instances[0];
  socket.open();
  socket.message(wsSpot('W3LPL-2', 'DL1ABC', 14255.0, '', '2026-09-12T12:40:00+00:00'));
  socket.message(wsSpot('KC1VGE', 'ZZ9ZZZ', 7213.0, '', '2026-09-12T12:41:00+00:00'));
  geolocator.calls.length = 0;
  const { spots } = await feed.getSpots();
  assert.equal(geolocator.calls.length, 1, 'one bulk lookup per getSpots');
  assert.deepEqual(geolocator.calls[0].opts, { precise: false });
  assert.deepEqual([...geolocator.calls[0].list].sort(), ['DL1ABC', 'KC1VGE', 'W3LPL', 'ZZ9ZZZ'], 'cleaned spotter calls, deduped');

  const first = spots.find((s) => s.dx === 'DL1ABC');
  assert.equal(first.dxLoc.precision, 'entity');
  assert.equal(first.dxLoc.entity, 'Fed. Rep. of Germany');
  assert.equal(first.spotterLoc.precision, 'exact', 'precise cache hit propagates');
  assert.equal(first.spotterLoc.lat, 39.2);
  const second = spots.find((s) => s.dx === 'ZZ9ZZZ');
  assert.equal(second.dxLoc, null);
  assert.equal(second.spotterLoc.precision, 'area');

  // The store itself is never mutated by the attached locations.
  const again = await feed.getSpots({ dx: 'DL1ABC' });
  assert.equal(again.spots[0].spotterLoc.precision, 'exact');
  feed.stop();
});

test('getSpots tolerates a missing or failing geolocator', async () => {
  const noGeo = buildFeed({ geolocator: null });
  const plain = await noGeo.feed.getSpots();
  assert.ok(plain.spots.length > 0);
  assert.equal(plain.spots[0].dxLoc, null);
  noGeo.feed.stop();

  const failing = buildFeed({ geolocator: { async locateMany() { throw new Error('nope'); } } });
  const result = await failing.feed.getSpots();
  assert.ok(result.spots.length > 0);
  assert.equal(result.spots[0].spotterLoc, null);
  failing.feed.stop();
});

test('messages from a superseded socket are ignored', async () => {
  const { feed, WebSocketImpl, client, timers } = buildFeed();
  client.spots = [];
  await feed.getSpots();
  const stale = WebSocketImpl.instances[0];
  stale.serverClose();
  await timers.advance(1000);
  const fresh = WebSocketImpl.instances[1];
  fresh.open();
  stale.onmessage?.({ data: JSON.stringify(wsSpot('DL1A', 'GHOST', 14001.0, '', '2026-09-12T12:40:00+00:00')) });
  assert.equal(feed.status().spotCount, 0);
  fresh.message(wsSpot('DL1A', 'REAL', 14001.0, '', '2026-09-12T12:40:00+00:00'));
  assert.equal(feed.status().spotCount, 1);
  feed.stop();
});

// ---------------------------------------------------------------------------
// REST clock skew and the seed/live boundary
// ---------------------------------------------------------------------------

test('correctRestClockSkew re-anchors skewed cluster minutes and leaves small lag alone', () => {
  const nowMs = Date.UTC(2026, 8, 12, 15, 53, 0);
  const mk = (dx, iso) => ({ id: '', dx, spotterCall: 'X1X', freqHz: 14000000, timeIso: iso, spotter: 'X1X', comment: '', source: 'rest' });
  const skewed = [mk('A', '2026-09-12T12:40:00.000Z'), mk('B', '2026-09-12T12:41:00.000Z'), mk('C', '2026-09-12T12:30:00.000Z')];
  const { spots, offsetMs } = correctRestClockSkew(skewed, { updatedMs: Date.UTC(2026, 8, 12, 15, 52, 44), nowMs });
  assert.equal(offsetMs, Date.UTC(2026, 8, 12, 15, 52, 44) - Date.UTC(2026, 8, 12, 12, 41, 0));
  assert.deepEqual(spots.map((s) => s.timeIso), ['2026-09-12T15:51:44.000Z', '2026-09-12T15:52:44.000Z', '2026-09-12T15:41:44.000Z']);
  assert.equal(spots[0].id, spotKey(spots[0]), 'ids recomputed');
  assert.notEqual(spots[0], skewed[0], 'input not mutated');

  const lag = [mk('A', '2026-09-12T15:50:00.000Z'), mk('B', '2026-09-12T15:49:00.000Z')];
  const untouched = correctRestClockSkew(lag, { updatedMs: Date.UTC(2026, 8, 12, 15, 52, 44), nowMs });
  assert.equal(untouched.offsetMs, 0);
  assert.equal(untouched.spots[0].timeIso, '2026-09-12T15:50:00.000Z');

  const future = correctRestClockSkew(lag, { updatedMs: nowMs + 60 * 60 * 1000, nowMs });
  assert.equal(future.offsetMs, 0, '`updated` is capped at now');
  assert.deepEqual(correctRestClockSkew([], { nowMs }), { spots: [], offsetMs: 0 });
  assert.deepEqual(correctRestClockSkew(null, { nowMs }), { spots: [], offsetMs: 0 });
});

test('live scenario: REST rows hours behind UTC are re-anchored and dedupe against live spots', async () => {
  // The REST fixture is stamped updated=15:52:44Z but its rows say 1240Z/1241Z.
  const nowMs = Date.UTC(2026, 8, 12, 15, 53, 10);
  const timers = fakeTimers(nowMs);
  const { feed, WebSocketImpl, client } = buildFeed({ now: timers.now, setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout, maxAgeMs: 60 * 60 * 1000 });
  client.get = async (p, opts) => { client.calls.push({ path: p, opts }); return { status: 200, json: REST_FIXTURE, text: '' }; };
  const first = await feed.getSpots();
  assert.equal(first.spots.length, REST_FIXTURE.spots.length, 'no seed row was thrown away as too old');
  assert.equal(feed.status().restClockOffsetMs, Date.UTC(2026, 8, 12, 15, 52, 44) - Date.UTC(2026, 8, 12, 12, 41, 0));
  const newest = first.spots[0];
  assert.equal(newest.timeIso, '2026-09-12T15:52:44.000Z');
  assert.equal(newest.dx, 'SP9SIR');
  assert.ok(first.spots.every((s) => s.timeIso.startsWith('2026-09-12T15:5')));

  // The socket delivers the same UA9XO spot, received 15:51:30 (the REST copy now sits at 15:51:44).
  const socket = WebSocketImpl.instances[0];
  socket.open();
  socket.message(wsSpot('IK6MNB', 'UA9XO', 14023.0, 'CQ TEST', '2026-09-12T15:51:30.000000+00:00'));
  assert.equal(feed.status().spotCount, REST_FIXTURE.spots.length, 'boundary duplicate merged across differing minutes');
  assert.equal(feed.status().duplicates, 1);
  const ua9xo = (await feed.getSpots({ dx: 'UA9XO' })).spots;
  assert.equal(ua9xo.length, 1);
  assert.equal(ua9xo[0].source, 'ws');
  assert.equal(ua9xo[0].timeIso, '2026-09-12T15:51:30.000Z');
  feed.stop();
});

test('loose dedupe window: re-spots more than DEDUPE_WINDOW_MS apart stay separate', async () => {
  const { feed, WebSocketImpl, client } = buildFeed();
  client.spots = [];
  await feed.getSpots();
  const socket = WebSocketImpl.instances[0];
  socket.open();
  socket.message(wsSpot('DL1A', 'K1ABC', 14020.0, '', '2026-09-12T12:20:00+00:00'));
  socket.message(wsSpot('DL1A', 'K1ABC', 14020.0, '', '2026-09-12T12:22:59+00:00')); // within window → dup
  socket.message(wsSpot('DL1A', 'K1ABC', 14020.1, '', '2026-09-12T12:30:00+00:00')); // 10 min later → new
  socket.message(wsSpot('DL1A', 'K1ABC', 14021.0, '', '2026-09-12T12:30:00+00:00')); // other 100 Hz bin → new
  socket.message(wsSpot('DL1B', 'K1ABC', 14020.0, '', '2026-09-12T12:30:00+00:00')); // other spotter → new
  assert.equal(feed.status().spotCount, 4);
  assert.equal(feed.status().duplicates, 1);
  assert.ok(DEDUPE_WINDOW_MS >= 2 * 60 * 1000);
  feed.stop();
});

test('stalled REST upstream: unchanged rows keep their anchor across polls instead of drifting into fresh duplicates', async () => {
  // HamRig's `updated` is its cache-write time: it advances on every poll even
  // when the rows behind it have not moved. Re-anchoring the same 1240Z/1241Z
  // rows to each newer `updated` would push them past DEDUPE_WINDOW_MS after
  // three polls and re-add every one of them as a new spot.
  const start = Date.UTC(2026, 8, 12, 15, 53, 10);
  const timers = fakeTimers(start);
  const { feed, WebSocketImpl, client } = buildFeed({ now: timers.now, setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout });
  let rows = REST_FIXTURE.spots;
  client.get = async (p, opts) => {
    client.calls.push({ path: p, opts });
    return { status: 200, json: { ...REST_FIXTURE, spots: rows, updated: new Date(timers.now()).toISOString() }, text: '' };
  };
  const n = REST_FIXTURE.spots.length;
  const first = await feed.getSpots();
  assert.equal(first.spots.length, n);
  const offset = feed.status().restClockOffsetMs;
  assert.equal(offset, start - Date.UTC(2026, 8, 12, 12, 41, 0), 'first seed anchors the newest row to `updated`');

  // The socket never comes up, so the feed polls REST every 60 s.
  WebSocketImpl.instances[0].serverClose();
  const polls = 6; // 6 min of polling: well past the 3 min dedupe window
  for (let i = 0; i < polls; i += 1) {
    await timers.advance(REST_POLL_INTERVAL_MS);
    for (const s of WebSocketImpl.instances) if (!s.closed) s.serverClose();
  }
  assert.equal(client.calls.length, 1 + polls);
  const stalled = feed.status();
  assert.equal(stalled.spotCount, n, 'no unchanged row was re-added as a fresh spot');
  assert.equal(stalled.restClockOffsetMs, offset, 'anchor reused while the newest cluster minute did not move');
  assert.equal(stalled.duplicates, n * polls, 'every re-polled row merged into its stored copy');
  const page = await feed.getSpots();
  assert.equal(page.spots.length, n);
  assert.equal(page.spots[0].timeIso, new Date(start).toISOString(), 'stored rows did not drift forward');

  // A newer cluster minute means the rows moved: the anchor is recomputed.
  rows = [{ dx_callsign: 'K1NEW', spotter: 'W1AW', frequency: '14.025', mode: 'CW', band: '20m', time: '1250Z', comment: '' }, ...REST_FIXTURE.spots];
  await timers.advance(REST_POLL_INTERVAL_MS);
  const moved = feed.status();
  assert.equal(moved.restClockOffsetMs, timers.now() - Date.UTC(2026, 8, 12, 12, 50, 0), 're-anchored to the new newest row');
  assert.notEqual(moved.restClockOffsetMs, offset);
  const after = await feed.getSpots();
  assert.equal(after.spots[0].dx, 'K1NEW');
  assert.equal(after.spots[0].timeIso, new Date(timers.now()).toISOString());
  assert.equal(after.spots.length, n + 1, 'old rows (shifted by less than the dedupe window) merged; only the new one added');
  feed.stop();
});
