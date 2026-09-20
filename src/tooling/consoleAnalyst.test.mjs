import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  ANALYST_MODEL_DEFAULT,
  analystModel,
  analystPrompt,
  createAnalystHandler,
  normalizeAnalystRequest,
  supportsReasoningEffort,
} from '../../server/providers/openai/analyst.js';
import { openAiRealtimeProxy } from '../../server/providers/openai.js';

/** A request object shaped like the one the middleware receives. */
function request(method, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  stream.method = method;
  stream.url = '/';
  stream.headers = {};
  stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}

/** A response that records what the handler wrote. */
function response() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: '',
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = String(chunk ?? '');
      this.ended = true;
    },
    json() {
      return JSON.parse(this.body || '{}');
    },
  };
}

function okResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ output_text: text }),
  };
}

test('the model is the documented default until the environment overrides it', () => {
  assert.equal(analystModel({}), ANALYST_MODEL_DEFAULT);
  assert.equal(analystModel({ OPENAI_ANALYST_MODEL: '  ' }), ANALYST_MODEL_DEFAULT);
  assert.equal(analystModel({ OPENAI_ANALYST_MODEL: 'gpt-4.1' }), 'gpt-4.1');
});

test('the reasoning hint is sent only to models that accept it', () => {
  assert.equal(supportsReasoningEffort('gpt-5-mini'), true);
  assert.equal(supportsReasoningEffort('o4-mini'), true);
  assert.equal(supportsReasoningEffort('gpt-4.1'), false);
  assert.equal(supportsReasoningEffort(undefined), false);
});

test('a request is bounded before it can become a prompt', () => {
  const normalized = normalizeAnalystRequest({
    question: ` ${'q'.repeat(2000)} `,
    history: Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: 'h'.repeat(5000),
    })),
    context: { padding: 'c'.repeat(20_000) },
  });
  assert.equal(normalized.question.length, 800);
  assert.equal(normalized.history.length, 6);
  assert.equal(normalized.history[0].text.length, 1200);
  assert.ok(normalized.context.length <= 6000);
});

test('an unusable request is refused rather than sent upstream', () => {
  for (const payload of [{}, { question: '   ' }, { question: null }]) {
    assert.throws(() => normalizeAnalystRequest(payload), /question is required/);
  }
  // Empty turns and unknown roles are dropped, not forwarded.
  const normalized = normalizeAnalystRequest({
    question: 'what is here',
    history: [{ role: 'system', text: '' }, { role: 'whoever', text: 'kept' }],
  });
  assert.deepEqual(normalized.history, [{ role: 'user', text: 'kept' }]);
  assert.equal(normalized.context, '{}');
});

test('the prompt carries the snapshot, the turns and the question, in that order', () => {
  const prompt = analystPrompt(
    normalizeAnalystRequest({
      question: 'what is below me',
      history: [{ role: 'assistant', text: 'earlier answer' }],
      context: { place: 'Kyoto' },
    }),
  );
  assert.ok(prompt.indexOf('SCENE SNAPSHOT') < prompt.indexOf('EARLIER TURNS'));
  assert.ok(prompt.indexOf('EARLIER TURNS') < prompt.indexOf('OPERATOR QUESTION'));
  assert.match(prompt, /"place":"Kyoto"/);
  assert.match(prompt, /ANALYST: earlier answer/);
});

test('GET reports availability without spending a request', async () => {
  let calls = 0;
  const handler = createAnalystHandler({
    resolveApiKey: () => '',
    fetchImpl: async () => {
      calls += 1;
      return okResponse('nope');
    },
  });
  const res = response();
  await handler(request('GET'), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { configured: false, model: ANALYST_MODEL_DEFAULT });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(calls, 0, 'availability never reaches OpenAI');
});

test('without a credential the analyst reports offline instead of failing open', async () => {
  const handler = createAnalystHandler({
    resolveApiKey: () => '',
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
  });
  const res = response();
  await handler(request('POST', JSON.stringify({ question: 'hello' })), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().configured, false);
});

test('a question is answered, and the credential never leaves the server', async () => {
  let sent;
  const handler = createAnalystHandler({
    resolveApiKey: () => 'sk-test-secret',
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return okResponse('Two vessels are holding off the breakwater.');
    },
  });
  const res = response();
  await handler(
    request(
      'POST',
      JSON.stringify({ question: 'what is here', context: { place: 'Kobe' } }),
    ),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.match(res.json().answer, /breakwater/);
  assert.equal(res.json().model, ANALYST_MODEL_DEFAULT);
  assert.equal(sent.options.headers.Authorization, 'Bearer sk-test-secret');
  assert.doesNotMatch(res.body, /sk-test-secret/);
  const payload = JSON.parse(sent.options.body);
  assert.equal(payload.reasoning.effort, 'low');
  assert.ok(payload.max_output_tokens > 0, 'the answer is token-bounded');
});

test('a non-reasoning override drops the parameter that would reject it', async () => {
  let payload;
  const handler = createAnalystHandler({
    resolveApiKey: () => 'sk-test',
    resolveModel: () => 'gpt-4.1',
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return okResponse('answer');
    },
  });
  await handler(request('POST', JSON.stringify({ question: 'q' })), response());
  assert.equal(payload.model, 'gpt-4.1');
  assert.ok(!('reasoning' in payload));
});

test('malformed input, wrong methods and upstream faults each answer in kind', async () => {
  const handler = createAnalystHandler({
    resolveApiKey: () => 'sk-test',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limit reached' } }),
    }),
  });

  const malformed = response();
  await handler(request('POST', '{not json'), malformed);
  assert.equal(malformed.statusCode, 400);

  const empty = response();
  await handler(request('POST', JSON.stringify({ question: '' })), empty);
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().error, /question is required/);

  const wrongMethod = response();
  await handler(request('DELETE'), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);

  const upstream = response();
  await handler(request('POST', JSON.stringify({ question: 'q' })), upstream);
  assert.equal(upstream.statusCode, 429);
  assert.match(upstream.json().error, /Rate limit reached/);
});

test('an empty answer is a fault, not a blank reply presented as analysis', async () => {
  const handler = createAnalystHandler({
    resolveApiKey: () => 'sk-test',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  const res = response();
  await handler(request('POST', JSON.stringify({ question: 'q' })), res);
  assert.equal(res.statusCode, 502);
  assert.ok(res.json().error);
});

test('the analyst route is installed on both the dev and preview servers', () => {
  const plugin = openAiRealtimeProxy();
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const routes = [];
    plugin[hook]({ middlewares: { use: (route) => routes.push(route) } });
    assert.ok(routes.includes('/api/openai/analyst'), `${hook} serves the analyst`);
    assert.ok(routes.includes('/api/realtime/token'), `${hook} still serves voice`);
  }
});
