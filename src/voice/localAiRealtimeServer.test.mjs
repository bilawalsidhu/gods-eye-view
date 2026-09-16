import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createLocalAiRealtime,
  isLoopbackOrigin,
  localAiOrigin,
} from '../../server/providers/localai.js';

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
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

test('LocalAI URL helpers accept loopback names and safely fall back', () => {
  assert.equal(
    localAiOrigin('http://127.0.0.1:9999/v1/realtime/calls'),
    'http://127.0.0.1:9999',
  );
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
    fetchImpl: async () => {
      throw new Error('offline');
    },
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
  assert.equal(
    calls[0].options.env.LOCALAI_MODELS_PATH,
    '/models/localai/models',
  );

  runtime.dispose();
  assert.equal(child.killedWith, 'SIGTERM');
});

test('LocalAI reports a missing executable without throwing', async () => {
  const child = new FakeChild();
  const runtime = createLocalAiRealtime({
    environment: {},
    fetchImpl: async () => {
      throw new Error('offline');
    },
    spawnImpl() {
      const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
      queueMicrotask(() => child.emit('error', error));
      return child;
    },
  });

  const result = await runtime.status({ startRequested: true });
  assert.equal(result.state, 'needs-setup');
  assert.match(
    result.detail,
    /brew install localai.*npm run voice:local:setup/,
  );
});

test('LocalAI never auto-starts a configured remote service', async () => {
  let spawned = false;
  const runtime = createLocalAiRealtime({
    environment: {
      GEV_LOCAL_REALTIME_URL: 'https://voice.example.com/v1/realtime/calls',
    },
    fetchImpl: async () => {
      throw new Error('offline');
    },
    spawnImpl() {
      spawned = true;
      throw new Error('must not run');
    },
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
      if (url.endsWith('/backend/load'))
        return { ok: true, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'voice-pipeline' }] }),
      };
    },
  });

  const result = await runtime.status();
  assert.equal(result.state, 'ready');
  assert.equal(
    requests.filter((request) => request.url.endsWith('/v1/models')).length,
    2,
  );
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    model: 'voice-pipeline',
  });
});

test('an explicit start retries a settled pipeline preload failure', async () => {
  let loadAttempts = 0;
  const runtime = createLocalAiRealtime({
    environment: { GEV_LOCAL_REALTIME_MODEL: 'voice-pipeline' },
    readyGraceMs: 0,
    fetchImpl: async (url) => {
      if (url.endsWith('/backend/load')) {
        loadAttempts++;
        return loadAttempts === 1
          ? {
              ok: false,
              status: 500,
              json: async () => ({ error: 'fixture load failure' }),
            }
          : { ok: true, status: 200, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'voice-pipeline' }] }),
      };
    },
  });

  const failed = await runtime.status();
  assert.equal(failed.state, 'unavailable');
  assert.match(failed.detail, /fixture load failure/);

  const retried = await runtime.status({ startRequested: true });
  assert.equal(retried.state, 'ready');
  assert.equal(loadAttempts, 2);
});

test('LocalAI calls relay translates SDP and keeps the configured model server-owned', async () => {
  let upstreamRequest;
  const runtime = createLocalAiRealtime({
    environment: { GEV_LOCAL_REALTIME_MODEL: 'voice-pipeline' },
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ sdp: 'answer-sdp' }),
      };
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
  assert.equal(
    upstreamRequest.options.headers['Content-Type'],
    'application/json',
  );
  assert.deepEqual(JSON.parse(upstreamRequest.options.body), {
    sdp: 'offer-sdp',
    model: 'voice-pipeline',
  });
});

test('LocalAI points at the setup command when the pipeline is not installed', async () => {
  const runtime = createLocalAiRealtime({
    environment: { GEV_LOCAL_REALTIME_MODEL: 'voice-pipeline' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'something-else' }] }),
    }),
  });

  const result = await runtime.status();
  assert.equal(result.state, 'needs-setup');
  assert.match(result.detail, /npm run voice:local:setup/);
});

test('LocalAI reports download progress without blocking, and fails only on a stall', async () => {
  let clock = 1_000;
  let bytes = 50e6;
  const runtime = createLocalAiRealtime({
    environment: { GEV_LOCAL_REALTIME_MODEL: 'voice-pipeline' },
    fetchImpl: async (url) => {
      // A first run holds /backend/load open while it downloads weights.
      if (url.endsWith('/backend/load')) return new Promise(() => {});
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'voice-pipeline' }] }),
      };
    },
    now: () => clock,
    readyGraceMs: 0,
    stallTimeoutMs: 30_000,
    downloadedBytes: () => bytes,
  });

  const first = await runtime.status();
  assert.equal(first.state, 'starting');
  assert.match(first.detail, /Downloading model weights… 50 MB/);

  clock += 20_000;
  bytes = 120e6;
  const second = await runtime.status();
  assert.equal(
    second.state,
    'starting',
    'bytes still arriving keeps the warm-up alive',
  );

  clock += 31_000;
  const stalled = await runtime.status();
  assert.equal(stalled.state, 'unavailable');
  assert.match(stalled.detail, /stalled/);
});
