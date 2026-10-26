import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPeerChat,
  MAX_CHAT_MESSAGE_LENGTH,
  normalizeChatName,
  resolveChatSignalUrl,
} from './peerChat.js';

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  receive(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

class FakeDataChannel {
  readyState = 'connecting';
  sent = [];

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  receive(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

const connections = [];

class FakePeerConnection {
  constructor(configuration) {
    this.configuration = configuration;
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.candidates = [];
    connections.push(this);
  }

  createDataChannel(label) {
    this.label = label;
    this.channel = new FakeDataChannel();
    return this.channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'local-offer' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'local-answer' };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate) {
    this.candidates.push(candidate);
  }

  close() {
    this.connectionState = 'closed';
    this.onconnectionstatechange?.();
  }
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('nicknames are trimmed and restricted to short letters, numbers and safe punctuation', () => {
  assert.equal(normalizeChatName('  Orbit_7  '), 'Orbit_7');
  assert.equal(normalizeChatName('世界01'), '世界01');
  assert.equal(normalizeChatName('x'), '');
  assert.equal(normalizeChatName('<script>'), '');
  assert.equal(normalizeChatName('name with spaces'), '');
  assert.equal(normalizeChatName('a'.repeat(25)), '');
});

test('signaling URL policy requires the secure signaling endpoint', () => {
  assert.equal(
    resolveChatSignalUrl('wss://localhost:4174/chat/signal'),
    'wss://localhost:4174/chat/signal',
  );
  assert.equal(resolveChatSignalUrl('ws://localhost:4174/chat/signal'), '');
  assert.equal(
    resolveChatSignalUrl('wss://chat.example.com/chat/signal'),
    'wss://chat.example.com/chat/signal',
  );
  assert.equal(resolveChatSignalUrl('wss://chat.example.com/other'), '');
  assert.equal(
    resolveChatSignalUrl('wss://user:secret@chat.example.com/chat', {
      protocol: 'https:',
    }),
    '',
  );
});

test('chat message length is bounded', () => {
  assert.equal(MAX_CHAT_MESSAGE_LENGTH, 500);
});

test('a new participant offers WebRTC to existing room peers and sends chat directly', async () => {
  FakeWebSocket.instances.length = 0;
  connections.length = 0;
  let time = 10_000;
  const chat = createPeerChat({
    WebSocketImpl: FakeWebSocket,
    RTCPeerConnectionImpl: FakePeerConnection,
    randomId: () => 'local-message-id',
    now: () => time,
  });
  const received = [];
  const statuses = [];
  chat.on('message', (message) => received.push(message));
  chat.on('status', (status) => statuses.push(status));
  chat.connect({
    url: 'wss://localhost:4174/chat/signal',
    nickname: 'SavedName',
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'join', name: 'SavedName' }]);

  socket.receive({
    type: 'welcome',
    peerId: 'local-peer',
    peers: [{ id: 'remote-peer', name: 'RemoteName' }],
    iceServers: [{ urls: 'stun:stun.example.test:3478' }],
  });
  await flushPromises();
  assert.equal(statuses.at(-1), 'connected');
  assert.deepEqual(
    socket.sent.filter((message) => message.type === 'signal'),
    [
      {
        type: 'signal',
        to: 'remote-peer',
        signalType: 'offer',
        payload: { type: 'offer', sdp: 'local-offer' },
      },
    ],
  );
  assert.deepEqual(connections[0].configuration.iceServers, [
    { urls: 'stun:stun.example.test:3478' },
  ]);
  connections[0].channel.open();
  assert.equal(chat.send('Hello @RemoteName'), true);
  assert.deepEqual(connections[0].channel.sent[0], {
    type: 'chat',
    id: 'local-message-id',
    timestamp: time,
    text: 'Hello @RemoteName',
  });
  assert.equal(received[0].name, 'SavedName');

  connections[0].channel.receive({
    type: 'chat',
    id: 'remote-message',
    timestamp: time,
    text: '<script>not markup</script>',
  });
  assert.equal(received[1].name, 'RemoteName');
  assert.equal(received[1].text, '<script>not markup</script>');
  assert.throws(() => chat.send('x'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1)), {
    name: 'RangeError',
  });
  for (let index = 0; index < 4; index++)
    assert.equal(chat.send(`Message ${index}`), true);
  assert.throws(() => chat.send('Rate limited'), /Rate limit/);
  time += 5_000;
  assert.equal(chat.send('Window reset'), true);
  chat.dispose();
  assert.equal(statuses.at(-1), 'disconnected');
});

test('a joining room participant answers offers from existing peers', async () => {
  FakeWebSocket.instances.length = 0;
  connections.length = 0;
  const chat = createPeerChat({
    WebSocketImpl: FakeWebSocket,
    RTCPeerConnectionImpl: FakePeerConnection,
  });
  chat.connect({
    url: 'wss://localhost:4174/chat/signal',
    nickname: 'NewPeer',
  });
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({
    type: 'welcome',
    peerId: 'new-peer',
    peers: [],
    iceServers: [],
  });
  socket.receive({
    type: 'peer-joined',
    peer: { id: 'old-peer', name: 'OldPeer' },
  });
  socket.receive({
    type: 'signal',
    from: 'old-peer',
    signalType: 'offer',
    payload: { type: 'offer', sdp: 'remote-offer' },
  });
  await flushPromises();
  assert.equal(connections[0].remoteDescription.sdp, 'remote-offer');
  assert.deepEqual(
    socket.sent.filter((message) => message.signalType === 'answer'),
    [
      {
        type: 'signal',
        to: 'old-peer',
        signalType: 'answer',
        payload: { type: 'answer', sdp: 'local-answer' },
      },
    ],
  );
  chat.dispose();
});

test('connect rejects non-local insecure signaling URLs', () => {
  const chat = createPeerChat({
    WebSocketImpl: FakeWebSocket,
    RTCPeerConnectionImpl: FakePeerConnection,
  });
  assert.throws(
    () =>
      chat.connect({ url: 'ws://chat.example.com', nickname: 'valid_name' }),
    /secure WSS URL/,
  );
  chat.dispose();
});
