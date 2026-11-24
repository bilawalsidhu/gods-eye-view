import assert from 'node:assert/strict';
import test from 'node:test';
import { SONDEHUB_API, sondehubProxy } from './sondehub.js';
import {
  connectPacket,
  createPacketReader,
  encodeLength,
  openMqttSubscription,
  readPublish,
  subscribePacket,
} from './sondehubMqtt.js';

const frame = (serial, datetime, extra = {}) => ({
  serial,
  datetime,
  lat: 50,
  lon: 8,
  alt: 1000,
  vel_v: 5,
  uploader_position: '1,2',
  ...extra,
});

test('MQTT packets are framed and split as the 3.1.1 spec says', () => {
  assert.deepEqual(encodeLength(0), [0]);
  assert.deepEqual(encodeLength(127), [127]);
  assert.deepEqual(encodeLength(128), [0x80, 1]);
  assert.deepEqual(encodeLength(16_384), [0x80, 0x80, 1]);
  const connect = connectPacket('gev', 60);
  assert.equal(connect[0], 0x10);
  assert.deepEqual([...connect.slice(2, 8)], [0, 4, 77, 81, 84, 84]);
  const subscribe = subscribePacket(1, ['batch']);
  assert.deepEqual(
    [...subscribe],
    [0x82, 10, 0, 1, 0, 5, 98, 97, 116, 99, 104, 0],
  );

  // A PUBLISH for "batch" split across chunks, then a PINGRESP.
  const topic = [0, 5, ...new TextEncoder().encode('batch')];
  const payload = [...new TextEncoder().encode('[1]')];
  const publish = [0x30, topic.length + payload.length, ...topic, ...payload];
  const reader = createPacketReader();
  assert.deepEqual(reader.push(new Uint8Array(publish.slice(0, 4))), []);
  const packets = reader.push(new Uint8Array([...publish.slice(4), 0xd0, 0]));
  assert.equal(packets.length, 2);
  assert.deepEqual(readPublish(packets[0]), { topic: 'batch', payload: '[1]' });
  assert.equal(packets[1].type, 13);
  assert.throws(
    () =>
      createPacketReader().push(
        new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 1]),
      ),
    /Malformed MQTT length/,
  );
});

test('the subscription connects, subscribes, delivers and pings', () => {
  const sockets = [];
  class FakeSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.sent = [];
      sockets.push(this);
    }
    send(bytes) {
      this.sent.push(bytes);
    }
    close() {
      this.closed = true;
    }
  }
  const messages = [];
  let ping = null;
  const closes = [];
  openMqttSubscription({
    url: 'wss://example.test/',
    topics: ['batch'],
    clientId: 'gev-test',
    WebSocketImpl: FakeSocket,
    onMessage: (topic, payload) => messages.push([topic, payload]),
    onClose: (reason) => closes.push(reason),
    setIntervalImpl: (fn) => {
      ping = fn;
      return 1;
    },
    clearIntervalImpl: () => {},
  });
  const [socket] = sockets;
  assert.deepEqual(socket.protocols, ['mqtt']);
  socket.onopen();
  assert.equal(socket.sent[0][0], 0x10);
  socket.onmessage({ data: new Uint8Array([0x20, 2, 0, 0]).buffer });
  assert.equal(socket.sent[1][0], 0x82);
  const body = [0, 5, ...new TextEncoder().encode('batch[]')];
  socket.onmessage({
    data: new Uint8Array([0x30, body.length, ...body]).buffer,
  });
  assert.deepEqual(messages, [['batch', '[]']]);
  ping();
  assert.deepEqual([...socket.sent[2]], [0xc0, 0]);
  socket.onclose();
  socket.onclose();
  assert.deepEqual(closes, ['MQTT socket closed']);
});

