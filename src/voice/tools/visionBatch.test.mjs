import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  createVisionBatchHandler,
  normalizeBatchImages,
  parseVerdict,
  runVisionBatch,
  summarizeScores,
  VISION_BATCH_MAX_IMAGES,
} from '../../../server/providers/ollama/routes/visionBatch.js';

const img = (id, bytes = 64) => ({ id, label: `Cam ${id}`, lat: 30, lon: -97, image: 'A'.repeat(Math.ceil((bytes * 4) / 3)) });

test('parseVerdict splits the answer from the SCORE line and clamps', () => {
  assert.deepEqual(parseVerdict('Traffic is stopped bumper to bumper.\nSCORE: 0.9'), { answer: 'Traffic is stopped bumper to bumper.', score: 0.9 });
  assert.deepEqual(parseVerdict('Light traffic, lanes flowing. Score = 0.15'), { answer: 'Light traffic, lanes flowing.', score: 0.15 });
  assert.equal(parseVerdict('Placeholder frame, nothing visible').score, 0.5);
  assert.equal(parseVerdict('Jammed. SCORE: 80%').score, 0.8);
  assert.equal(parseVerdict('Jammed. SCORE: 7').score, 0.7);
  assert.equal(parseVerdict('Jammed. SCORE: 85').score, 0.85);
  assert.equal(parseVerdict('SCORE: 1.7 clearly yes').score, 0.17);
  assert.equal(parseVerdict('').answer, 'No answer');
  assert.equal(parseVerdict('First 0.2\nSCORE: 0.2\nActually SCORE: 0.7').score, 0.7);
});

test('normalizeBatchImages caps the batch, strips data URLs and drops oversize frames', () => {
  const list = Array.from({ length: VISION_BATCH_MAX_IMAGES + 2 }, (_, i) => img(`c${i}`));
  list[1] = { ...list[1], image: `data:image/jpeg;base64,${list[1].image}` };
  list.push({ id: 'big', label: 'Big', image: 'B'.repeat(420 * 1024) });
  list.push({ id: 'none', label: 'None' });
  const { images, dropped } = normalizeBatchImages(list);
  assert.equal(images.length, VISION_BATCH_MAX_IMAGES);
  assert.equal(images[1].image.startsWith('data:'), false);
  assert.deepEqual(dropped.map((d) => d.id), ['c12', 'c13', 'big', 'none']);
  assert.match(dropped[0].reason, /cap/);
  assert.match(dropped[2].reason, /KB/);
  assert.match(dropped[3].reason, /missing/);
  assert.equal(normalizeBatchImages([{ id: 'huge', image: 'B'.repeat(420 * 1024) }, img('ok')]).images[0].id, 'ok');
  assert.deepEqual(normalizeBatchImages(null), { images: [], dropped: [] });
});

test('runVisionBatch keeps order, parses scores, and never exceeds the concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  const chat = async ({ messages, think, options, model }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    seen.push({ think, model, ctx: options.num_ctx, image: messages[1].images[0], content: messages[1].content });
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const id = messages[1].content.match(/Cam (\w+)/)[1];
    return { content: `Camera ${id} view.\nSCORE: 0.${id.length === 1 ? Number(id) : 5}` };
  };
  const images = ['9', '1', '5', '8', '2'].map((id) => img(id));
  const out = await runVisionBatch({ question: 'Is it jammed?', images }, { chat, model: 'fake-vl', concurrency: 2 });
  assert.equal(peak, 2);
  assert.deepEqual(out.results.map((r) => r.id), ['9', '1', '5', '8', '2']);
  assert.deepEqual(out.results.map((r) => r.score), [0.9, 0.1, 0.5, 0.8, 0.2]);
  assert.equal(out.results[0].answer, 'Camera 9 view.');
  assert.ok(out.results.every((r) => Number.isFinite(r.ms) && r.lat === 30));
  assert.deepEqual(out.summary, { high: ['9', '8'], low: ['1', '2'] });
  assert.ok(seen.every((s) => s.think === 'omit' && s.model === 'fake-vl' && s.ctx === 4096));
  assert.equal(seen[0].image, images[0].image);
  assert.match(seen[0].content, /Question: Is it jammed\?/);
});

test('runVisionBatch keeps a failed or timed-out frame as an unsure result', async () => {
  const chat = async ({ messages, signal }) => {
    if (/Cam slow/.test(messages[1].content))
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    if (/Cam boom/.test(messages[1].content)) throw new Error('Ollama chat failed (500)');
    return { content: 'Clear road.\nSCORE: 0.1' };
  };
  const out = await runVisionBatch(
    { question: 'q', images: [img('slow'), img('boom'), img('ok')] },
    { chat, concurrency: 2, timeoutMs: 20 },
  );
  assert.equal(out.results.length, 3);
  assert.match(out.results[0].error, /timed out/);
  assert.equal(out.results[0].score, 0.5);
  assert.match(out.results[1].error, /500/);
  assert.equal(out.results[2].score, 0.1);
  // errored frames stay out of both bands
  assert.deepEqual(out.summary, { high: [], low: ['ok'] });
  assert.deepEqual(summarizeScores([{ id: 'a', score: 0.6 }, { id: 'b', score: 0.4 }, { id: 'c', score: 0.5 }]), { high: ['a'], low: ['b'] });
});

function fakeRequest(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.destroy = () => {};
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}

function fakeResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.writableEnded = false;
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.done = new Promise((resolve) => {
    res.end = (payload) => {
      res.writableEnded = true;
      res.body = JSON.parse(payload);
      resolve(res.body);
    };
  });
  return res;
}

test('handler validates the request and returns results plus summary', async () => {
  const chat = async () => ({ content: 'Heavy traffic.\nSCORE: 0.85' });
  const handler = createVisionBatchHandler({ chat, model: 'fake-vl' });

  const bad = fakeResponse();
  await handler(fakeRequest('GET'), bad);
  assert.equal(bad.statusCode, 405);

  const noQuestion = fakeResponse();
  await handler(fakeRequest('POST', { images: [img('a')] }), noQuestion);
  assert.equal(noQuestion.statusCode, 400);
  assert.match(noQuestion.body.error, /question/);

  const noImages = fakeResponse();
  await handler(fakeRequest('POST', { question: 'q', images: [{ id: 'x' }] }), noImages);
  assert.equal(noImages.statusCode, 400);
  assert.equal(noImages.body.dropped.length, 1);

  const junk = fakeResponse();
  await handler(fakeRequest('POST', '{not json'), junk);
  assert.equal(junk.statusCode, 400);

  const ok = fakeResponse();
  await handler(fakeRequest('POST', { question: 'Jammed?', images: [img('a'), img('b')] }), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.model, 'fake-vl');
  assert.equal(ok.body.results.length, 2);
  assert.equal(ok.body.results[0].answer, 'Heavy traffic.');
  assert.deepEqual(ok.body.summary, { high: ['a', 'b'], low: [] });
  assert.deepEqual(ok.body.dropped, []);
  assert.equal(ok.headers['Cache-Control'], 'no-store');
});

test('handler rejects a body over the byte cap', async () => {
  const handler = createVisionBatchHandler({ chat: async () => ({ content: 'x' }), maxBodyBytes: 200 });
  const res = fakeResponse();
  await handler(fakeRequest('POST', { question: 'q', images: [img('a', 400)] }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /too large/);
});
