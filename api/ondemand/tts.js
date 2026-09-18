/**
 * api/ondemand/tts.js — POST /api/ondemand/tts.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md §6.2 "Text -> audio (TTS)".
 * Upstream always returns `{message, data:{audioUrl}}` — streaming synthesis
 * is NOT FOUND IN LIVE DOCS, so this endpoint's "audio" mode is always a
 * second, full download of that URL: latency = full synthesis + download.
 *
 * Default (`?format=audio`, or an Accept header containing `audio/`): fetch
 * `data.audioUrl` server-side and stream the bytes back.
 * `?format=json`: return the upstream JSON envelope unchanged.
 */

import { isConfigured, baseUrls, requestTimeoutMs } from './_config.js';
import { ondemandFetch } from '../../server/ondemand/client.js';
import { shapeUpstreamError } from '../../server/ondemand/errors.js';
import { pipeBinaryBody } from '../../server/ondemand/sse.js';
import {
  sendJson,
  assertMethod,
  rejectCrossOrigin,
  readJsonBody,
  BodyError,
  getRequestUrl,
} from '../../server/ondemand/http.js';

const MAX_INPUT_CHARS = 4096;
const ALLOWED_MODELS = ['tts-1', 'tts-1-hd'];
const ALLOWED_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

export default async function handler(req, res) {
  if (rejectCrossOrigin(req, res)) return;
  if (!assertMethod(req, res, ['POST'])) return;
  if (!isConfigured()) {
    sendJson(res, 503, {
      error: 'not_configured',
      message: 'ONDEMAND_API_KEY is not set on the server.',
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, { maxBytes: 32 * 1024 });
  } catch (err) {
    if (err instanceof BodyError) {
      sendJson(res, err.status, err.payload);
      return;
    }
    throw err;
  }

  if (
    typeof body?.input !== 'string' ||
    body.input.length === 0 ||
    body.input.length > MAX_INPUT_CHARS
  ) {
    sendJson(res, 400, {
      error: 'input_required',
      message: `input is required, \u2264 ${MAX_INPUT_CHARS} chars`,
    });
    return;
  }
  if (body.model !== undefined && !ALLOWED_MODELS.includes(body.model)) {
    sendJson(res, 400, { error: 'invalid_model', allowed: ALLOWED_MODELS });
    return;
  }
  if (body.voice !== undefined && !ALLOWED_VOICES.includes(body.voice)) {
    sendJson(res, 400, { error: 'invalid_voice', allowed: ALLOWED_VOICES });
    return;
  }

  const upstreamBody = {
    input: body.input,
    model: body.model,
    voice: body.voice,
  };
  for (const key of Object.keys(upstreamBody)) {
    if (upstreamBody[key] === undefined) delete upstreamBody[key];
  }

  let upstream;
  try {
    upstream = await ondemandFetch(
      `${baseUrls().services}/execute/text_to_speech`,
      {
        method: 'POST',
        body: upstreamBody,
      },
    );
  } catch {
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'Unexpected error contacting OnDemand.',
    });
    return;
  }
  if (!upstream.ok) {
    sendJson(res, upstream.status, await shapeUpstreamError(upstream));
    return;
  }

  let json;
  try {
    json = await upstream.json(); // {message, data:{audioUrl}}
  } catch {
    sendJson(res, 502, {
      error: 'proxy_error',
      message: 'OnDemand returned a non-JSON text_to_speech response.',
    });
    return;
  }
  const audioUrl = json?.data?.audioUrl;

  const url = getRequestUrl(req);
  const format = url.searchParams.get('format');
  const accept = req.headers['accept'] || '';
  const wantsAudio =
    format === 'audio' || (format !== 'json' && accept.includes('audio/'));

  if (!wantsAudio || typeof audioUrl !== 'string') {
    sendJson(res, 200, json);
    return;
  }

  let audioResp;
  try {
    audioResp = await fetch(audioUrl, {
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
  } catch {
    sendJson(res, 200, json); // fall back to the JSON envelope rather than fail the whole call
    return;
  }
  if (!audioResp.ok || !audioResp.body) {
    sendJson(res, 200, json);
    return;
  }

  res.statusCode = 200;
  // §6.2: the sample URL is an .mp3; fall back to audio/mpeg when the host
  // storage response doesn't send its own Content-Type.
  res.setHeader(
    'Content-Type',
    audioResp.headers.get('content-type') || 'audio/mpeg',
  );
  res.setHeader('X-OnDemand-Audio-Url', audioUrl);
  res.setHeader('Cache-Control', 'no-store');
  await pipeBinaryBody(audioResp.body, res);
}
