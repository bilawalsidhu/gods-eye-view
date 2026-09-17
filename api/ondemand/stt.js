/**
 * api/ondemand/stt.js — POST /api/ondemand/stt.
 *
 * Contract reference: docs/ONDEMAND_API_CURRENT.md §6.1 "Audio -> text (STT)".
 * The documented request body has EXACTLY one field, `audioUrl`; there is no
 * upload-bytes variant. A multipart request or a body carrying anything that
 * looks like inline base64 audio is NOT FOUND IN LIVE DOCS, so this handler
 * refuses with 501 rather than guessing a schema.
 */

import { baseUrls, isConfigured } from '../../server/ondemand/config.js';
import { ondemandFetch } from '../../server/ondemand/client.js';
import { shapeUpstreamError, notDocumented } from '../../server/ondemand/errors.js';
import { sendJson, assertMethod, rejectCrossOrigin, readJsonBody, BodyError } from '../../server/ondemand/http.js';

const NOT_DOCUMENTED_UPLOAD = () =>
  notDocumented('stt raw-audio upload', '§6.1', {
    hint: 'upload with /api/ondemand/media first and pass the returned data.url as audioUrl',
  });

export default async function handler(req, res) {
  if (rejectCrossOrigin(req, res)) return;
  if (!assertMethod(req, res, ['POST'])) return;
  if (!isConfigured()) {
    sendJson(res, 503, { error: 'not_configured', message: 'ONDEMAND_API_KEY is not set on the server.' });
    return;
  }

  const contentType = req.headers['content-type'] || '';
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    sendJson(res, 501, NOT_DOCUMENTED_UPLOAD());
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, { maxBytes: 16 * 1024 });
  } catch (err) {
    if (err instanceof BodyError) {
      sendJson(res, err.status, err.payload);
      return;
    }
    throw err;
  }

  if (looksLikeInlineAudio(body)) {
    sendJson(res, 501, NOT_DOCUMENTED_UPLOAD());
    return;
  }
  if (typeof body?.audioUrl !== 'string' || !/^https?:\/\//i.test(body.audioUrl)) {
    sendJson(res, 400, { error: 'audioUrl_required', message: 'audioUrl must be an http(s) URI' });
    return;
  }

  try {
    const upstream = await ondemandFetch(`${baseUrls().services}/execute/speech_to_text`, {
      method: 'POST',
      body: { audioUrl: body.audioUrl }, // §6.1: exactly one field
    });
    if (!upstream.ok) {
      sendJson(res, upstream.status, await shapeUpstreamError(upstream));
      return;
    }
    const json = await upstream.json(); // {message, data:{text}}
    sendJson(res, upstream.status, json);
  } catch {
    sendJson(res, 502, { error: 'proxy_error', message: 'Unexpected error contacting OnDemand.' });
  }
}

function looksLikeInlineAudio(body) {
  return (
    typeof body?.audioBase64 === 'string' || typeof body?.audio === 'string' || typeof body?.base64 === 'string'
  );
}
