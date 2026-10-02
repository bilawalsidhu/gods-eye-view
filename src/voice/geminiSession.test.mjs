// GEMINI LIVE VOICE — schema conversion, token minting, and the adapter's wire
// contract against a fake WebSocket. No network, microphone or audio device.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSession } from './session.js';
import {
  createGeminiSession,
  geminiLiveUrl,
  requestGeminiToken,
} from './geminiSession.js';
import {
  geminiFunctionResponse,
  toGeminiFunctionDeclarations,
  toGeminiSchema,
} from './geminiTools.js';
import { base64Pcm16ToFloat32, bytesToBase64, pcmRate } from './geminiAudio.js';
import {
  VOICE_PROVIDER_STORAGE_KEY,
  bindVoiceProviderToggle,
  readVoiceProvider,
} from './voiceProvider.js';
import {
  createGeminiTokenHandler,
  geminiLiveSetup,
} from '../../server/providers/gemini.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { localProviderPlugins } from '../../server/providers/local.js';

test('every voice tool converts to the Gemini schema subset', () => {
  const declarations = toGeminiFunctionDeclarations(GEV_REALTIME_TOOLS);
  assert.equal(declarations.length, GEV_REALTIME_TOOLS.length);
  const text = JSON.stringify(declarations);
  assert.doesNotMatch(text, /additionalProperties/);
  assert.doesNotMatch(text, /"type":"[a-z]/);
  for (const declaration of declarations) {
    assert.ok(declaration.name && declaration.description);
    assert.equal(declaration.parameters?.type ?? 'OBJECT', 'OBJECT');
  }
});

test('schema conversion keeps bounds, drops non-string enums and stale required names', () => {
  assert.deepEqual(
    toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      required: ['zoom', 'gone'],
      properties: {
        zoom: { type: 'number', minimum: 1, maximum: 20, enum: [1, 2] },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
    }),
    {
      type: 'OBJECT',
      required: ['zoom'],
      properties: {
        zoom: { type: 'NUMBER', minimum: 1, maximum: 20 },
        mode: { type: 'STRING', enum: ['a', 'b'] },
      },
    },
  );
  assert.deepEqual(geminiFunctionResponse({ ok: true }), { ok: true });
  assert.deepEqual(geminiFunctionResponse('done'), { result: 'done' });
  assert.deepEqual(geminiFunctionResponse([1]), { result: [1] });
});

test('PCM helpers round-trip little-endian samples and read the MIME rate', () => {
  const pcm = new Int16Array([0, 0x4000, -0x8000]);
  const samples = base64Pcm16ToFloat32(
    bytesToBase64(new Uint8Array(pcm.buffer)),
  );
  assert.deepEqual([...samples], [0, 0.5, -1]);
  assert.equal(pcmRate('audio/pcm;rate=24000'), 24000);
  assert.equal(pcmRate('audio/pcm'), 24000);
});

function tokenResponse() {
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  return res;
}

test('the token route locks the setup server-side and never returns the key', async () => {
  const calls = [];
  const handler = createGeminiTokenHandler({
    resolveApiKey: () => 'secret-key',
    now: () => Date.parse('2026-10-02T10:00:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/v1beta/')) return new Response('', { status: 404 });
      return Response.json({ name: 'auth_tokens/ephemeral' });
    },
  });
  const res = tokenResponse();
  await handler({ method: 'GET', socket: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.token, 'auth_tokens/ephemeral');
  assert.equal(res.body.apiVersion, 'v1alpha');
  assert.doesNotMatch(JSON.stringify(res.body), /secret-key/);
  assert.equal(calls.length, 2);
  const sent = JSON.parse(calls[1].options.body);
  assert.equal(calls[1].options.headers['x-goog-api-key'], 'secret-key');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(sent.uses, 1);
  assert.equal(sent.bidiGenerateContentSetup.model, res.body.setup.model);
  assert.equal(sent.newSessionExpireTime, '2026-10-02T10:01:00.000Z');
});

test('the token route reports a missing key and sanitizes upstream failures', async () => {
  const missing = tokenResponse();
  await createGeminiTokenHandler({ resolveApiKey: () => '' })(
    { method: 'GET', socket: {} },
    missing,
  );
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.error, 'GEMINI_API_KEY is not set');

  const failed = tokenResponse();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await createGeminiTokenHandler({
      resolveApiKey: () => 'k',
      fetchImpl: async () =>
        Response.json(
          { error: { message: 'API key not valid: k' } },
          {
            status: 400,
          },
        ),
    })({ method: 'GET', socket: {} }, failed);
  } finally {
    console.warn = warn;
  }
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.error, 'Failed to create Gemini Live token');
});

