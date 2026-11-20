import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ISS_TELEMETRY_ITEMS,
  ISS_TELEMETRY_ROUTE,
  createIssTelemetryLimiter,
  createIssTelemetryRelay,
  issTelemetryEnabled,
  issTelemetryProxy,
  issTelemetryTimeMs,
  parseTlcpUpdate,
} from './issTelemetry.js';

/** A `ws`-shaped socket the test drives by hand. */
function fakeSocket() {
  const handlers = {};
  return {
    sent: [],
    terminated: false,
    on(event, handler) {
      handlers[event] = handler;
    },
    send(text) {
      this.sent.push(text);
    },
    terminate() {
      this.terminated = true;
    },
    emit(event, payload) {
      handlers[event]?.(payload);
    },
  };
}

const index = (name) => ISS_TELEMETRY_ITEMS.indexOf(name) + 1;

/** A relay on a hand-moved clock, with every socket it opened. */
function relayAt(startMs) {
  const clock = { ms: startMs };
  const sockets = [];
  const relay = createIssTelemetryRelay({
    createSocket: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => clock.ms,
  });
  return { relay, sockets, clock };
}

const NOV_13 = Date.UTC(2026, 10, 13, 11, 0, 0);
/** The feed's stamp for a moment: day of year × 24 + hours of that day. */
const stampOf = (ms) =>
  (ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 0)) / 3_600_000;

test('only ISS_TELEMETRY_ENABLED=1 switches the relay on', () => {
  assert.equal(issTelemetryEnabled({}), false);
  assert.equal(issTelemetryEnabled({ ISS_TELEMETRY_ENABLED: '' }), false);
  assert.equal(issTelemetryEnabled({ ISS_TELEMETRY_ENABLED: '0' }), false);
  assert.equal(issTelemetryEnabled({ ISS_TELEMETRY_ENABLED: 'true' }), false);
  assert.equal(issTelemetryEnabled({ ISS_TELEMETRY_ENABLED: ' 1 ' }), true);
});

test("the feed's stamp is hours from the day before January 1st", () => {
  // 13 November 2026 is day 317: 317 × 24 + 11 hours.
  assert.equal(issTelemetryTimeMs(317 * 24 + 11, NOV_13), NOV_13);
  assert.equal(
    issTelemetryTimeMs(stampOf(NOV_13 - 5000), NOV_13),
    NOV_13 - 5000,
  );
  // A value last sent on 30 December, read on 2 January, belongs to last year.
  const january = Date.UTC(2027, 0, 2, 0, 0, 0);
  assert.equal(
    issTelemetryTimeMs(364 * 24, january),
    Date.UTC(2026, 11, 30, 0, 0, 0),
  );
  assert.equal(issTelemetryTimeMs(Number.NaN, NOV_13), null);
  assert.equal(issTelemetryTimeMs(-1, NOV_13), null);
});

test('an update line decodes against the previous field values', () => {
  const previous = new Map([[3, ['7000.5', '10.25', '24']]]);
  const of = (item) => previous.get(item);
  assert.deepEqual(parseTlcpUpdate('U,1,3,7000.6|11.5|24', of, 3), {
    item: 3,
    fields: ['7000.6', '11.5', '24'],
  });
  // Empty = unchanged, ^n = n unchanged, # = null, $ = empty string.
  assert.deepEqual(parseTlcpUpdate('U,1,3,7000.7||', of, 3).fields, [
    '7000.7',
    '10.25',
    '24',
  ]);
  assert.deepEqual(parseTlcpUpdate('U,1,3,7000.8|^2', of, 3).fields, [
    '7000.8',
    '10.25',
    '24',
  ]);
  assert.deepEqual(parseTlcpUpdate('U,1,3,#|$|24', of, 3).fields, [
    null,
    '',
    '24',
  ]);
  assert.deepEqual(parseTlcpUpdate('U,1,3,a%7Cb|1|24', of, 3).fields[0], 'a|b');
  // Not updates, or malformed ones.
  for (const line of [
    'PROBE',
    'SUBOK,1,23,3',
    'U,1',
    'U,1,x,1|2|3',
    'U,1,0,1|2|3',
    'U,1,3,1|2',
    'U,1,3,1|2|3|4',
    'U,1,3,^9',
    'U,1,3,%E0%A4%A|1|24',
  ])
    assert.equal(parseTlcpUpdate(line, of, 3), null, line);
});

