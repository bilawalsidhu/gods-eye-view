import { isIP } from 'node:net';

/** Match the local app's authority, without trusting forwarding headers. */
export function isGeminiRequestOriginAllowed(req, configuredHost = '') {
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  if (
    typeof host !== 'string' ||
    typeof origin !== 'string' ||
    !host ||
    /[\s/?#@\\]/.test(host) ||
    req.headers?.['sec-fetch-site'] === 'cross-site'
  )
    return false;
  try {
    const authority = new URL(
      `${req.socket?.encrypted ? 'https:' : 'http:'}//${host}`,
    );
    const hostname = authority.hostname.toLowerCase();
    const boundHost = String(configuredHost || '')
      .trim()
      .toLowerCase();
    const local =
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ||
      hostname.endsWith('.local');
    const wildcard = boundHost === '0.0.0.0' || boundHost === '::';
    const admitted =
      local ||
      (!wildcard && boundHost !== '' && hostname === boundHost) ||
      (wildcard && isIP(hostname.replace(/^\[|\]$/g, '')) !== 0);
    const source = new URL(origin);
    return (
      admitted &&
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
