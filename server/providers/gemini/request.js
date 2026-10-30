import { readRequestBody } from '../common/request.js';
import { admitKeySetupRequest } from '../../../src/keySetupCore.mjs';
import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';

/** Use the app's Host and request policies, with a required browser Origin. */
export function isGeminiRequestOriginAllowed(req) {
  const protocol = req.socket?.encrypted ? 'https:' : 'http:';
  const local = admitKeySetupRequest({
    method: 'POST',
    remoteAddress: req.socket?.remoteAddress,
    hostHeader: req.headers?.host,
    protocol,
    origin: req.headers?.origin,
    contentType: 'application/json',
    proxyHeaders: req.headers || {},
  }).ok;
  return (
    local &&
    admitSameSiteRequest({
      hostHeader: req.headers?.host,
      protocol,
      origin: req.headers?.origin,
      secFetchSite: req.headers?.['sec-fetch-site'],
      proxyHeaders: req.headers || {},
    }).ok
  );
}

/** Admit only the existing input gesture; callers cannot supply model/setup. */
export async function readGeminiTokenRequest(req, signal, maxBytes = 1024) {
  const declared = Number(req.headers?.['content-length']);
  const fail = (code) =>
    Object.assign(new Error('Invalid token request'), { code });
  const body = await readRequestBody(
    req,
    maxBytes,
    Number.isFinite(declared) && declared > maxBytes
      ? AbortSignal.abort(fail('BODY_TOO_LARGE'))
      : signal,
  );
  if (!body.trim()) return 'open-mic';
  if (
    !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')
  )
    throw fail('BAD_CONTENT_TYPE');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw fail('BAD_BODY');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
    throw fail('BAD_BODY');
  const keys = Object.keys(parsed);
  if (!keys.length) return 'open-mic';
  if (
    keys.length === 1 &&
    keys[0] === 'inputMode' &&
    parsed.inputMode === 'push-to-talk'
  )
    return 'push-to-talk';
  throw fail('BAD_BODY');
}