test('the relay opens on the first request, subscribes, and reports live values', () => {
  const { relay, sockets, clock } = relayAt(NOV_13);
  assert.equal(sockets.length, 0, 'nothing is contacted before a request');
  relay.demand();
  assert.equal(sockets.length, 1);
  assert.equal(relay.snapshot().status, 'connecting');
  const socket = sockets[0];
  socket.emit('open');
  assert.match(socket.sent[0], /^create_session\r\nLS_adapter_set=ISSLIVE&/);
  socket.emit(
    'message',
    'CONOK,S1,50000,5000,*\r\nSERVNAME,x\r\nCLIENTIP,192.0.2.1',
  );
  assert.match(
    socket.sent[1],
    /^control\r\n.*LS_mode=MERGE.*LS_schema=TimeStamp%20Value%20Status\.Class/,
  );
  assert.ok(socket.sent[1].includes('S0000004%20S0000003'));

  const stamp = stampOf(NOV_13 - 2000);
  socket.emit(
    'message',
    `U,1,${index('S0000004')},${stamp}|346.12|24\r\nU,1,${index('TIME_000001')},${stamp}|123|24`,
  );
  let body = relay.snapshot();
  assert.equal(body.configured, true);
  assert.equal(body.status, 'live');
  assert.deepEqual(body.items.S0000004, [346.12, NOV_13 - 2000]);
  assert.equal(body.items.TIME_000001, undefined, 'the clock is not a joint');
  assert.equal(JSON.stringify(body).includes('192.0.2.1'), false);

  // A later update with an unchanged stamp field keeps the old stamp.
  clock.ms += 1000;
  socket.emit('message', `U,1,${index('S0000004')},|346.5|`);
  body = relay.snapshot();
  assert.deepEqual(body.items.S0000004, [346.5, NOV_13 - 2000]);
});

test('no station clock tick for 20 s, or a clock without signal, is no-signal', () => {
  const { relay, sockets, clock } = relayAt(NOV_13);
  relay.demand();
  const socket = sockets[0];
  socket.emit('open');
  socket.emit('message', 'CONOK,S1,50000,5000,*');
  const clockLine = (cls) =>
    `U,1,${index('TIME_000001')},${stampOf(clock.ms)}|1|${cls}`;
  socket.emit('message', clockLine('24'));
  assert.equal(relay.snapshot().status, 'live');
  clock.ms += 19_000;
  socket.emit('message', 'PROBE');
  assert.equal(relay.snapshot().status, 'live');
  clock.ms += 2_000;
  assert.equal(relay.snapshot().status, 'no-signal');
  socket.emit('message', clockLine('1'));
  assert.equal(relay.snapshot().status, 'no-signal');
  socket.emit('message', clockLine('24'));
  assert.equal(relay.snapshot().status, 'live');
});

test('a lost or silent connection is retried on a ladder, and stale events are ignored', () => {
  const { relay, sockets, clock } = relayAt(NOV_13);
  relay.demand();
  const first = sockets[0];
  first.emit('open');
  first.emit('close');
  assert.equal(first.terminated, true);
  assert.equal(relay.snapshot().status, 'reconnecting');
  // Not before 5 s.
  clock.ms += 4_000;
  relay.demand();
  relay.tick();
  assert.equal(sockets.length, 1);
  clock.ms += 1_000;
  relay.demand();
  assert.equal(sockets.length, 2);
  // The dead socket's late events change nothing.
  first.emit('message', `U,1,${index('S0000004')},1|999|24`);
  assert.equal(relay.snapshot().items.S0000004, undefined);

  // A second failure waits 15 s.
  sockets[1].emit('error', new Error('x'));
  clock.ms += 14_000;
  relay.demand();
  assert.equal(sockets.length, 2);
  clock.ms += 1_000;
  relay.demand();
  assert.equal(sockets.length, 3);

  // A socket that goes silent for 30 s is recycled by the tick.
  const third = sockets[2];
  third.emit('open');
  third.emit('message', 'CONOK,S1,50000,5000,*');
  clock.ms += 29_000;
  relay.demand();
  relay.tick();
  assert.equal(third.terminated, false);
  clock.ms += 2_000;
  relay.demand();
  relay.tick();
  assert.equal(third.terminated, true);
});

