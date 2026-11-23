import {
  ACTIVE_FRAME_REFRESH_MS,
  FRAME_ENDPOINT,
  MEDIA_ENDPOINT,
} from './sourcePolicy.js';
const FRAME_SOURCE_KINDS = new Set([
  'upstream-image',
  'hls-pull',
  'streetview',
  'synthetic',
]);
function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
  const cadenceMs = Math.max(
    1000,
    safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS),
  );
  const tick = Math.floor(Date.now() / cadenceMs);
  const params = new URLSearchParams({
    label: camera.name,
    city: camera.city,
    heading: String(Math.round(camera.headingDeg)),
    fov: String(Math.round(camera.fovDeg)),
    pitch: String(Math.round(camera.pitchDeg || -10)),
    ts: String(tick),
  });
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}
function mediaUrlFor(camera, grant = '') {
  const url = `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
  return grant ? `${url}&grant=${encodeURIComponent(grant)}` : url;
}
/** Supply catalog/health records and the existing registered camera URL families. */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  // The server needs this to open a live HLS session; it arrives with the
  // catalog, which a foreign page can request but not read.
  let hlsGrant = '';
  async function read(path, key, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Camera source HTTP ' + response.status);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.[key]))
      throw new Error('Malformed camera ' + key + ' snapshot');
    return payload;
  }
  return {
    async getCatalog(options) {
      const payload = await read('/api/cctv/sources', 'sources', options);
      if (typeof payload.hlsGrant === 'string') hlsGrant = payload.hlsGrant;
      return payload;
    },
    getHealth(options) {
      return read('/api/cctv/health', 'cameras', options);
    },
    getFrameUrl: frameUrlFor,
    getMediaUrl: (camera) => mediaUrlFor(camera, hlsGrant),
    /** Read a registered frame and its provenance, including fallback frames. */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(frameUrlFor(camera), {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Camera frame HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      const type = response.headers.get('content-type') || '';
      const sourceKind = response.headers.get('x-cctv-source');
      return {
        contentType: type.split(';')[0].trim().toLowerCase(),
        bytes,
        sourceKind: FRAME_SOURCE_KINDS.has(sourceKind) ? sourceKind : null,
      };
    },
  };
}