function harness({ listing, prediction = [], failListing = false } = {}) {
  let clock = Date.parse('2026-11-24T16:40:00Z');
  const fetches = [];
  const subscriptions = [];
  const timers = [];
  const plugin = sondehubProxy({
    now: () => clock,
    warn: () => {},
    randomId: () => 'test',
    setTimeoutImpl: (fn, ms) => {
      timers.push({ fn, at: clock + ms });
      return timers.length;
    },
    clearTimeoutImpl: () => {},
    fetchImpl: async (url) => {
      fetches.push(url);
      if (url.includes('/predictions')) return Response.json(prediction);
      return failListing
        ? new Response('no', { status: 503 })
        : Response.json(listing);
    },
    subscribe: (options) => {
      const subscription = {
        options,
        closed: false,
        close() {
          this.closed = true;
          options.onClose('closed');
        },
      };
      subscriptions.push(subscription);
      return subscription;
    },
  });
  let handler = null;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/sondehub');
        handler = fn;
      },
    },
  });
  const get = (url) =>
    new Promise((resolve) =>
      handler(
        {
          url,
          method: 'GET',
          headers: { host: 'localhost:4173', 'sec-fetch-site': 'same-origin' },
          socket: { remoteAddress: '127.0.0.1' },
        },
        {
          destroyed: false,
          writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
          },
          setHeader() {},
          end(body) {
            resolve({ status: this.status, body: JSON.parse(body) });
          },
        },
      ),
    );
  return {
    get,
    fetches,
    subscriptions,
    advance(ms) {
      clock += ms;
      for (const timer of timers.splice(0))
        if (timer.at <= clock) timer.fn();
        else timers.push(timer);
    },
  };
}

test('the mirror lists once, then follows the live feed until browsers stop asking', async () => {
  const proxy = harness({
    listing: { A: frame('A', '2026-11-24T16:30:00Z') },
  });
  const first = await proxy.get('/latest');
  assert.equal(first.status, 200);
  assert.deepEqual(proxy.fetches, [`${SONDEHUB_API}/sondes?last=10800`]);
  assert.equal(first.body.rows.length, 1);
  assert.ok(!('uploader_position' in first.body.rows[0]));
  const [live] = proxy.subscriptions;
  assert.deepEqual(live.options.topics, ['batch']);
  assert.equal(live.options.clientId, 'gods-eye-view-test');
  live.options.onOpen();
  live.options.onMessage(
    'batch',
    JSON.stringify([
      frame('A', '2026-11-24T16:39:00Z', { alt: 5000 }),
      frame('B', '2026-11-24T16:39:10Z'),
    ]),
  );
  const second = await proxy.get('/latest');
  assert.equal(second.body.live, true);
  assert.equal(
    second.body.rows.find(({ serial }) => serial === 'A').altM,
    5000,
  );
  assert.equal(second.body.rows.length, 2);
  // No second listing while following.
  assert.equal(proxy.fetches.length, 1);
  // Ten idle minutes: the feed closes and a later visit lists again.
  proxy.advance(11 * 60_000);
  assert.equal(live.closed, true);
  await proxy.get('/latest');
  assert.equal(proxy.fetches.length, 2);
  assert.equal(proxy.subscriptions.length, 2);
});

test('predictions are fetched per serial and cached; bad input is refused', async () => {
  const proxy = harness({
    listing: {},
    prediction: [
      {
        vehicle: 'A',
        data: JSON.stringify([
          { time: 1, lat: 50, lon: 8, alt: 900 },
          { time: 2, lat: 50.1, lon: 8.1, alt: 0 },
        ]),
      },
    ],
  });
  const first = await proxy.get('/prediction?serial=A');
  assert.equal(first.status, 200);
  assert.equal(first.body.prediction.path.length, 2);
  await proxy.get('/prediction?serial=A');
  assert.equal(proxy.fetches.length, 1);
  assert.equal(proxy.fetches[0], `${SONDEHUB_API}/predictions?vehicles=A`);
  assert.equal((await proxy.get('/prediction?serial=a%20b')).status, 400);
  assert.equal((await proxy.get('/other')).status, 404);
});

test('with SondeHub unreachable and nothing known, the mirror says so', async () => {
  const proxy = harness({ failListing: true });
  const answer = await proxy.get('/latest');
  assert.equal(answer.status, 502);
  assert.deepEqual(answer.body, { error: 'sondehub_unavailable' });
});
