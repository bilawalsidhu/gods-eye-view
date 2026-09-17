import { readRequestBody } from '../../common/request.js';
import { streamChat } from '../chat.js';
import { visionModel } from '../vision.js';

/**
 * Multi-camera vision sweep: the browser fetches a handful of camera frames
 * through the CCTV proxy, shrinks them, and posts them here. Each frame is
 * shown to the local vision model separately with the same question; the
 * model answers in a few words and ends with a `SCORE: 0.x` line saying how
 * strongly the condition holds. The browser turns scores into map marks.
 */
export const VISION_BATCH_ROUTE = '/api/voice/vision-batch';
export const VISION_BATCH_MAX_IMAGES = 12;
export const VISION_BATCH_MAX_IMAGE_BYTES = 300 * 1024;
export const VISION_BATCH_CONCURRENCY = 2;
export const VISION_BATCH_IMAGE_TIMEOUT_MS = 40_000;
export const VISION_BATCH_MAX_QUESTION_CHARS = 400;
export const VISION_BATCH_MAX_BODY_BYTES = 6 * 1024 * 1024;

export const SWEEP_SYSTEM =
  'You are checking one public street camera frame as part of a sweep over ' +
  'several cameras. Answer the question about THIS frame only, in at most 20 ' +
  'plain words, no preamble and no markdown. Then on a new final line write ' +
  'SCORE: followed by a number from 0 to 1 for how strongly the condition in ' +
  'the question holds in this frame (1 = clearly yes, 0 = clearly no, 0.5 = ' +
  'cannot tell). If the frame is blank, a placeholder, night-dark or ' +
  'unreadable, say so and use SCORE: 0.5.';

const SCORE_LINE = /SCORE\s*[:=]?\s*([0-9]*\.?[0-9]+)\s*(%?)/gi;

/**
 * Split the model text into a short answer and a 0-1 score. The score comes
 * from the last `SCORE: x` occurrence; a missing or unparsable score is 0.5
 * so an unsure frame lands in the amber band rather than a colored one.
 */
export function parseVerdict(text) {
  const raw = String(text || '');
  let score = 0.5;
  let match = null;
  let last = null;
  SCORE_LINE.lastIndex = 0;
  while ((match = SCORE_LINE.exec(raw))) last = match;
  if (last) {
    let value = Number(last[1]);
    if (Number.isFinite(value)) {
      // Tolerate "80%", "85" (out of 100) and "7" (out of 10).
      if (last[2] === '%' || value > 10) value /= 100;
      else if (value > 1) value /= 10;
      score = Math.min(1, Math.max(0, value));
    }
  }
  const answer = raw
    .replace(/\n?\s*SCORE\s*[:=]?\s*[0-9]*\.?[0-9]+\s*%?\s*\.?/gi, ' ')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    answer: answer || 'No answer',
    score: Math.round(score * 100) / 100,
  };
}

function approxBytesOfBase64(value) {
  const body = value.replace(/=+$/, '');
  return Math.floor((body.length * 3) / 4);
}

/**
 * Keep the well-formed images (in order), strip data-URL prefixes, and drop
 * anything past the per-image byte cap or the batch size cap. Dropped entries
 * are reported so the browser can name the cameras it could not check.
 */
export function normalizeBatchImages(
  list,
  {
    maxImages = VISION_BATCH_MAX_IMAGES,
    maxImageBytes = VISION_BATCH_MAX_IMAGE_BYTES,
  } = {},
) {
  const images = [];
  const dropped = [];
  if (!Array.isArray(list)) return { images, dropped };
  list.forEach((entry, index) => {
    const id = String(entry?.id ?? index);
    const label = String(entry?.label || entry?.id || `camera ${index + 1}`);
    if (typeof entry?.image !== 'string' || !entry.image.trim()) {
      dropped.push({ id, label, reason: 'missing image' });
      return;
    }
    const image = entry.image.replace(/^data:image\/[a-z+]+;base64,/i, '');
    if (approxBytesOfBase64(image) > maxImageBytes) {
      dropped.push({
        id,
        label,
        reason: `image larger than ${Math.round(maxImageBytes / 1024)} KB`,
      });
      return;
    }
    if (images.length >= maxImages) {
      dropped.push({ id, label, reason: `over the ${maxImages}-image cap` });
      return;
    }
    images.push({
      id,
      label: label.slice(0, 120),
      lat: Number.isFinite(entry?.lat) ? entry.lat : null,
      lon: Number.isFinite(entry?.lon) ? entry.lon : null,
      image,
    });
  });
  return { images, dropped };
}

function linkedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('vision timeout')),
    timeoutMs,
  );
  const onAbort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Ask the vision model about every image with a small worker pool. Results
 * come back in input order; a failed or timed-out frame is kept with score
 * 0.5 and an `error` so one bad camera never sinks the sweep.
 */
