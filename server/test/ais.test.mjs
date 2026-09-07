import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AisStreamService } from '../dist/adapters/ais.js';
import { loadConfig } from '../dist/config.js';

class FakeSocket extends EventEmitter {
  sent = [];
  terminated = false;

  send(value) {
    this.sent.push(value);
  }

  terminate() {
    this.terminated = true;
  }
}

test('AISStream subscribes, caches provenance, becomes stale, and schedules reconnect', () => {
  let now = 1_000_000;
  const sockets = [];
  const config = loadConfig({
    NODE_ENV: 'test',
    AISSTREAM_API_KEY: 'persistent-secret-must-not-leak',
    AISSTREAM_SILENCE_TIMEOUT_MS: '1000',
    AISSTREAM_RECYCLE_MS: '5000',
  });
  const service = new AisStreamService(config, {
    now: () => now,
    automaticWatchdog: false,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  service.start();
  sockets[0].emit('open');
  assert.match(sockets[0].sent[0], /persistent-secret-must-not-leak/);
  sockets[0].emit('message', JSON.stringify({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 123456789, latitude: 60, longitude: 10, time_utc: '2026-09-04T10:00:00Z' },
    Message: { PositionReport: { Sog: 12, Cog: 180 } },
  }));
  const live = service.snapshot(10);
  assert.equal(live.status, 'live');
  assert.equal(live.rows.length, 1);
  assert.match(live.provenance, /Best-effort/);
  assert.doesNotMatch(JSON.stringify(live), /persistent-secret-must-not-leak/);

  now += 1_100;
  assert.equal(service.snapshot(10).status, 'stale');
  now += 4_000;
  const reconnecting = service.snapshot(10);
  assert.equal(sockets[0].terminated, true);
  assert.equal(reconnecting.reconnectAttempt, 1);
  assert.ok(reconnecting.nextAttemptAt > now);
  service.stop();
});

test('AISStream track route material is retained in chronological samples', () => {
  let now = Date.parse('2026-09-04T10:00:00Z');
  const socket = new FakeSocket();
  const service = new AisStreamService(loadConfig({
    NODE_ENV: 'test',
    AISSTREAM_API_KEY: 'secret',
  }), {
    now: () => now,
    automaticWatchdog: false,
    createSocket: () => socket,
  });
  service.start();
  socket.emit('open');
  for (const [lat, lon] of [[60, 10], [60.1, 10.1]]) {
    socket.emit('message', JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 123456789, latitude: lat, longitude: lon, time_utc: new Date(now).toISOString() },
      Message: { PositionReport: {} },
    }));
    now += 31_000;
  }
  assert.equal(service.track('123456789').length, 2);
  service.stop();
});
