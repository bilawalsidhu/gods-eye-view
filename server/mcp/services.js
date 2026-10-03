/**
 * Local composition of tool services: Core's default services, pointed at a
 * running God's Eye View server's `/api` routes.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createToolServices } from '../../src/tools/services.js';

// Bundled data some sources read by module-relative URL.
const BUNDLED_DATA = new URL('../../src/data/local_data/', import.meta.url);

export const DEFAULT_API_BASE = 'http://localhost:4173';

/**
 * Resolve the sources' relative `/api/...` requests against `apiBase`, and
 * serve `file:` URLs inside the bundled data directory from disk, as a
 * browser would load those module-relative assets.
 */
export function createApiFetch({
  apiBase = DEFAULT_API_BASE,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const base = new URL(apiBase);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new TypeError(`apiBase must be an http(s) URL: ${apiBase}`);
  return (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('file:')) return readBundled(url);
    return fetchImpl(
      typeof input === 'string' && input.startsWith('/')
        ? new URL(input, base)
        : input,
      init,
    );
  };
}

async function readBundled(url) {
  const href = new URL(url).href;
  if (!href.startsWith(BUNDLED_DATA.href) || href.includes('/../'))
    return new Response(null, { status: 404 });
  try {
    const body = await readFile(fileURLToPath(href));
    return new Response(body, {
      headers: {
        'Content-Type': href.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream',
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/** Construct every service Core's tools read, backed by the local server. */
export function createLocalToolServices(options = {}) {
  return createToolServices({
    fetchImpl: createApiFetch(options),
    appUrl: options.apiBase ?? DEFAULT_API_BASE,
  });
}
