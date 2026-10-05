import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';

const REGIONAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * One bounded upstream read for the regional providers.
 *
 * The deadline covers the BODY, not just the headers. `return`ing the reader's
 * promise from inside a try/finally leaves the try block the moment the promise
 * exists, so the abort timer used to be cleared before a single byte of body had
 * arrived — an upstream that answered its headers and then stalled had no
 * deadline at all. Awaiting inside the try keeps the timer alive until the body
 * is in hand, and the same signal is handed to the reader so an abort stops the
 * read rather than just the connect.
 *
 * `redirect` is stated rather than inherited: feeds that legitimately redirect
 * (news RSS) follow, and a fixed API endpoint can be given 'error' so a
 * redirect cannot steer the proxy at a destination this code never named.
 *
 * @param {string} url
 * @param {{headers?: object, timeoutMs?: number, maxBytes?: number, redirect?: 'follow'|'error'|'manual'}} [options]
 */
async function fetchRegional(url, read, options = {}) {
  const {
    headers = {},
    timeoutMs = 9000,
    maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
    redirect = 'follow',
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect,
    });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return await read(response, maxBytes, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function fetchRegionalJson(url, options = {}) {
  return fetchRegional(url, readResponseJsonCapped, options);
}

function fetchRegionalText(url, options = {}) {
  return fetchRegional(url, readResponseTextCapped, options);
}

export { fetchRegionalJson, fetchRegionalText };
