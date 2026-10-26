import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import {
  CHAT_SIGNAL_PATH,
  installChatSignaling,
  MAX_CHAT_PARTICIPANTS,
} from './signaling.js';
import { startChatSignalingServer } from './start.js';

const ORIGIN = 'http://localhost:4173';

async function createFixture(options = {}) {
  const server = createServer();
  const sockets = new Set();
  const signaling = installChatSignaling(server, {
    allowedOrigins: [ORIGIN],
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    close: async () => {
      const closed = once(server, 'close');
      signaling.close();
      for (const socket of sockets) socket.terminate();
      server.close();
      if (server.listening) await closed;
    },
    connect: (origin = ORIGIN, path = CHAT_SIGNAL_PATH) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { Origin: origin },
      });
      socket.on('error', () => {});
      sockets.add(socket);
      return socket;
    },
    signaling,
  };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for a chat signaling message'));
    }, 1_000);
    const onMessage = (raw) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (error) {
        reject(error);
      }
    };
    socket.once('message', onMessage);
  });
}

async function join(socket, name) {
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'join', name }));
  return nextMessage(socket);
}

test('chat signaling only admits configured browser origins', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const socket = fixture.connect('https://untrusted.example');
  const [, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, 403);
});

test('chat signaling rejects unknown WebSocket paths', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const socket = fixture.connect(ORIGIN, '/wrong-path');
  const [, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, 404);
});

test('joined peers see names and WebRTC signaling is forwarded only to its target', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const first = fixture.connect();
  const firstWelcome = await join(first, 'FirstUser');
  assert.equal(firstWelcome.type, 'welcome');
  assert.equal(firstWelcome.peers.length, 0);

  const joined = nextMessage(first);
  const second = fixture.connect();
  const secondWelcome = await join(second, 'SecondUser');
  assert.deepEqual(secondWelcome.peers, [
    { id: firstWelcome.peerId, name: 'FirstUser' },
  ]);
  assert.deepEqual(await joined, {
    type: 'peer-joined',
    peer: { id: secondWelcome.peerId, name: 'SecondUser' },
  });

  const received = nextMessage(second);
  first.send(
    JSON.stringify({
      type: 'signal',
      signalType: 'offer',
      to: secondWelcome.peerId,
      payload: { type: 'offer', sdp: 'session-description' },
    }),
  );
  assert.deepEqual(await received, {
    type: 'signal',
    from: firstWelcome.peerId,
    signalType: 'offer',
    payload: { type: 'offer', sdp: 'session-description' },
  });
  assert.equal(fixture.signaling.participantCount, 2);

  const left = nextMessage(second);
  first.close();
  assert.deepEqual(await left, {
    type: 'peer-left',
    peerId: firstWelcome.peerId,
  });
});

test('signaling rejects invalid names, payloads, and full rooms', async (t) => {
  const fixture = await createFixture({ maxParticipants: 2 });
  t.after(() => fixture.close());
  const first = fixture.connect();
  await once(first, 'open');
  const firstClosed = once(first, 'close');
  first.send(JSON.stringify({ type: 'join', name: '<bad>' }));
  const invalidName = await nextMessage(first);
  assert.equal(invalidName.code, 'INVALID_NAME');
  await firstClosed;

  const host = fixture.connect();
  const hostWelcome = await join(host, 'FirstUser');
  const second = fixture.connect();
  await join(second, 'SecondUser');
  const third = fixture.connect();
  await once(third, 'open');
  const thirdClosed = once(third, 'close');
  third.send(JSON.stringify({ type: 'join', name: 'ThirdUser' }));
  assert.equal((await nextMessage(third)).code, 'ROOM_FULL');
  await thirdClosed;

  const secondClosed = once(second, 'close');
  second.send(
    JSON.stringify({
      type: 'signal',
      signalType: 'offer',
      to: hostWelcome.peerId,
      payload: { sdp: 'missing type' },
    }),
  );
  assert.equal((await nextMessage(second)).code, 'INVALID_SIGNAL');
  await secondClosed;
});

test('room capacity is bounded to a small peer mesh', () => {
  assert.equal(MAX_CHAT_PARTICIPANTS, 12);
  assert.throws(
    () => installChatSignaling(createServer(), { allowedOrigins: [] }),
    /allowed chat origin/,
  );
  assert.throws(
    () =>
      installChatSignaling(createServer(), {
        allowedOrigins: ['https://app.example'],
        maxParticipants: MAX_CHAT_PARTICIPANTS + 1,
      }),
    /capacity/,
  );
});

test('standalone signaling requires TLS certificate and key', async () => {
  await assert.rejects(startChatSignalingServer({}), /TLS_CERT_FILE/);
});
