// Map sources on a Navara view. Sources are maps/registry.js entries
// ({ descriptor, credit } for imagery, { id } for terrain) or plain
// descriptions ({ kind, accessToken?, googleApiKey? }); this module builds
// Navara sources and layers from them. The URLs and credits repeat those of
// src/maps/imagery.js and src/maps/terrain.js, which import Cesium.
//
// - imagery: OSM and Esri as `raster-tile` layers; Cesium ion imagery (Bing)
//   has no Navara path yet and rejects.
// - terrain: the keyless Re:Earth quantized mesh, Cesium World Terrain through
//   the ion endpoint with an explicit token (Navara sends it as a Bearer
//   token), or none (the ellipsoid). Navara 0.2.1 panics on a quantized-mesh
//   URL without the {z}/{x}/{y}.terrain template (S2), so URLs always carry it.
// - photoreal: Google 3D tiles with a browser key only in this phase (the
//   server proxy of S3 comes later), with Google's logo and the tiles' own
//   copyright lines (creditLayerId) on screen. Showing them hides the base
//   imagery, as MapSourceController removes it; clearing them does not bring
//   it back until setBaseImagery. Hidden, not deleted: deleting the last
//   raster layer stops Navara 0.2.1 loading terrain at the current view.

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_CREDIT = {
  attribution: '© OpenStreetMap contributors',
  attributionUrl: 'https://www.openstreetmap.org/copyright',
};
const ESRI_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_CREDIT = {
  attributionHtml:
    '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>',
};
const KEYLESS_TERRAIN_URL =
  'https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain';
const KEYLESS_TERRAIN_MAX_ZOOM = 14;
const ION_WORLD_TERRAIN_ENDPOINT =
  'https://api.cesium.com/v1/assets/1/endpoint?access_token=';
const GOOGLE_TILES_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
// The mark Cesium shows for Google tiles (GoogleMaps.getDefaultCredit).
const GOOGLE_LOGO = 'https://assets.ion.cesium.com/google-credit.png';
// Cesium3DTileset's default maximumScreenSpaceError, as the S1–S5 benches use.
const PHOTOREAL_MAX_SSE = 16;

const kindOf = (source) => (source?.descriptor ?? source)?.kind;

function imageryFor(source) {
  const kind = kindOf(source);
  const credit =
    source?.credit != null ? { attributionHtml: String(source.credit) } : null;
  switch (kind) {
    case 'osm':
      return { url: OSM_URL, credit: credit ?? OSM_CREDIT };
    case 'esri-imagery':
      return { url: ESRI_URL, credit: credit ?? ESRI_CREDIT };
    case 'ion':
      throw new Error('Cesium ion imagery is not available on Navara yet');
    default:
      throw new TypeError(`Unknown imagery source: ${kind}`);
  }
}

// After a map change Navara 0.2.1 can report idle and stop drawing before a
// raster tile it fetched arrives (measured at the whole-globe view: the
// stack switch drew a stale picture until something else asked for a
// frame). For a while after each change the engine asks for frames itself.
const SETTLE_MS = 6000;
const SETTLE_EVERY_MS = 250;

/**
 * @param {object} view A Navara ThreeView (addSource, addLayer, attribution, forceUpdate).
 * @param {{ fetch?: typeof fetch, setInterval?: Function,
 *   clearInterval?: Function, now?: () => number }} [options] timers: test seams.
 * @returns {{ maps: object, destroy: () => void }}
 */
