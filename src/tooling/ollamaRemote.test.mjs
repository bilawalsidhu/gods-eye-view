import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  createRemoteHub,
  sharedRemoteHub,
  installRemoteHub,
  NO_SESSION_ERROR,
  NO_REMOTE_AUDIO_ERROR,
  MAX_REMOTE_UTTERANCE_BYTES,
  REMOTE_WS_PATH,
} from '../../server/providers/ollama/remote.js';
import { ollamaProxy } from '../../server/providers/ollama.js';

function fakeRemote({ open = true } = {}) {
  const handlers = {};
  const remote = {
    OPEN: 1,
    readyState: open ? 1 : 3,
    frames: [],
    on(name, fn) {
      handlers[name] = fn;
    },
    emit(name, ...args) {
      handlers[name]?.(...args);
    },
    send(text) {
      remote.frames.push(JSON.parse(text));
    },
  };
  return remote;
}

const json = (frame) => Buffer.from(JSON.stringify(frame));

test('publish fans text frames out to every open remote and never audio', () => {
  const hub = createRemoteHub();
  assert.equal(hub.publish('s1', { type: 'text', text: 'hi' }), 0);
  const a = fakeRemote();
  const b = fakeRemote();
  const closed = fakeRemote({ open: false });
  hub.attachRemote(a);
  hub.attachRemote(b);
  hub.attachRemote(closed);
  assert.deepEqual(a.frames, [{ type: 'sessions', active: [] }]);
  assert.equal(hub.remoteCount, 3);
  assert.equal(hub.publish('s1', { type: 'text', text: 'hi' }), 2);
  assert.equal(
    hub.publish('s1', { type: 'audio_chunk', seq: 0, pcm16: 'AAAA' }),
    0,
  );
  assert.equal(hub.publish('s1', null), 0);
  assert.equal(hub.publish('s1', { text: 'no type' }), 0);
  for (const remote of [a, b])
    assert.deepEqual(remote.frames.at(-1), {
      type: 'session',
      sessionId: 's1',
      frame: { type: 'text', text: 'hi' },
    });
  assert.deepEqual(closed.frames, []);
  a.emit('close');
  assert.equal(hub.remoteCount, 2);
  assert.equal(hub.publish('s1', { type: 'thinking' }), 1);
});

test('session registry announces the roster and targets the newest session', () => {
  const hub = createRemoteHub();
  const remote = fakeRemote();
  hub.attachRemote(remote);
  hub.registerSession('old', { sendText: () => {} });
  hub.registerSession('new', { sendText: () => {} });
  assert.deepEqual(remote.frames.slice(1), [
    { type: 'sessions', active: ['old'] },
    { type: 'sessions', active: ['old', 'new'] },
  ]);
  assert.equal(hub.activeSessionId, 'new');
  assert.equal(hub.unregisterSession('new'), true);
  assert.equal(hub.unregisterSession('new'), false);
  assert.equal(hub.activeSessionId, 'old');
  assert.deepEqual(remote.frames.at(-1), { type: 'sessions', active: ['old'] });
  hub.registerSession('old', {});
  assert.deepEqual(hub.sessionIds, ['old'], 're-registering does not duplicate');
  hub.unregisterSession('old');
  assert.equal(hub.activeSessionId, null);
});

test('text and interrupt commands reach the active session and echo to all remotes', () => {
  const hub = createRemoteHub();
  const phone = fakeRemote();
  const tablet = fakeRemote();
  hub.attachRemote(phone);
  hub.attachRemote(tablet);
  const calls = [];
  hub.registerSession('s1', {
    sendText: (text) => calls.push(['text', text]),
    interrupt: () => calls.push(['interrupt']),
  });
  hub.handleMessage(phone, json({ type: 'text', text: '  Show flights  ' }));
  hub.handleMessage(phone, json({ type: 'text', text: '   ' }));
  hub.handleMessage(phone, json({ type: 'interrupt' }));
  hub.handleMessage(phone, json({ type: 'map_event' }));
  assert.deepEqual(calls, [['text', 'Show flights'], ['interrupt']]);
  const echo = {
    type: 'session',
    sessionId: 's1',
    frame: { type: 'transcript', text: 'Show flights', source: 'remote' },
  };
  assert.deepEqual(phone.frames.slice(-3), [
    echo,
    { type: 'ack', command: 'text', sessionId: 's1' },
    { type: 'ack', command: 'interrupt', sessionId: 's1' },
  ]);
  assert.deepEqual(tablet.frames.at(-1), echo);
  hub.handleMessage(phone, Buffer.from('{not json'));
  assert.deepEqual(phone.frames.at(-1), {
    type: 'error',
    error: 'Invalid JSON',
  });
  assert.equal(hub.handleMessage(fakeRemote(), json({ type: 'text' })), undefined);
});

