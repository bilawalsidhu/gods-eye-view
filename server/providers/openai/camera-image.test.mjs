import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createCameraImageHandler, readCameraBody } from './camera-image.js';
import { sameSiteGated } from '../common/same-site.js';

async function invoke(handler, method = 'GET', body = null, headers = {}) {
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  );
  Object.assign(req, {
    method,
    url: '/api/openai/camera-image',
    originalUrl: '/api/openai/camera-image',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
      ...headers,
    },
  });
  const res = new EventEmitter();
  res.setHeader = () => {};
  res.end = (text) => {
    res.writableEnded = true;
    res.body = JSON.parse(text);
  };
  await handler(req, res);
  return res;
}
function fixture(models = ['gpt-6-astra', 'gpt-6.1-sol']) {
  const calls = [];
  const handler = createCameraImageHandler({
    resolveApiKey: () => 'fixture-only',
    rateLimit: () => true,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify(
          url.endsWith('/models')
            ? { data: models.map((id) => ({ id })) }
            : {
                output: [
                  {
                    content: [
                      {
                        type: 'output_text',
                        text: 'Tentative vehicle; exact model unknown.',
                      },
                    ],
                  },
                ],
              },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  return { handler, calls };
}
test('capability lists user-selected Sol account model without inference or credentials in output', async () => {
  const { handler, calls } = fixture(),
    r = await invoke(handler);
  assert.equal(r.body.model, 'gpt-6.1-sol');
  assert.equal(r.body.reasoning, 'high');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/models'));
  assert.ok(!JSON.stringify(r.body).includes('fixture-only'));
});
test('missing key is a concrete blocker and never calls upstream', async () => {
  const handler = createCameraImageHandler({
      resolveApiKey: () => null,
      fetchImpl: () => {
        throw Error('must not run');
      },
    }),
    r = await invoke(handler);
  assert.equal(r.body.code, 'OPENAI_API_KEY_NOT_CONFIGURED');
  assert.equal(r.body.available, false);
});

test('missing requested Sol model never falls back to Astra or another Sol version', async () => {
  const { handler, calls } = fixture([
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
  ]);
  const r = await invoke(handler);
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.available, false);
  assert.equal(r.body.code, 'IMAGE_MODEL_NOT_LISTED');
  assert.match(r.body.error, /gpt-6\.1-sol/);
  assert.equal(calls.length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/responses')).length, 0);
});
test('explicit original confirmation, one bounded PNG and reviewed model required before inference', async () => {
  const { handler, calls } = fixture();
  for (const body of [
    {},
    { confirmOriginal: true, provider: 'OpenAI', model: 'gpt-unknown' },
    {
      confirmOriginal: true,
      provider: 'OpenAI',
      model: 'gpt-6.1-sol',
      image: 'https://arbitrary.invalid/image',
    },
  ])
    assert.ok((await invoke(handler, 'POST', body)).statusCode >= 400);
  assert.equal(calls.filter((c) => c.url.endsWith('/responses')).length, 0);
});
test('single image request uses original PNG, high reasoning, no tools/store, untrusted input guidance', async () => {
  const { handler, calls } = fixture(),
    png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(244, 20);
  const image = 'data:image/png;base64,' + png.toString('base64'),
    r = await invoke(handler, 'POST', {
      confirmOriginal: true,
      provider: 'OpenAI',
      model: 'gpt-6.1-sol',
      image,
      question: 'What visible details?',
      marks: [
        {
          mode: 'circle',
          points: [
            { x: 0.2, y: 0.3, extraPrivateText: 'must be removed' },
            { x: 9, y: 9 },
          ],
        },
      ],
    });
  assert.equal(r.statusCode, 200);
  const payload = JSON.parse(
    calls.find((c) => c.url.endsWith('/responses')).options.body,
  );
  assert.equal(payload.store, false);
  assert.equal(payload.reasoning.effort, 'high');
  assert.equal(payload.max_output_tokens, 16384);
  assert.equal(payload.input[0].content[1].image_url, image);
  assert.equal(payload.tools, undefined);
  assert.match(payload.instructions, /untrusted/);
  assert.match(payload.instructions, /not validated accuracy/);
  assert.deepEqual(
    JSON.parse(payload.input[0].content[0].text).normalizedMarks[0].points,
    [{ x: 0.2, y: 0.3 }],
  );
  assert.equal(
    JSON.parse(payload.input[0].content[0].text).normalizedMarks[0].points
      .length,
    1,
  );
});
test('stalled request body cancellation releases buffers and listeners', async () => {
  const req = new Readable({ read() {} });
  const controller = new AbortController();
  const pending = readCameraBody(req, controller.signal, 64);
  req.push(Buffer.from('partial body'));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  for (const event of ['data', 'end', 'error'])
    assert.equal(req.listenerCount(event), 0);
  req.destroy();
});
test('oversized streaming body fails at byte cap and retains no input listener', async () => {
  const req = new Readable({ read() {} }),
    controller = new AbortController();
  const pending = readCameraBody(req, controller.signal, 8);
  req.push(Buffer.alloc(9));
  await assert.rejects(pending, { code: 'BODY_TOO_LARGE' });
  assert.equal(req.listenerCount('data'), 0);
  req.destroy();
});
test('foreign origin denied before model check or inference', async () => {
  const { handler, calls } = fixture(),
    r = await invoke(sameSiteGated(handler), 'GET', null, {
      origin: 'https://evil.invalid',
    });
  assert.equal(r.statusCode, 403);
  assert.equal(calls.length, 0);
});
