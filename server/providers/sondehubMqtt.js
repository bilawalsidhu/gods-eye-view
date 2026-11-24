// A subscribe-only MQTT 3.1.1 client over WebSocket, enough for SondeHub's
// public read feed: CONNECT, SUBSCRIBE at QoS 0, PUBLISH in, PINGREQ out.
// Nothing is ever published.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const utf8 = (value) => {
  const bytes = encoder.encode(value);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
};

/** MQTT's variable-length "remaining length". */
export function encodeLength(n) {
  const out = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    out.push(digit);
  } while (n > 0);
  return out;
}

const packet = (header, body) =>
  new Uint8Array([header, ...encodeLength(body.length), ...body]);

/** CONNECT with a clean session and no credentials. */
export const connectPacket = (clientId, keepAliveS) =>
  packet(0x10, [
    ...utf8('MQTT'),
    4,
    0x02,
    keepAliveS >> 8,
    keepAliveS & 0xff,
    ...utf8(clientId),
  ]);

/** SUBSCRIBE to topics at QoS 0. */
export const subscribePacket = (id, topics) =>
  packet(0x82, [
    id >> 8,
    id & 0xff,
    ...topics.flatMap((topic) => [...utf8(topic), 0]),
  ]);

export const PINGREQ = new Uint8Array([0xc0, 0]);

/**
 * Split a byte stream into MQTT packets. `push` takes the next chunk and
 * returns the whole packets it completed, as `{type, flags, body}`; partial
 * bytes wait for the next chunk. A packet over `maxBytes` throws.
 */
export function createPacketReader({ maxBytes = 4 * 1024 * 1024 } = {}) {
  let buffer = new Uint8Array(0);
  return {
    push(chunk) {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;
      const packets = [];
      for (;;) {
        // Up to four length bytes follow the header; each but the last has
        // its top bit set.
        let length = 0;
        let index = 1;
        let ended = false;
        while (index < buffer.length && index <= 4) {
          const byte = buffer[index];
          length += (byte & 0x7f) * 128 ** (index - 1);
          index += 1;
          if (!(byte & 0x80)) {
            ended = true;
            break;
          }
        }
        if (!ended) {
          if (index > 4) throw new Error('Malformed MQTT length');
          break;
        }
        if (length > maxBytes) throw new Error('MQTT packet too large');
        if (buffer.length < index + length) break;
        packets.push({
          type: buffer[0] >> 4,
          flags: buffer[0] & 0x0f,
          body: buffer.slice(index, index + length),
        });
        buffer = buffer.slice(index + length);
      }
      return packets;
    },
  };
}

/** A QoS 0 PUBLISH body as its topic and UTF-8 payload. */
export function readPublish({ flags, body }) {
  const topicLength = (body[0] << 8) | body[1];
  const topic = decoder.decode(body.subarray(2, 2 + topicLength));
  // QoS 1 and 2 carry a packet id after the topic; QoS 0 does not.
  const start = 2 + topicLength + (((flags >> 1) & 3) > 0 ? 2 : 0);
  return { topic, payload: decoder.decode(body.subarray(start)) };
}

/**
 * Connect, subscribe and hand each message to `onMessage(topic, payload)`.
 * Calls `onClose(reason)` once when the connection ends for any reason.
 * @returns {{close: () => void}}
 */
export function openMqttSubscription({
  url,
  topics,
  clientId,
  onMessage,
  onOpen = () => {},
  onClose = () => {},
  WebSocketImpl = globalThis.WebSocket,
  keepAliveS = 60,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  const reader = createPacketReader();
  let ping = null;
  let closed = false;
  const socket = new WebSocketImpl(url, ['mqtt']);
  socket.binaryType = 'arraybuffer';
  const finish = (reason) => {
    if (closed) return;
    closed = true;
    clearIntervalImpl(ping);
    ping = null;
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    onClose(reason);
  };
  socket.onopen = () => socket.send(connectPacket(clientId, keepAliveS));
  socket.onmessage = (event) => {
    let packets;
    try {
      packets = reader.push(new Uint8Array(event.data));
    } catch (error) {
      finish(error.message);
      return;
    }
    for (const received of packets) {
      if (received.type === 2) {
        // CONNACK: byte 1 is the return code.
        if (received.body[1] !== 0) {
          finish(`MQTT refused (${received.body[1]})`);
          return;
        }
        socket.send(subscribePacket(1, topics));
        ping = setIntervalImpl(
          () => socket.send(PINGREQ),
          (keepAliveS * 1000) / 2,
        );
        ping?.unref?.();
        onOpen();
      } else if (received.type === 3) {
        const { topic, payload } = readPublish(received);
        onMessage(topic, payload);
      }
    }
  };
  socket.onerror = () => finish('MQTT socket error');
  socket.onclose = () => finish('MQTT socket closed');
  return { close: () => finish('closed') };
}
