import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  encodeRemainingLength,
  createMqttReader,
  createMqttSession,
  MQTT_PING_MS,
} from './mqtt.js';
test('remaining-length fields match MQTT 3.1.1 at encoding boundaries', () => {
  for (const [length, hex] of [
    [127, '7f'],
    [128, '8001'],
    [16383, 'ff7f'],
    [16384, '808001'],
  ])
    assert.equal(encodeRemainingLength(length).toString('hex'), hex);
});
const publish = Buffer.from('3009000562617463685b5d', 'hex');
test('packet reader accepts WS splits/coalescing and rejects QoS and malformed controls', () => {
  const packets = [],
    read = createMqttReader((p) => packets.push(p));
  read(publish.subarray(0, 4));
  assert.equal(packets.length, 0);
  read(Buffer.concat([publish.subarray(4), publish]));
  assert.equal(packets.length, 2);
  assert.equal(packets[0].topic, 'batch');
  assert.equal(packets[0].payload.toString(), '[]');
  for (const bytes of [
    Buffer.from('3203000161', 'hex'),
    Buffer.from('308080808000', 'hex'),
    Buffer.from('20020005', 'hex'),
    Buffer.from('d00101', 'hex'),
  ])
    assert.throws(() => createMqttReader(() => {})(bytes), /mqtt_/);
});
test('session sends MQTT 3.1.1 CONNECT, batch SUBSCRIBE, 45 s PING and DISCONNECT; stop clears timer', () => {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.send = (v) => socket.sent.push(v);
  let ping,
    delay,
    cleared = false,
    batches = 0,
    live = 0,
    errors = 0;
  const session = createMqttSession(socket, {
    clientId: 'gev-abc',
    onBatch: () => batches++,
    onLive: () => live++,
    onError: () => errors++,
    setIntervalImpl(fn, ms) {
      ping = fn;
      delay = ms;
      return 1;
    },
    clearIntervalImpl() {
      cleared = true;
    },
  });
  socket.emit('open');
  assert.equal(
    socket.sent[0].toString('hex'),
    '101300044d5154540402003c00076765762d616263',
  );
  socket.emit('message', Buffer.from('20020000', 'hex'));
  assert.equal(socket.sent[1].toString('hex'), '820a00010005626174636800');
  socket.emit('message', Buffer.from('9003000100', 'hex'));
  assert.equal(live, 1);
  assert.equal(delay, MQTT_PING_MS);
  ping();
  assert.equal(socket.sent[2].toString('hex'), 'c000');
  socket.emit('message', publish);
  assert.equal(batches, 1);
  socket.emit('message', Buffer.from('d000', 'hex'));
  assert.equal(errors, 0);
  session.disconnect();
  assert.equal(socket.sent.at(-1).toString('hex'), 'e000');
  assert.equal(cleared, true);
  assert.equal(socket.listenerCount('message'), 0);
});
for (const delivery of ['split', 'coalesced']) {
  test(`QoS 0 batch PUBLISH before SUBACK is accepted with ${delivery} delivery`, () => {
    const socket = new EventEmitter();
    socket.send = () => {};
    const batches = [];
    let live = 0,
      errors = 0,
      timers = 0;
    const session = createMqttSession(socket, {
      clientId: 'gev-test',
      onBatch: (rows) => batches.push(rows),
      onLive: () => live++,
      onError: () => errors++,
      setIntervalImpl: () => ++timers,
      clearIntervalImpl: () => timers--,
    });
    socket.emit('open');
    const connack = Buffer.from('20020000', 'hex');
    const suback = Buffer.from('9003000100', 'hex');
    if (delivery === 'coalesced') {
      socket.emit('message', Buffer.concat([connack, publish, suback]));
    } else {
      socket.emit('message', connack);
      socket.emit('message', publish.subarray(0, 4));
      socket.emit('message', publish.subarray(4));
      assert.deepEqual(batches, [[]]);
      assert.equal(live, 0);
      assert.equal(timers, 0);
      socket.emit('message', suback);
    }
    assert.equal(errors, 0);
    assert.deepEqual(batches, [[]]);
    assert.equal(live, 1);
    assert.equal(timers, 1);
    session.stop();
    assert.equal(timers, 0);
    assert.equal(socket.listenerCount('message'), 0);
  });
}
test('an early batch does not bypass SUBACK validation', () => {
  const socket = new EventEmitter();
  socket.send = () => {};
  let errors = 0,
    live = 0;
  const session = createMqttSession(socket, {
    clientId: 'gev-test',
    onBatch: () => {},
    onLive: () => live++,
    onError: () => errors++,
  });
  socket.emit(
    'message',
    Buffer.concat([
      Buffer.from('20020000', 'hex'),
      publish,
      Buffer.from('9003000180', 'hex'),
    ]),
  );
  assert.equal(errors, 1);
  assert.equal(live, 0);
  assert.equal(socket.listenerCount('message'), 0);
  session.stop();
});
