import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createGeminiChatHandler } from '../server/providers/gemini/chat.js';
const contents = [{ role: 'user', parts: [{ text: 'Hello' }] }];
async function request(input, overrides = {}) {
  const calls = [];
  const handler = createGeminiChatHandler({
    resolveApiKey: () => 'fixture-key',
    resolveRateLimit: () => '0',
    resolveHost: () => '',
    resolveAllowedHosts: () => '',
    tools: [
      { name: 'fly_to', description: 'Fly', parameters: { type: 'object' } },
    ],
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello' }] },
            finishReason: 'STOP',
          },
        ],
      });
    },
    ...overrides,
  });
  const req = new PassThrough();
  req.method = 'POST';
  req.headers = {
    host: 'localhost:4190',
    origin: 'http://localhost:4190',
    'content-type': 'application/json',
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = new EventEmitter();
  res.setHeader = () => {};
  res.end = (body) => {
    res.body = JSON.parse(body);
    res.writableEnded = true;
  };
  const done = handler(req, res);
  req.end(JSON.stringify(input));
  await done;
  return { calls, res };
}
test('Gemini chat pins text output, server tools and model without Live settings', async () => {
  const { calls, res } = await request({ contents });
  assert.equal(res.statusCode, 200);
  assert.match(calls[0].url, /gemini-3.5-flash-lite:generateContent$/);
  assert.deepEqual(calls[0].body.generationConfig.responseModalities, ['TEXT']);
  assert.equal(
    calls[0].body.tools[0].functionDeclarations[0].behavior,
    undefined,
  );
  assert.equal(calls[0].body.outputAudioTranscription, undefined);
});
test('chat rejects caller configuration, media and undeclared tool history before upstream', async () => {
  for (const input of [
    { contents, model: 'other' },
    { contents: [{ role: 'user', parts: [{ inlineData: { data: 'AA==' } }] }] },
    {
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'not_allowed', args: {} } }],
        },
      ],
    },
  ]) {
    const { calls, res } = await request(input);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  }
});
test('chat refuses audio models and hides upstream errors', async () => {
  const bad = await request(
    { contents },
    { resolveChatModel: () => 'gemini-3.8-live' },
  );
  assert.equal(bad.res.statusCode, 503);
  assert.equal(bad.calls.length, 0);
  const failure = await request(
    { contents },
    {
      fetchImpl: async () =>
        new Response('sensitive upstream detail', { status: 500 }),
    },
  );
  assert.equal(failure.res.statusCode, 502);
  assert.ok(!JSON.stringify(failure.res.body).includes('sensitive'));
});

test('chat history round-trips signatures and function results while rejecting user signatures', async () => {
  const exchange = [
    ...contents,
    {
      role: 'model',
      parts: [
        {
          thoughtSignature: 'opaque',
          functionCall: { name: 'fly_to', args: {}, id: 'call' },
        },
      ],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'fly_to',
            id: 'call',
            response: { ok: true },
          },
        },
      ],
    },
  ];
  const good = await request({ contents: exchange });
  assert.equal(good.res.statusCode, 200);
  assert.deepEqual(good.calls[0].body.contents, exchange);
  const bad = await request({
    contents: [
      { role: 'user', parts: [{ text: 'Hello', thoughtSignature: 'opaque' }] },
    ],
  });
  assert.equal(bad.res.statusCode, 400);
});

test('foreign and missing origins cannot spend the server key', async () => {
  for (const origin of [undefined, 'https://elsewhere.example']) {
    let calls = 0;
    const handler = createGeminiChatHandler({
      resolveHost: () => '',
      resolveAllowedHosts: () => '',
      fetchImpl: () => {
        calls++;
        throw Error('unexpected');
      },
    });
    const req = new PassThrough();
    req.method = 'POST';
    req.headers = {
      host: 'localhost:4190',
      ...(origin ? { origin } : {}),
      'content-type': 'application/json',
    };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.end = () => {
      res.writableEnded = true;
    };
    const done = handler(req, res);
    req.end('{}');
    await done;
    assert.equal(res.statusCode, 403);
    assert.equal(calls, 0);
  }
});