export function createNavaraMaps(
  view,
  {
    fetch: fetchJson = globalThis.fetch,
    setInterval: every = globalThis.setInterval,
    clearInterval: stopEvery = globalThis.clearInterval,
    now = () => performance.now(),
  } = {},
) {
  let settleTimer = null;
  let settleUntil = 0;
  const stopSettling = () => {
    if (settleTimer !== null) stopEvery(settleTimer);
    settleTimer = null;
  };
  // A frame now, and frames for SETTLE_MS while tiles arrive.
  const changed = () => {
    view.forceUpdate();
    settleUntil = now() + SETTLE_MS;
    if (settleTimer !== null || destroyed) return;
    settleTimer = every(() => {
      if (destroyed || now() >= settleUntil) {
        stopSettling();
        return;
      }
      view.forceUpdate();
    }, SETTLE_EVERY_MS);
  };
  const slots = { imagery: null, terrain: null, photoreal: null };
  // Base imagery and photoreal tiles share one switch order (display): the
  // call made last decides what shows.
  const generations = { display: 0, terrain: 0 };
  let destroyed = false;

  function retire(slot) {
    if (!slot) return;
    slot.layer.delete();
    slot.source.delete();
    if (slot.credits.length && !slot.hidden)
      view.attribution?.remove(slot.credits);
  }

  function clear(name) {
    const slot = slots[name];
    slots[name] = null;
    retire(slot);
  }

  // The new layer goes in before the old one goes: deleting the last raster
  // layer stops Navara 0.2.1 loading terrain at the current view.
  function show(name, key, sourceDesc, layerDesc, credits = []) {
    const previous = slots[name];
    const source = view.addSource(sourceDesc);
    const layer = view.addLayer({ ...layerDesc, source });
    const shown = credits.map((credit) =>
      typeof credit === 'function' ? credit(layer) : credit,
    );
    retire(previous);
    if (shown.length) view.attribution?.add(shown);
    slots[name] = {
      key,
      source,
      layer,
      layerDesc,
      credits: shown,
      hidden: false,
    };
    changed();
  }

  // Base imagery under photoreal is hidden rather than deleted (see show).
  function setImageryShown(shown) {
    const slot = slots.imagery;
    if (!slot || slot.hidden === !shown) return;
    slot.hidden = !shown;
    slot.layer.update({
      ...slot.layerDesc,
      source: slot.source,
      raster: { show: shown },
    });
    if (slot.credits.length)
      view.attribution?.[shown ? 'add' : 'remove'](slot.credits);
    changed();
  }

  async function terrainFor(source) {
    const kind = source?.kind ?? source?.id;
    switch (kind) {
      case 'ellipsoid':
        return null;
      case 'keyless':
        return {
          type: 'quantized-mesh',
          url: KEYLESS_TERRAIN_URL,
          maxZoom: KEYLESS_TERRAIN_MAX_ZOOM,
        };
      case 'world': {
        const token = String(source.accessToken || '').trim();
        if (!token)
          throw new Error('World terrain requires an explicit ion token');
        const response = await fetchJson(
          `${ION_WORLD_TERRAIN_ENDPOINT}${encodeURIComponent(token)}`,
        );
        if (!response.ok)
          throw new Error(`Cesium ion answered ${response.status}`);
        const endpoint = await response.json();
        return {
          type: 'quantized-mesh',
          url: `${endpoint.url}{z}/{x}/{y}.terrain?v=1.2.0`,
          token: endpoint.accessToken,
        };
      }
      default:
        throw new TypeError(`Unknown terrain source: ${kind}`);
    }
  }

  // What current() reports: the base imagery on the globe (none while tiles
  // replace it) and the tiles shown, as the objects passed in.
  let baseSource = null;
  let currentBase = null;
  let tilesSource = null;
  const knownTiles = new Set();

  const maps = {
    async setBaseImagery(source) {
      const generation = ++generations.display;
      const { url, credit } = imageryFor(source);
      if (destroyed || generation !== generations.display) return;
      baseSource = source;
      currentBase = source;
      if (slots.imagery?.key !== url)
        show('imagery', url, { type: 'raster-tile', url }, { type: 'raster' }, [
          credit,
        ]);
      // Under tiles the base imagery waits hidden, credit included.
      setImageryShown(slots.photoreal == null);
    },
    async setTerrain(source) {
      const generation = ++generations.terrain;
      const description = await terrainFor(source);
      if (destroyed || generation !== generations.terrain) return;
      if (!description) {
        clear('terrain');
        changed();
        return;
      }
      if (slots.terrain?.key === description.url) return;
      show('terrain', description.url, description, { type: 'terrain' });
    },
    async setPhotorealTiles(source) {
      const generation = ++generations.display;
      if (source == null) {
        clear('photoreal');
        tilesSource = null;
        // The globe comes back with the last base imagery and its credit.
        if (slots.imagery) {
          setImageryShown(true);
          currentBase = baseSource;
        }
        changed();
        return;
      }
      const key = String(source.googleApiKey || '').trim();
      if (!key)
        throw new Error(
          'Google 3D tiles on Navara need a browser key (googleApiKey)',
        );
      if (destroyed || generation !== generations.display) return;
      const url = `${GOOGLE_TILES_ROOT}?key=${encodeURIComponent(key)}`;
      setImageryShown(false);
      currentBase = null;
      tilesSource = source;
      knownTiles.add(source);
      if (slots.photoreal?.key === url) return;
      show(
        'photoreal',
        url,
        { type: '3d-tiles', url },
        { type: '3d-tiles', model: { maxSse: PHOTOREAL_MAX_SSE } },
        [
          (layer) => ({
            attribution: 'Google',
            logo: GOOGLE_LOGO,
            creditLayerId: layer.id,
          }),
        ],
      );
      // Google's terms want its copyright lines on screen, as Cesium shows
      // them; Navara lists them in its attribution card, collapsed by default.
      view.attribution?.show();
    },
    releasePhotorealTiles(source) {
      if (!knownTiles.delete(source)) return;
      if (tilesSource !== source) return;
      tilesSource = null;
      clear('photoreal');
      changed();
    },
    photorealActive: () => slots.photoreal != null,
    current: () => ({ baseImagery: currentBase, photoreal: tilesSource }),
  };

  return {
    maps,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopSettling();
      for (const name of Object.keys(slots)) clear(name);
    },
  };
}