test("a reconnect cannot mark the previous socket's joint samples live", () => {
  const { relay, sockets, clock } = relayAt(NOV_13);
  relay.demand();
  const first = sockets[0];
  first.emit('open');
  first.emit('message', 'CONOK,S1,50000,5000,*');
  const stamp = stampOf(clock.ms);
  first.emit(
    'message',
    `U,1,${index('S0000004')},${stamp}|17|24\r\n` +
      `U,1,${index('TIME_000001')},${stamp}|1|24`,
  );
  assert.equal(relay.snapshot().status, 'live');
  assert.deepEqual(relay.snapshot().items.S0000004, [17, clock.ms]);

  first.emit('close');
  assert.equal(relay.snapshot().status, 'reconnecting');
  clock.ms += 5_000;
  relay.demand();
  assert.equal(sockets.length, 2);
  assert.equal(relay.snapshot().status, 'connecting');
  assert.deepEqual(relay.snapshot().items, {});

  const second = sockets[1];
  second.emit('open');
  second.emit('message', 'CONOK,S2,50000,5000,*');
  // The clock can return before any new joint snapshot is delivered.
  second.emit(
    'message',
    `U,1,${index('TIME_000001')},${stampOf(clock.ms)}|1|24`,
  );
  assert.equal(relay.snapshot().status, 'live');
  assert.deepEqual(
    relay.snapshot().items,
    {},
    'the new clock must not revive old joint angles',
  );
  second.emit('message', `U,1,${index('S0000004')},${stampOf(clock.ms)}|23|24`);
  assert.deepEqual(relay.snapshot().items.S0000004, [23, clock.ms]);
});
test('a refused or ended session starts over', () => {
  for (const line of ['CONERR,2,x', 'END,31,x', 'LOOP,0', 'REQERR,1,17,x']) {
    const { relay, sockets } = relayAt(NOV_13);
    relay.demand();
    sockets[0].emit('open');
    sockets[0].emit('message', line);
    assert.equal(sockets[0].terminated, true, line);
    assert.equal(relay.snapshot().status, 'reconnecting', line);
  }
});

test('with nobody asking for two minutes the connection closes and the values go', () => {
  const { relay, sockets, clock } = relayAt(NOV_13);
  relay.demand();
  const socket = sockets[0];
  socket.emit('open');
  socket.emit('message', 'CONOK,S1,50000,5000,*');
  socket.emit('message', `U,1,${index('S0000003')},${stampOf(clock.ms)}|14|24`);
  clock.ms += 119_000;
  socket.emit('message', 'PROBE');
  assert.equal(relay.tick(), true);
  assert.equal(socket.terminated, false);
  clock.ms += 2_000;
  assert.equal(relay.tick(), false);
  assert.equal(socket.terminated, true);
  assert.deepEqual(relay.snapshot().items, {});
  // The next request opens a fresh connection.
  relay.demand();
  assert.equal(sockets.length, 2);
});

test('an oversized or malformed frame is dropped without taking the relay down', () => {
  const { relay, sockets } = relayAt(NOV_13);
  relay.demand();
  const socket = sockets[0];
  socket.emit('open');
  socket.emit('message', 'CONOK,S1,50000,5000,*');
  socket.emit('message', { length: 10_000_000 });
  socket.emit('message', `U,1,${index('S0000004')},1|not-a-number|24`);
  socket.emit('message', 'U,1,999,1|2|24');
  assert.deepEqual(relay.snapshot().items, {});
  assert.equal(socket.terminated, false);
});

test('without a socket library the relay says unavailable', () => {
  const relay = createIssTelemetryRelay({ createSocket: () => null });
  relay.demand();
  assert.equal(relay.snapshot().status, 'unavailable');
});

/** Mount the plugin on a fake Connect stack and return a request function. */
function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return (method = 'GET', headers = {}, url = '/', remoteAddress) => {
    const res = {
      headers: {},
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.body = body;
        this.status ??= this.statusCode;
      },
    };
    routes.get(ISS_TELEMETRY_ROUTE)(
      { url, method, headers, socket: { remoteAddress } },
      res,
    );
    return res;
  };
}

test('the route is off by default and never opens the feed', () => {
  let opened = 0;
  const plugin = issTelemetryProxy({
    env: {},
    createSocket: () => {
      opened += 1;
      return fakeSocket();
    },
  });
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  for (const preview of [false, true]) {
    const res = install(plugin, preview)();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { configured: false });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  assert.equal(opened, 0);
});

