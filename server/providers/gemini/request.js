import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';
import {
  isAllowedHost,
  resolveAllowedHosts,
} from '../../../build/allowedHosts.js';

/** Use the app's Host and request policies, with a required browser Origin. */
export function isGeminiRequestOriginAllowed(
  req,
  configuredHost = '',
  configuredAllowedHosts,
) {
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  if (
    typeof host !== 'string' ||
    typeof origin !== 'string' ||
    !host ||
    /[\s/?#@\\]/.test(host)
  )
    return false;
  const protocol = req.socket?.encrypted ? 'https:' : 'http:';
  if (
    !admitSameSiteRequest({
      hostHeader: host,
      protocol,
      origin,
      secFetchSite: req.headers?.['sec-fetch-site'],
      proxyHeaders: req.headers || {},
    }).ok
  )
    return false;
  const boundHost = String(configuredHost || '')
    .trim()
    .toLowerCase();
  if (
    !isAllowedHost(host, resolveAllowedHosts(configuredAllowedHosts), [
      boundHost,
    ])
  )
    return false;
  try {
    const authority = new URL(`${protocol}//${host}`);
    const source = new URL(origin);
    return (
      source.origin === authority.origin &&
      source.username === '' &&
      source.password === '' &&
      source.pathname === '/' &&
      source.search === '' &&
      source.hash === ''
    );
  } catch {
    return false;
  }
}

/** Admit only the existing input gesture; callers cannot supply model/setup. */
export async function readGeminiTokenRequest(req, signal, maxBytes = 1024) {
  const declared = Number(req.headers?.['content-length']);
  const fail = (code) =>
    Object.assign(new Error('Invalid token request'), { code });
  if (Number.isFinite(declared) && declared > maxBytes)
    throw fail('BODY_TOO_LARGE');
  const body = await new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      signal.removeEventListener('abort', abort);
    };
    const error = (reason) => {
      cleanup();
      req.pause();
      reject(reason);
    };
    const abort = () => error(signal.reason);
    const data = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) return error(fail('BODY_TOO_LARGE'));
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
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