test('commands without an active session answer an error instead of dropping silently', () => {
  const hub = createRemoteHub();
  const phone = fakeRemote();
  hub.attachRemote(phone);
  hub.handleMessage(phone, json({ type: 'text', text: 'zoom out' }));
  hub.handleMessage(phone, json({ type: 'interrupt' }));
  hub.handleMessage(phone, Buffer.from('RIFF....WAVE'), true);
  hub.handleMessage(phone, json({ type: 'audio_end' }));
  assert.deepEqual(phone.frames.slice(1), [
    { type: 'error', error: NO_SESSION_ERROR },
    { type: 'error', error: NO_SESSION_ERROR },
    { type: 'error', error: NO_SESSION_ERROR },
  ]);
  assert.match(NO_SESSION_ERROR, /tap MIC there first/);
});

test('binary frames accumulate one utterance that audio_end hands to the session', () => {
  const hub = createRemoteHub();
  const phone = fakeRemote();
  hub.attachRemote(phone);
  const utterances = [];
  hub.registerSession('s1', { sendUtterance: (bytes) => utterances.push(bytes) });
  hub.handleMessage(phone, Buffer.from('RIFF'), true);
  hub.handleMessage(phone, new Uint8Array([0x57, 0x41, 0x56, 0x45]), true);
  hub.handleMessage(phone, json({ type: 'audio_end' }));
  hub.handleMessage(phone, json({ type: 'audio_end' }), false);
  assert.equal(utterances.length, 1, 'an empty audio_end is ignored');
  assert.equal(utterances[0].toString('ascii'), 'RIFFWAVE');
  assert.deepEqual(phone.frames.at(-1), {
    type: 'ack',
    command: 'audio_end',
    sessionId: 's1',
    bytes: 8,
  });
  hub.handleMessage(phone, Buffer.alloc(MAX_REMOTE_UTTERANCE_BYTES), true);
  hub.handleMessage(phone, Buffer.alloc(1), true);
  assert.deepEqual(phone.frames.at(-1), {
    type: 'error',
    error: 'Utterance too long',
  });
  hub.handleMessage(phone, json({ type: 'audio_end' }));
  assert.equal(utterances.length, 1, 'an oversized buffer was discarded');
  hub.registerSession('textOnly', { sendText: () => {} });
  hub.handleMessage(phone, Buffer.from('RIFF'), true);
  hub.handleMessage(phone, json({ type: 'audio_end' }));
  assert.deepEqual(phone.frames.at(-1), {
    type: 'error',
    error: NO_REMOTE_AUDIO_ERROR,
  });
});

test('the companion socket shares the HTTP server with the voice socket', async () => {
  const httpServer = createServer();
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const voiceListener = () => {};
  httpServer.__gevVoiceUpgrade = voiceListener;
  httpServer.on('upgrade', voiceListener);
  const hub = createRemoteHub();
  assert.equal(hub.attachRemoteWebSocket({}), null);
  assert.equal(hub.attachRemoteWebSocket(undefined), null);
  const wss = hub.attachRemoteWebSocket({ httpServer });
  const again = hub.attachRemoteWebSocket({ httpServer });
  let client;
  try {
    assert.equal(httpServer.listeners('upgrade').length, 2);
    assert.ok(httpServer.listeners('upgrade').includes(voiceListener));
    hub.registerSession('s1', {});
    const { port } = httpServer.address();
    client = new WebSocket(`ws://127.0.0.1:${port}${REMOTE_WS_PATH}`);
    const [raw] = await once(client, 'message');
    assert.deepEqual(JSON.parse(raw.toString()), {
      type: 'sessions',
      active: ['s1'],
    });
    assert.equal(hub.remoteCount, 1);
    client.send(JSON.stringify({ type: 'interrupt' }));
    const [ack] = await once(client, 'message');
    assert.deepEqual(JSON.parse(ack.toString()), {
      type: 'ack',
      command: 'interrupt',
      sessionId: 's1',
    });
    client.close();
    await once(client, 'close');
    // The server-side close fires a tick after the client's.
    for (let i = 0; i < 50 && hub.remoteCount; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(hub.remoteCount, 0);
  } finally {
    client?.terminate();
    wss.close();
    again.close();
    httpServer.close();
    await once(httpServer, 'close');
  }
});

test('one hub per process; the Ollama plugin installs it without an HTTP server', () => {
  const shared = sharedRemoteHub();
  assert.equal(sharedRemoteHub(), shared);
  assert.equal(installRemoteHub({ middlewares: { use() {} } }), shared);
  for (const hook of ['configureServer', 'configurePreviewServer'])
    ollamaProxy()[hook]({ middlewares: { use() {} }, restart: async () => {} });
});

test('the companion socket refuses upgrades from foreign origins', async () => {
  const httpServer = createServer();
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const hub = createRemoteHub();
  const wss = hub.attachRemoteWebSocket({ httpServer });
  try {
    const { port } = httpServer.address();
    const foreign = new WebSocket(`ws://127.0.0.1:${port}${REMOTE_WS_PATH}`, {
      origin: 'https://evil.example',
    });
    const [error] = await once(foreign, 'error');
    assert.match(String(error?.message), /403/);
    assert.equal(hub.remoteCount, 0);
    const local = new WebSocket(`ws://127.0.0.1:${port}${REMOTE_WS_PATH}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    await once(local, 'open');
    assert.equal(hub.remoteCount, 1);
    local.close();
    await once(local, 'close');
  } finally {
    wss.close();
    httpServer.close();
  }
});