test('the default setup names a model, audio output, transcripts and all tools', () => {
  const setup = geminiLiveSetup({ model: 'gemini-test', voice: 'Puck' });
  assert.equal(setup.model, 'models/gemini-test');
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(
    setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
      .voiceName,
    'Puck',
  );
  assert.ok(setup.systemInstruction.parts[0].text.includes('GEV'));
  assert.equal(
    setup.tools[0].functionDeclarations.length,
    GEV_REALTIME_TOOLS.length,
  );
  assert.ok(
    localProviderPlugins().some(
      (plugin) => plugin.name === 'gemini-live-proxy',
    ),
  );
});

test('the token client surfaces server errors and incomplete responses', async () => {
  await assert.rejects(
    requestGeminiToken({
      fetchImpl: async () =>
        Response.json({ error: 'GEMINI_API_KEY is not set' }, { status: 503 }),
    }),
    /GEMINI_API_KEY is not set/,
  );
  await assert.rejects(
    requestGeminiToken({ fetchImpl: async () => Response.json({}) }),
    /incomplete/,
  );
  assert.match(
    geminiLiveUrl({ token: 'a/b', apiVersion: 'v1alpha' }),
    /v1alpha\.GenerativeService\.BidiGenerateContentConstrained\?access_token=a%2Fb$/,
  );
  assert.match(
    geminiLiveUrl({ token: 't', apiVersion: '../evil' }),
    /\.v1beta\./,
  );
});

class FakeSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(text) {
    this.sent.push(JSON.parse(text));
    if (this.sent.length === 1)
      queueMicrotask(() => this.receive({ setupComplete: {} }));
  }
  receive(message) {
    return this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
    this.closed = true;
  }
}

function fakeAudio(log) {
  return ({ onSpeaker }) => ({
    async startCapture(onChunk) {
      log.push('capture');
      onChunk('AAA=');
    },
    play(data, mimeType) {
      log.push(`play ${mimeType}`);
      onSpeaker('ai');
    },
    flush() {
      log.push('flush');
    },
    stop() {
      log.push('stop');
    },
  });
}

async function startSession({ runner = async () => ({ ok: true }) } = {}) {
  const log = [];
  const events = [];
  const ui = { root: { dataset: {} } };
  const session = createVoiceSession({
    runner,
    createAdapter: (hooks) =>
      createGeminiSession({
        ...hooks,
        ui,
        WebSocketImpl: FakeSocket,
        createAudio: fakeAudio(log),
        requestToken: async () => ({
          token: 'tok',
          apiVersion: 'v1beta',
          setup: { model: 'models/x' },
        }),
      }),
  });
  session.subscribe((event) => events.push(event));
  await session.start();
  return { session, socket: FakeSocket.last, log, events, ui };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('start sends the locked setup first, then streams 16 kHz microphone audio', async () => {
  const { session, socket, log, events } = await startSession();
  assert.match(socket.url, /access_token=tok/);
  assert.deepEqual(socket.sent[0], { setup: { model: 'models/x' } });
  assert.deepEqual(socket.sent[1], {
    realtimeInput: {
      audio: { data: 'AAA=', mimeType: 'audio/pcm;rate=16000' },
    },
  });
  assert.deepEqual(log, ['capture']);
  assert.equal(session.state, 'listening');
  assert.ok(events.some((event) => event.state === 'connecting'));
  session.stop();
  assert.ok(socket.closed);
  assert.equal(session.state, 'idle');
});

test('tool calls run through the session and answer with one response per call', async () => {
  const ran = [];
  const { session, socket, events } = await startSession({
    runner: async (name, args) => {
      ran.push([name, args]);
      return name === 'bad' ? 'text result' : { ok: true, name };
    },
  });
  await socket.receive({
    toolCall: {
      functionCalls: [
        { id: '1', name: 'fly_to_location', args: { query: 'Paris' } },
        { id: '2', name: 'bad' },
      ],
    },
  });
  await flush();
  assert.deepEqual(ran, [
    ['fly_to_location', { query: 'Paris' }],
    ['bad', {}],
  ]);
  assert.deepEqual(socket.sent.at(-1), {
    toolResponse: {
      functionResponses: [
        {
          id: '1',
          name: 'fly_to_location',
          response: { ok: true, name: 'fly_to_location' },
        },
        { id: '2', name: 'bad', response: { result: 'text result' } },
      ],
    },
  });
  assert.ok(events.some((event) => event.type === 'action-result'));
  assert.equal(session.state, 'listening');
  session.stop();
});

test('cancelled calls are not answered and a failing action reports its error', async () => {
  let release;
  const { session, socket } = await startSession({
    runner: async (name) => {
      if (name === 'slow') await new Promise((resolve) => (release = resolve));
      if (name === 'boom') throw new Error('No such place');
      return { ok: true };
    },
  });
  void socket.receive({
    toolCall: {
      functionCalls: [
        { id: 'a', name: 'slow' },
        { id: 'b', name: 'boom' },
      ],
    },
  });
  await flush();
  await socket.receive({ toolCallCancellation: { ids: ['a'] } });
  release();
  await flush();
  assert.deepEqual(socket.sent.at(-1).toolResponse.functionResponses, [
    { id: 'b', name: 'boom', response: { ok: false, error: 'No such place' } },
  ]);
  session.stop();
});

test('speech plays, interruption flushes it, and a finished turn emits transcripts', async () => {
  const { session, socket, log, events, ui } = await startSession();
  await socket.receive({
    serverContent: {
      modelTurn: {
        parts: [
          { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } },
        ],
      },
      outputTranscription: { text: 'Flying ' },
      inputTranscription: { text: 'go to Paris' },
    },
  });
  assert.equal(ui.root.dataset.speaker, 'user');
  await socket.receive({
    serverContent: {
      outputTranscription: { text: 'to Paris.' },
      turnComplete: true,
    },
  });
  await socket.receive({ serverContent: { interrupted: true } });
  assert.deepEqual(log.slice(1), ['play audio/pcm;rate=24000', 'flush']);
  const finals = events.filter(
    (event) => event.type === 'transcript' && event.final,
  );
  assert.deepEqual(
    finals.map((event) => [event.role, event.text]),
    [
      ['user', 'go to Paris'],
      ['assistant', 'Flying to Paris.'],
    ],
  );
  assert.ok(events.some((event) => event.type === 'completion'));
  assert.ok(events.some((event) => event.type === 'interruption'));
  assert.equal(session.sendText('hello'), true);
  assert.deepEqual(socket.sent.at(-1).clientContent.turnComplete, true);
  session.stop();
  assert.equal(session.sendText('late'), false);
});

