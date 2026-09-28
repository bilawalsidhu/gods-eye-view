/**
 * Construct the existing live-fire endpoint without making a request.
 *
 * Two providers back the same contract. NASA FIRMS (`/api/firms`) is preferred
 * when a server-side `FIRMS_MAP_KEY` is configured, because it merges the
 * polar-orbiting VIIRS/MODIS sources at ~375 m. Without a key the proxy answers
 * 503 `no_key`, so we fall back to the keyless NOAA GOES ABI fire/hot-spot
 * product (`/api/goes-fires`), which the server reads straight from the public
 * `noaa-goes18`/`noaa-goes19` S3 buckets. Both return the same `fires` row
 * shape, so the layer, cards and rendering path are shared unchanged.
 */

/** Read a JSON body without letting a malformed body mask the status code. */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function createFirmsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  goesApiUrl = '/api/goes-fires',
} = {}) {
  async function request(url, signal) {
    const response = await fetchImpl(url, { signal, cache: 'no-store' });
    return { response, payload: await readJson(response) };
  }

  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();

      const firms = await request('/api/firms', signal);
      signal?.throwIfAborted();
      if (firms.response.ok) {
        if (!Array.isArray(firms.payload?.fires))
          throw new Error('Malformed fire snapshot');
        return { ...firms.payload, provider: 'firms' };
      }

      // Only a missing key is recoverable; any other FIRMS failure is real.
      const missingKey =
        firms.response.status === 503 && firms.payload?.error === 'no_key';
      if (!missingKey) throw new Error(`FIRMS HTTP ${firms.response.status}`);

      const goes = await request(goesApiUrl, signal);
      signal?.throwIfAborted();
      if (goes.response.ok) {
        if (!Array.isArray(goes.payload?.fires))
          throw new Error('Malformed fire snapshot');
        return {
          ...goes.payload,
          provider: 'goes',
          sourceText:
            'NOAA GOES ABI · Americas · newest available ~10-minute scan',
          guidance:
            'Add FIRMS_MAP_KEY in Provider Settings for global detections over the trailing 24 hours.',
        };
      }
      // Neither provider is usable: keep the established "KEY REQUIRED" hint so
      // the panel still tells the operator how to enable the keyed source.
      if (goes.response.status === 503) return { keyRequired: true };
      throw new Error(`GOES fires HTTP ${goes.response.status}`);
    },
  };
}
