import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ISS_TELEMETRY_ITEMS,
  ISS_TELEMETRY_ROUTE,
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
  return (method = 'GET', headers = {}) => {
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
      { url: '/', method, headers, socket: {} },
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
    request();
    assert.equal(sockets.length, 1, 'one connection for every request');
    assert.equal(request('POST').status, 405);
    assert.equal(
      request('GET', { 'sec-fetch-site': 'cross-site' }).status,
      403,
    );
    // Sixty requests a minute from one client, then 429.
    let limited = 0;
    for (let i = 0; i < 70; i++) if (request().status === 429) limited += 1;
    assert.ok(limited > 0);
  } finally {
    plugin.closeBundle();
  }
  assert.equal(sockets[0].terminated, true);
});