test('switched on, the route opens the feed once and serves the snapshot', () => {
  const sockets = [];
  const plugin = issTelemetryProxy({
    env: { ISS_TELEMETRY_ENABLED: '1' },
    createSocket: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => NOV_13,
  });
  const request = install(plugin);
  try {
    const first = JSON.parse(request().body);
    assert.equal(first.configured, true);
    assert.equal(first.status, 'connecting');
    assert.equal(first.generatedAt, NOV_13);
    assert.deepEqual(first.items, {});
    request();
    assert.equal(sockets.length, 1, 'one connection for every request');
    assert.equal(request('POST').status, 405);
    const unknown = request('GET', {}, '/anything');
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.body), { error: 'Not Found' });
    assert.equal(request('GET', {}, '/?t=1').status, 200, 'a query is fine');
    assert.equal(
      request('GET', { 'sec-fetch-site': 'cross-site' }).status,
      403,
    );
    // 240 requests a minute from one address (the three served above among
    // them), then 429 with how long to wait; another address is served.
    const answers = Array.from({ length: 250 }, () => request());
    const refused = answers.filter((res) => res.status === 429);
    assert.equal(answers.length - refused.length, 240 - 3);
    assert.equal(refused[0].headers['Retry-After'], '60');
    assert.equal(refused[0].headers['Cache-Control'], 'no-store');
    assert.deepEqual(JSON.parse(refused[0].body), {
      error: 'Too Many Requests',
    });
    assert.equal(request('GET', {}, '/', '192.0.2.7').status, 200);
  } finally {
    plugin.closeBundle();
  }
  assert.equal(sockets[0].terminated, true);
});

test('the route admits 240 requests a minute from an address and 12,000 from everyone', () => {
  const clock = { ms: NOV_13 };
  const admit = createIssTelemetryLimiter({ now: () => clock.ms });
  // Four a second from one address for a minute: every one is admitted.
  let admitted = 0;
  for (let s = 0; s < 60; s++) {
    clock.ms = NOV_13 + s * 1000 + 500;
    for (let i = 0; i < 4; i++) if (admit('198.51.100.1') === 0) admitted += 1;
  }
  assert.equal(admitted, 240);
  // One more waits until the first second's four leave the minute.
  assert.equal(admit('198.51.100.1'), 1);
  assert.equal(admit('198.51.100.2'), 0, 'another address is counted apart');
  clock.ms += 1000;
  for (let i = 0; i < 4; i++) assert.equal(admit('198.51.100.1'), 0);
  assert.equal(admit('198.51.100.1'), 1);

  // 12,000 in one second from 60 addresses: then even a new one waits the
  // minute out.
  const everyone = createIssTelemetryLimiter({ now: () => clock.ms });
  admitted = 0;
  for (let a = 0; a < 60; a++)
    for (let i = 0; i < 200; i++)
      if (everyone(`10.0.0.${a}`) === 0) admitted += 1;
  assert.equal(admitted, 12_000);
  assert.equal(everyone('10.0.1.1'), 60);
  clock.ms += 59_000;
  assert.equal(everyone('10.0.1.1'), 1);
  clock.ms += 1000;
  assert.equal(everyone('10.0.1.1'), 0);
});

test('a minute later an address starts afresh, and at most 2,000 are counted', () => {
  const clock = { ms: NOV_13 };
  const admit = createIssTelemetryLimiter({
    perAddress: 2,
    total: 3,
    now: () => clock.ms,
  });
  assert.equal(admit('a'), 0);
  assert.equal(admit('a'), 0);
  assert.equal(admit('a'), 60);
  assert.equal(admit('b'), 0, 'the refused one was not counted');
  assert.equal(admit('c'), 60, 'the total is reached');
  clock.ms += 60_000;
  assert.equal(admit('a'), 0);
  assert.equal(admit('a'), 0);
  assert.equal(admit('c'), 0);

  // Past 2,000 addresses the longest idle one is forgotten, so the map
  // cannot grow without bound; the total still holds for everyone.
  const many = createIssTelemetryLimiter({
    perAddress: 1,
    now: () => clock.ms,
  });
  for (let i = 0; i <= 2000; i++) assert.equal(many(`k${i}`), 0);
  assert.equal(many('k2000'), 60, 'a counted address');
  assert.equal(many('k0'), 0, 'forgotten, so counted afresh');
  assert.equal(many.addresses(), 2000, 'the cap holds');
});

test('an address idle for a whole minute is forgotten, not kept at a count of nothing', () => {
  // Its answers would be the same either way (its count has slid to empty),
  // so only the number of addresses kept shows it: without the forgetting the
  // map would hold every address of the last 2,000 until the cap pushed them out.
  const clock = { ms: NOV_13 };
  const admit = createIssTelemetryLimiter({ now: () => clock.ms });
  assert.equal(admit('198.51.100.1'), 0);
  assert.equal(admit.addresses(), 1);
  clock.ms += 59_000;
  assert.equal(admit('198.51.100.2'), 0);
  assert.equal(admit.addresses(), 2, 'not yet idle a whole minute');
  clock.ms += 2_000;
  assert.equal(admit('198.51.100.3'), 0);
  assert.equal(admit.addresses(), 2, 'the first, idle 61 s, is gone');
});