export async function runVisionBatch(
  { question, images },
  {
    chat = streamChat,
    model = visionModel(),
    concurrency = VISION_BATCH_CONCURRENCY,
    timeoutMs = VISION_BATCH_IMAGE_TIMEOUT_MS,
    signal,
    now = Date.now,
    log = () => {},
  } = {},
) {
  const results = new Array(images.length);
  let next = 0;
  const prompt = `Question: ${question}\nSay what you see that decides it (5-20 words), then the SCORE line.`;
  async function worker() {
    while (next < images.length) {
      if (signal?.aborted) return;
      const index = next++;
      const item = images[index];
      const started = now();
      const link = linkedSignal(signal, timeoutMs);
      try {
        const reply = await chat({
          model,
          messages: [
            { role: 'system', content: SWEEP_SYSTEM },
            {
              role: 'user',
              content: `${prompt}\nCamera: ${item.label}`,
              images: [item.image],
            },
          ],
          tools: [],
          // qwen3-vl keeps its reasoning out of the content only when no
          // think flag is sent at all (see vision.js). That reasoning still
          // counts against num_predict (about 150-300 tokens per frame in
          // practice), so the budget must leave room for the answer itself:
          // at 160 the content came back empty.
          think: 'omit',
          signal: link.signal,
          options: { num_ctx: 4096, num_predict: 512, temperature: 0.1 },
        });
        const verdict = parseVerdict(reply?.content);
        results[index] = {
          id: item.id,
          label: item.label,
          lat: item.lat,
          lon: item.lon,
          answer: verdict.answer,
          score: verdict.score,
          ms: now() - started,
        };
      } catch (error) {
        const message = link.signal.aborted
          ? `vision timed out after ${Math.round(timeoutMs / 1000)} s`
          : error?.message || String(error);
        results[index] = {
          id: item.id,
          label: item.label,
          lat: item.lat,
          lon: item.lon,
          answer: 'Could not analyse this frame',
          score: 0.5,
          ms: now() - started,
          error: message,
        };
      } finally {
        link.release();
      }
      log('vision.batch.item', {
        id: item.id,
        ms: results[index].ms,
        score: results[index].score,
        error: results[index].error || null,
      });
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, Math.min(concurrency, images.length)); i++)
    workers.push(worker());
  await Promise.all(workers);
  const done = results.filter(Boolean);
  return {
    results: done,
    summary: summarizeScores(done),
  };
}

export function summarizeScores(results) {
  const high = [];
  const low = [];
  for (const r of results) {
    if (r.error) continue;
    if (r.score >= 0.6) high.push(r.id);
    else if (r.score <= 0.4) low.push(r.id);
  }
  return { high, low };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Build the connect handler; deps are injectable for tests. */
export function createVisionBatchHandler({
  chat = streamChat,
  model,
  concurrency,
  timeoutMs,
  maxImages,
  maxImageBytes,
  maxBodyBytes = VISION_BATCH_MAX_BODY_BYTES,
  log = () => {},
} = {}) {
  return async function handleVisionBatch(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort(new Error('client closed'));
    };
    res.on?.('close', onClose);
    const started = Date.now();
    try {
      let body;
      try {
        body = JSON.parse((await readRequestBody(req, maxBodyBytes)) || '{}');
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: /exceeds/.test(error?.message || '')
            ? 'Request body too large'
            : 'Invalid JSON body',
        });
        return;
      }
      const question = String(body?.question || '')
        .trim()
        .slice(0, VISION_BATCH_MAX_QUESTION_CHARS);
      if (!question) {
        sendJson(res, 400, { ok: false, error: 'A question is required' });
        return;
      }
      const { images, dropped } = normalizeBatchImages(body?.images, {
        maxImages,
        maxImageBytes,
      });
      if (!images.length) {
        sendJson(res, 400, {
          ok: false,
          error: 'No usable images supplied',
          dropped,
        });
        return;
      }
      const batch = await runVisionBatch(
        { question, images },
        {
          chat,
          model: model || visionModel(),
          concurrency,
          timeoutMs,
          signal: abort.signal,
          log,
        },
      );
      if (res.writableEnded) return;
      sendJson(res, 200, {
        ok: true,
        question,
        model: model || visionModel(),
        results: batch.results,
        summary: batch.summary,
        dropped,
        ms: Date.now() - started,
      });
    } catch (error) {
      if (res.writableEnded) return;
      sendJson(res, abort.signal.aborted ? 499 : 502, {
        ok: false,
        error: abort.signal.aborted
          ? 'Vision batch cancelled'
          : error?.message || 'Vision batch failed',
      });
    } finally {
      res.off?.('close', onClose);
    }
  };
}

export function install(middlewares) {
  middlewares.use(VISION_BATCH_ROUTE, createVisionBatchHandler());
}
