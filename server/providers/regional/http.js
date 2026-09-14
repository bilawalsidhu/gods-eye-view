import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';

const REGIONAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function fetchRegionalJson(
  url,
  {
    headers = {},
    timeoutMs = 9000,
    maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
  } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return readResponseJsonCapped(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRegionalText(
  url,
  {
    headers = {},
    timeoutMs = 9000,
    maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
  } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return readResponseTextCapped(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

export { fetchRegionalJson, fetchRegionalText };
