import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  completeLocalModel,
  localModelProxy,
} from '../server/providers/local-model.js';
import { handleHudSummary } from '../server/providers/openai/hud-summary.js';

const environment = {
  GEV_LLM_PROVIDER: 'bifrost',
  GEV_LLM_BASE_URL: 'http://127.0.0.1:49443/openai/v1',
  GEV_LLM_MODEL: 'local/scheduler-fixture',
  GEV_LLM_API_KEY: 'synthetic-scheduler-key',
};
const messages = [{ role: 'user', content: 'Synthetic scheduling request' }];
const response = () =>
  Response.json({
    choices: [
      { finish_reason: 'stop', message: { content: 'Fixture response' } },
    ],
  });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** Hold fetch completion or abort cleanup explicitly; no real model is called. */
function upstream(t) {
  const calls = [];
  const observers = [];
  const fetchImpl = async (url, { signal }) => {
    const done = deferred();
    const aborted = deferred();
    const call = { url, signal, done, aborted, holdAbort: false };
    calls.push(call);
    const onAbort = () => {
      aborted.resolve();
      if (!call.holdAbort) done.reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    for (const resolve of observers.splice(0)) resolve();
    try {
      return await done.promise;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  t.after(() => {
    for (const call of calls) call.done.resolve(response());
  });
  return {
    calls,
    fetchImpl,
    async call(index) {
      while (!calls[index]) {
        await new Promise((resolve) => observers.push(resolve));
      }
      return calls[index];
    },
    complete(options = {}, input = {}) {
      return completeLocalModel(
        { messages, ...input },
        {
          environment,
          fetchImpl,
          timeoutMs: 5000,
          ...options,
        },
      );
    },
  };
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test('foreground requests serialize across model aliases and credentials at one gateway', async (t) => {
  const model = upstream(t);
  const first = model.complete();
  const firstCall = await model.call(0);
  const second = model.complete({
    environment: {
      ...environment,
      GEV_LLM_MODEL: 'local/another-alias',
      GEV_LLM_API_KEY: 'another-synthetic-key',
      GEV_LLM_BASE_URL: 'http://127.0.0.1:49443/another-compatible-path',
    },
  });
  await nextTurn();
  assert.equal(model.calls.length, 1);
  firstCall.done.resolve(response());
  await first;
  const secondCall = await model.call(1);
  secondCall.done.resolve(response());
  assert.equal((await second).content, 'Fixture response');
});

test('chat preempts active HUD and waits for abort cleanup before starting', async (t) => {
  const model = upstream(t);
  const background = model.complete({ priority: 'background' });
  const backgroundError = assert.rejects(background, { status: 503 });
  const backgroundCall = await model.call(0);
  backgroundCall.holdAbort = true;
  const chat = model.complete();
  await backgroundCall.aborted.promise;
  assert.equal(backgroundCall.signal.aborted, true);
  assert.equal(
    model.calls.length,
    1,
    'chat must wait until the old fetch settles',
  );
  backgroundCall.done.reject(backgroundCall.signal.reason);
  await backgroundError;
  const chatCall = await model.call(1);
  chatCall.done.resolve(response());
  await chat;
});

test('the production local HUD route uses background priority and reports preemption', async (t) => {
  const model = upstream(t);
  const originalFetch = globalThis.fetch;
  const saved = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, environment);
  globalThis.fetch = model.fetchImpl;
  const base = await serve(t, handleHudSummary);
  const hud = originalFetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place: 'Synthetic fixture' }),
  });
  const background = await model.call(0);
  const chat = model.complete();
  await background.aborted.promise;
  const skipped = await hud;
  assert.equal(skipped.status, 503);
  assert.match((await skipped.json()).error, /interrupted for chat/);
  (await model.call(1)).done.resolve(response());
  await chat;
});

test('foreground queue is bounded; background work skips immediately and recovers when idle', async (t) => {
  const model = upstream(t);
  const first = model.complete();
  await model.call(0);
  const waiting = Array.from({ length: 4 }, () => model.complete());
  await assert.rejects(model.complete(), {
    status: 503,
    message: /queue is full/,
  });
  for (let i = 0; i < 12; i++) {
    await assert.rejects(model.complete({ priority: 'background' }), {
      status: 503,
      message: /HUD summary skipped/,
    });
  }
  assert.equal(
    model.calls.length,
    1,
    'skipped work must never reach the model',
  );
  for (let i = 0; i < 5; i++) {
    (await model.call(i)).done.resolve(response());
  }
  await Promise.all([first, ...waiting]);
  const hud = model.complete({ priority: 'background' });
  (await model.call(5)).done.resolve(response());
  assert.equal((await hud).content, 'Fixture response');
  assert.equal(model.calls.length, 6, 'no deferred background backlog');
});

test('queue time consumes the deadline and queued cancellation never reaches upstream', async (t) => {
  const model = upstream(t);
  const first = model.complete();
  const active = await model.call(0);
  const controller = new AbortController();
  const cancelled = model.complete({}, { signal: controller.signal });
  const cancelledError = assert.rejects(cancelled, { status: 504 });
  const expired = model.complete({ timeoutMs: 20 });
  const expiredError = assert.rejects(expired, { status: 504 });
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer runs.
  await new Promise((resolve) => setTimeout(resolve, 35));
  controller.abort();
  await Promise.all([cancelledError, expiredError]);
  active.done.resolve(response());
  await first;
  const replacement = model.complete();
  (await model.call(1)).done.resolve(response());
  await replacement;
  assert.equal(model.calls.length, 2);
});

test('a response body keeps the upstream slot until it completes', async (t) => {
  const model = upstream(t);
  let body;
  const first = model.complete();
  (await model.call(0)).done.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          body = controller;
        },
      }),
    ),
  );
  await nextTurn();
  const second = model.complete();
  await nextTurn();
  assert.equal(model.calls.length, 1);
  body.enqueue(new TextEncoder().encode(await response().text()));
  body.close();
  await first;
  (await model.call(1)).done.resolve(response());
  await second;
});

test('separate gateways have independent capacity', async (t) => {
  const model = upstream(t);
  const first = model.complete();
  await model.call(0);
  const second = model.complete({
    environment: {
      ...environment,
      GEV_LLM_BASE_URL: 'http://127.0.0.1:49444/v1',
    },
  });
  const other = await model.call(1);
  other.done.resolve(response());
  await second;
  model.calls[0].done.resolve(response());
  await first;
});

test('an HTTP client disconnect aborts active inference and releases a queued chat', async (t) => {
  const model = upstream(t);
  const routes = new Map();
  localModelProxy({
    environment,
    tools: [],
    fetchImpl: model.fetchImpl,
  }).configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  const base = await serve(t, (req, res) => routes.get(req.url)(req, res));
  const url = `${base}/api/local-model/chat`;
  const client = new AbortController();
  const disconnected = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, tools: false }),
    signal: client.signal,
  });
  const disconnectedError = assert.rejects(disconnected, {
    name: 'AbortError',
  });
  const active = await model.call(0);
  const waiting = model.complete();
  await nextTurn();
  assert.equal(model.calls.length, 1);
  client.abort();
  await disconnectedError;
  await active.aborted.promise;
  const next = await model.call(1);
  assert.equal(active.signal.aborted, true);
  next.done.resolve(response());
  await waiting;
});
