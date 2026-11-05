// Read-only MQTT 3.1.1 subset. No broker credentials, QoS acknowledgements or
// MQTT dependency; malformed/unexpected packets fail closed and recycle the WS.
const MQTT_MAX_PACKET_BYTES = 4 * 1024 * 1024;
export const MQTT_PING_MS = 45_000; // Below CONNECT's 60 s keepalive.
/** Encode the MQTT remaining-length field (up to four bytes). */
export function encodeRemainingLength(value) {
  if (!Number.isInteger(value) || value < 0 || value > 268435455)
    throw Error('mqtt_length');
  const bytes = [];
  do {
    const n = value % 128;
    value = Math.floor(value / 128);
    bytes.push(n | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}
const string = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  if (!bytes.length || bytes.length > 65535 || value.includes('\0'))
    throw Error('mqtt_string');
  const size = Buffer.alloc(2);
  size.writeUInt16BE(bytes.length);
  return Buffer.concat([size, bytes]);
};
const packet = (header, body) =>
  Buffer.concat([
    Buffer.from([header]),
    encodeRemainingLength(body.length),
    body,
  ]);
const connectPacket = (id) =>
  packet(
    0x10,
    Buffer.concat([string('MQTT'), Buffer.from([4, 2, 0, 60]), string(id)]),
  );
// This read-only session has one fixed QoS 0 subscription and packet ID.
const SUBSCRIBE_PACKET = packet(
  0x82,
  Buffer.concat([Buffer.from([0, 1]), string('batch'), Buffer.from([0])]),
);
const PING_PACKET = Buffer.from([0xc0, 0]);
const DISCONNECT_PACKET = Buffer.from([0xe0, 0]);

/** WS frames need not align with MQTT packets; bound the accumulated buffer. */
export function createMqttReader(onPacket) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    if (chunk.byteLength > MQTT_MAX_PACKET_BYTES) throw Error('mqtt_too_large');
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    for (;;) {
      if (pending.length < 2) return;
      let remaining = 0,
        multiplier = 1,
        offset = 1,
        complete = false;
      for (; offset <= 4; offset++) {
        if (offset >= pending.length) return;
        const byte = pending[offset];
        remaining += (byte & 127) * multiplier;
        if (!(byte & 128)) {
          offset++;
          complete = true;
          break;
        }
        multiplier *= 128;
      }
      if (!complete || remaining > MQTT_MAX_PACKET_BYTES)
        throw Error('mqtt_length');
      if (pending.length < offset + remaining) return;
      const header = pending[0],
        type = header >> 4;
      const body = pending.subarray(offset, offset + remaining);
      if (type === 3) {
        if ((header & 6) !== 0 || body.length < 3) throw Error('mqtt_qos');
        const length = body.readUInt16BE(0);
        if (!length || length + 2 > body.length) throw Error('mqtt_publish');
        const topic = body.subarray(2, 2 + length).toString('utf8');
        if (topic.includes('\0') || topic.includes('#') || topic.includes('+'))
          throw Error('mqtt_topic');
        onPacket({
          type: 'publish',
          topic,
          payload: body.subarray(2 + length),
        });
      } else if (
        header === 0x20 &&
        body.length === 2 &&
        body[0] === 0 &&
        body[1] === 0
      ) {
        onPacket({ type: 'connack' });
      } else if (
        header === 0x90 &&
        body.length === 3 &&
        body.readUInt16BE(0) === 1 &&
        body[2] === 0
      ) {
        onPacket({ type: 'suback' });
      } else if (header === 0xd0 && !body.length)
        onPacket({ type: 'pingresp' });
      else throw Error('mqtt_packet');
      pending = pending.subarray(offset + remaining);
    }
  };
}

/** Own only protocol state/timers. The feed owns reconnection and demand. */
export function createMqttSession(
  socket,
  {
    clientId,
    onBatch,
    onLive,
    onError,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  },
) {
  let state = 'connecting',
    pingTimer = null,
    stopped = false;
  const fail = () => {
    if (!stopped) {
      stop();
      onError();
    }
  };
  const reader = createMqttReader((message) => {
    if (message.type === 'connack' && state === 'connecting') {
      state = 'subscribing';
      socket.send(SUBSCRIBE_PACKET);
    } else if (message.type === 'suback' && state === 'subscribing') {
      state = 'live';
      onLive();
      pingTimer = setIntervalImpl(() => socket.send(PING_PACKET), MQTT_PING_MS);
      pingTimer?.unref?.();
    } else if (
      message.type === 'publish' &&
      (state === 'subscribing' || state === 'live') &&
      message.topic === 'batch'
    ) {
      // MQTT 3.1.1 permits matching PUBLISH before SUBACK (§3.8.4). Deliver
      // QoS 0 batches immediately; only a valid SUBACK completes the handshake.
      let frames;
      try {
        frames = JSON.parse(message.payload.toString('utf8'));
      } catch {
        return;
      }
      if (Array.isArray(frames)) onBatch(frames);
    } else if (message.type !== 'pingresp') throw Error('mqtt_state');
  });
  const message = (bytes) => {
    try {
      reader(bytes);
    } catch {
      fail();
    }
  };
  const open = () => {
    if (!stopped) socket.send(connectPacket(clientId));
  };
  socket.on('open', open);
  socket.on('message', message);
  function stop() {
    stopped = true;
    if (pingTimer !== null) clearIntervalImpl(pingTimer);
    socket.off('open', open);
    socket.off('message', message);
  }
  return {
    stop,
    disconnect() {
      if (state === 'live' && !stopped) socket.send(DISCONNECT_PACKET);
      stop();
    },
  };
}