test('a clock stepped back starts a fresh minute instead of refusing until it catches up', () => {
  const clock = { ms: NOV_13 };
  const admit = createIssTelemetryLimiter({
    perAddress: 2,
    total: 100,
    now: () => clock.ms,
  });
  assert.equal(admit('a'), 0);
  assert.equal(admit('a'), 0);
  assert.equal(admit('a'), 60, 'the address is at its cap');
  // NTP or a resumed machine moves the clock back half an hour.
  clock.ms -= 30 * 60_000;
  assert.equal(admit('a'), 0, 'a fresh minute');
  assert.equal(admit('a'), 0);
  assert.equal(admit('a'), 60, 'and the cap holds in it');
  clock.ms += 60_000;
  assert.equal(admit('a'), 0, 'a minute on, it starts afresh again');
});

test('the served text is the snapshot as JSON, its items encoded again only after a change', () => {
  const { relay, sockets, clock } = relayAt(NOV_13);
  relay.demand();
  const same = (label) =>
    assert.equal(relay.snapshotText(), JSON.stringify(relay.snapshot()), label);
  same('connecting');
  const socket = sockets[0];
  socket.emit('open');
  socket.emit('message', 'CONOK,S1,50000,5000,*');
  const stamp = stampOf(clock.ms);
  socket.emit(
    'message',
    `U,1,${index('S0000004')},${stamp}|17.25|24\r\n` +
      `U,1,${index('S0000001')},|-3|24\r\n` +
      `U,1,${index('TIME_000001')},${stamp}|1|24`,
  );
  same('live, with an item that has no time');

  // The time and the station clock move on; the items do not.
  const real = JSON.stringify;
  let encoded = 0;
  JSON.stringify = (...args) => {
    encoded += 1;
    return real(...args);
  };
  try {
    relay.snapshotText();
    clock.ms += 1000;
    socket.emit(
      'message',
      `U,1,${index('TIME_000001')},${stampOf(clock.ms)}|1|24`,
    );
    relay.snapshotText();
  } finally {
    JSON.stringify = real;
  }
  assert.equal(encoded, 0, 'unchanged items are not encoded again');
  assert.equal(JSON.parse(relay.snapshotText()).generatedAt, clock.ms);

  // A new value, a lost signal and a lost socket each show at once.
  socket.emit('message', `U,1,${index('S0000004')},|18|`);
  same('a new value');
  assert.deepEqual(JSON.parse(relay.snapshotText()).items.S0000004, [
    18,
    NOV_13,
  ]);
  clock.ms += 21_000;
  same('no signal');
  assert.equal(JSON.parse(relay.snapshotText()).status, 'no-signal');
  socket.emit('close');
  same('reconnecting');
  assert.deepEqual(JSON.parse(relay.snapshotText()).items, {});
  relay.dispose();
});

test('a session that keeps ending soon after its snapshot climbs the retry ladder', () => {
  const { relay, sockets, clock } = relayAt(NOV_13);
  relay.demand();
  /** The current socket opens, sends a snapshot update, then ends. */
  const shortSession = () => {
    const socket = sockets.at(-1);
    socket.emit('open');
    socket.emit('message', 'CONOK,S1,50000,5000,*');
    socket.emit(
      'message',
      `U,1,${index('S0000004')},${stampOf(clock.ms)}|17|24`,
    );
    socket.emit('message', 'END,41,session closed');
  };
  // Each wait is the next step: 5 s, 15 s, 60 s, then 5 minutes.
  for (const wait of [5_000, 15_000, 60_000, 300_000, 300_000]) {
    shortSession();
    const before = sockets.length;
    clock.ms += wait - 1_000;
    relay.demand();
    assert.equal(sockets.length, before, `not before ${wait / 1000} s`);
    clock.ms += 1_000;
    relay.demand();
    assert.equal(sockets.length, before + 1, `again after ${wait / 1000} s`);
  }
  // A session that runs a minute before its updates brings the ladder down.
  const socket = sockets.at(-1);
  socket.emit('open');
  socket.emit('message', 'CONOK,S1,50000,5000,*');
  clock.ms += 60_000;
  relay.demand();
  socket.emit('message', `U,1,${index('S0000004')},${stampOf(clock.ms)}|17|24`);
  socket.emit('message', 'END,41,session closed');
  const before = sockets.length;
  clock.ms += 5_000;
  relay.demand();
  assert.equal(sockets.length, before + 1, 'back to 5 s');
});
