import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createLocalAiRealtime,
  isLoopbackOrigin,
  localAiOrigin,
} from '../../scripts/local-ai-realtime.mjs';

class FakeChild extends EventEmitter {
  exitCode = null;
  killedWith = null;

  kill(signal) {
    this.killedWith = signal;
  }
}

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body = '') { this.body = body; },
  };
}

test('LocalAI URL helpers accept loopback names and safely fall back', () => {
  assert.equal(localAiOrigin('http://127.0.0.1:9999/v1/realtime/calls'), 'http://127.0.0.1:9999');
  assert.equal(localAiOrigin('not a URL'), 'http://localhost:8080');
  assert.equal(isLoopbackOrigin('http://[::1]:8080'), true);
  assert.equal(isLoopbackOrigin('https://voice.example.com'), false);
});

test('LocalAI auto-start uses direct spawn with no shell', async () => {
  const child = new FakeChild();
  const calls = [];
  const runtime = createLocalAiRealtime({
    environment: {
      GEV_LOCAL_AI_BIN: '/opt/local-ai',
      GEV_LOCAL_AI_HOME: '/models/localai',
      GEV_LOCAL_REALTIME_URL: 'http://localhost:9090/v1/realtime/calls',
    },
    fetchImpl: async () => { throw new Error('offline'); },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  assert.deepEqual(await runtime.start(), { started: true, reason: 'spawned' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/opt/local-ai');
  assert.deepEqual(calls[0].args, ['run', '--address=:9090']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, '/models/localai');
  assert.equal(calls[0].options.env.LOCALAI_MODELS_PATH, '/models/localai/models');

  runtime.dispose();
  assert.equal(child.killedWith, 'SIGTERM');
});

test('LocalAI reports a missing executable without throwing', async () => {
  const child = new FakeChild();
  const runtime = createLocalAiRealtime({
    environment: {},
    fetchImpl: async () => { throw new Error('offline'); },
    spawnImpl() {
      const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
      queueMicrotask(() => child.emit('error', error));
      return child;
    },
  });

  const result = await runtime.status({ startRequested: true });
  assert.equal(result.state, 'unavailable');
  assert.match(result.detail, /local-ai not found on PATH/);
});

test('LocalAI never auto-starts a configured remote service', async () => {
  let spawned = false;
  const runtime = createLocalAiRealtime({
    environment: { GEV_LOCAL_REALTIME_URL: 'https://voice.example.com/v1/realtime/calls' },
    fetchImpl: async () => { throw new Error('offline'); },
    spawnImpl() { spawned = true; throw new Error('must not run'); },
  });

  const result = await runtime.status({ startRequested: true });
  assert.equal(result.state, 'unavailable');
  assert.match(result.detail, /remote/);
  assert.equal(spawned, false);
});

test('LocalAI ready status verifies and preloads the configured pipeline', async () => {
  const requests = [];
  const runtime = createLocalAiRealtime({
    environment: { GEV_LOCAL_REALTIME_MODEL: 'voice-pipeline' },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/backend/load')) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: [{ id: 'voice-pipeline' }] }) };
    },
  });

  const result = await runtime.status();
  assert.equal(result.state, 'ready');
  assert.equal(requests.filter((request) => request.url.endsWith('/v1/models')).length, 2);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { model: 'voice-pipeline' });
});

test('LocalAI calls relay translates raw SDP to JSON and unwraps the answer', async () => {
  let upstreamRequest;
  const runtime = createLocalAiRealtime({
    environment: { GEV_LOCAL_REALTIME_MODEL: 'voice-pipeline' },
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return { ok: true, status: 201, text: async () => JSON.stringify({ sdp: 'answer-sdp' }) };
    },
  });
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '?model=requested-model';
  req.destroy = () => {};
  const res = responseRecorder();
  const pending = runtime.callsRoute(req, res);
  req.emit('data', Buffer.from('offer-sdp'));
  req.emit('end');
  await pending;

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/sdp');
  assert.equal(res.body, 'answer-sdp');
  assert.equal(upstreamRequest.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(upstreamRequest.options.body), {
    sdp: 'offer-sdp',
    model: 'requested-model',
  });
});