test('an unexpected close after setup puts the session in error', async () => {
  const { session, socket, log } = await startSession();
  socket.onclose({ code: 1007, reason: 'Invalid argument' });
  assert.equal(session.state, 'error');
  assert.ok(log.includes('stop'));
});

test('the provider toggle remembers the choice and defaults to OpenAI', () => {
  const values = new Map();
  const store = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readVoiceProvider(store), 'openai');
  values.set(VOICE_PROVIDER_STORAGE_KEY, 'bogus');
  assert.equal(readVoiceProvider(store), 'openai');
  let click;
  const button = {
    hidden: true,
    dataset: {},
    setAttribute(name, value) {
      this[name] = value;
    },
    addEventListener: (_type, handler) => (click = handler),
  };
  const switched = [];
  bindVoiceProviderToggle({
    root: { querySelector: () => button },
    provider: 'openai',
    store,
    onSwitch: (next) => switched.push(next),
  });
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'OPENAI');
  click();
  assert.deepEqual(switched, ['gemini']);
  assert.equal(readVoiceProvider(store), 'gemini');
});

test('a silent microphone is named instead of listening forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  let chunk;
  let status = { muted: true };
  t.mock.method(console, 'warn', () => {});
  const session = createGeminiSession({
    emit: (event) => events.push(event),
    runAction: async () => ({ ok: true }),
    WebSocketImpl: FakeSocket,
    requestToken: async () => ({ token: 'tok', setup: { model: 'models/x' } }),
    createAudio: () => ({
      async startCapture(onChunk) {
        chunk = onChunk;
        return { label: 'Line In', status: () => status };
      },
      flush() {},
      stop() {},
    }),
  });
  await session.start();
  assert.equal(events.at(-1).detail, 'Gemini Live · Line In');
  t.mock.timers.tick(6000);
  assert.equal(
    events.at(-1).detail,
    'Microphone capture did not start (Line In)',
  );
  chunk('AAA=', 0.2);
  assert.equal(events.at(-1).detail, 'Gemini Live · Line In');
  session.stop();

  for (const [muted, detail] of [
    [true, 'The browser receives no audio from Line In'],
    [false, 'No sound yet from Line In'],
  ]) {
    status = { muted };
    await session.start();
    chunk('AAA=', 0);
    t.mock.timers.tick(6000);
    assert.equal(events.at(-1).detail, detail);
    session.stop();
  }
});

test('a session that ends during the microphone prompt releases the capture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const end of ['stop', 'close']) {
    const events = [];
    let stops = 0;
    let granted;
    const session = createGeminiSession({
      emit: (event) => events.push(event),
      runAction: async () => ({ ok: true }),
      WebSocketImpl: FakeSocket,
      requestToken: async () => ({ token: 'tok', setup: { model: 'models/x' } }),
      createAudio: () => ({
        startCapture: () => new Promise((resolve) => (granted = resolve)),
        flush() {},
        stop() {
          stops++;
        },
      }),
    });
    const starting = session.start();
    while (!granted) await new Promise((resolve) => setImmediate(resolve));
    if (end === 'stop') session.stop();
    else FakeSocket.last.onclose({ code: 1011, reason: 'gone' });
    const before = stops;
    granted({ label: 'Line In' });
    await starting;
    assert.equal(stops, before + 1, `${end}: late capture is released`);
    t.mock.timers.tick(6000);
    assert.ok(
      !events.some((event) => event.state === 'listening'),
      `${end}: an ended session never reports listening`,
    );
  }
});
