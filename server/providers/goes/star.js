import { createHash } from 'node:crypto';
import { GOES_STAR_PRODUCTS, starImageUrl } from './catalog.js';

/** Fetch and validate one STAR CDN frame. */
export async function fetchStarFrame(
  satellite,
  {
    fetchImpl = fetch,
    size = GOES_STAR_PRODUCTS[product]?.endpointSize,
    product = 'GEOCOLOR',
    signal,
  } = {},
) {
  const response = await fetchImpl(starImageUrl(satellite, { size, product }), {
    signal,
  });
  if (!response.ok) throw new Error(`STAR request failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8)
    throw new Error('STAR response is not JPEG');
  const parsedLastModified = response.headers.get('last-modified')
    ? Date.parse(response.headers.get('last-modified'))
    : NaN;
  return {
    buffer,
    contentType: response.headers.get('content-type') || 'image/jpeg',
    lastModifiedMs: Number.isFinite(parsedLastModified)
      ? parsedLastModified
      : null,
    contentHash: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
  };
}
