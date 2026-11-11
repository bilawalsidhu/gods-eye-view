// Where Esri's World Imagery has nothing at a level, it answers with a grey
// "Map data not yet available" JPEG (200) rather than an error: over open
// ocean from level 14, over deserts from about 18. Cesium discards that
// image (DiscardMissingTileImagePolicy) and keeps the parent level; Navara
// 0.2.1 has no discard policy and draws it. While installed, an Esri tile
// whose bytes are that image answers 404 instead, which Navara treats as a
// failed tile, keeping the parent level. Like Cesium, the reference is
// Esri's tile 0/0 at level 23, which never has imagery.

export const ESRI_TILE_ROOT =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/';
const MISSING_TILE_URL = `${ESRI_TILE_ROOT}23/0/0`;

const installs = new WeakMap();

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Wraps `target.fetch` so Esri's missing-imagery tiles answer 404. Returns
 * the uninstaller; installs on one target share a single wrapper.
 * @param {{ fetch: typeof fetch }} [target]
 * @returns {() => void}
 */
export function discardMissingEsriTiles(target = globalThis) {
  let install = installs.get(target);
  if (!install) {
    const realFetch = target.fetch;
    // window.fetch throws "Illegal invocation" when called without its window.
    const fetchFrom = (input, init) => realFetch.call(target, input, init);
    let reference = null;
    // The missing-imagery bytes, fetched once; null (tiles pass) on failure,
    // tried again on the next tile.
    const missingBytes = () =>
      (reference ??= fetchFrom(MISSING_TILE_URL)
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((buffer) => (buffer ? new Uint8Array(buffer) : null))
        .catch(() => null)
        .then((bytes) => {
          if (!bytes) reference = null;
          return bytes;
        }));
    const wrapped = async (input, init) => {
      const response = await fetchFrom(input, init);
      const url =
        typeof input === 'string' ? input : String(input?.url ?? input);
      if (!response.ok || !url.startsWith(ESRI_TILE_ROOT)) return response;
      const missing = await missingBytes();
      if (
        !missing ||
        response.headers.get('content-length') !== String(missing.byteLength)
      )
        return response;
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      return sameBytes(bytes, missing)
        ? new Response(null, { status: 404, statusText: 'No imagery' })
        : response;
    };
    install = { realFetch, wrapped, users: 0 };
    installs.set(target, install);
    target.fetch = wrapped;
  }
  install.users++;
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    if (--install.users > 0) return;
    installs.delete(target);
    if (target.fetch === install.wrapped) target.fetch = install.realFetch;
  };
}
