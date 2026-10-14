import { createLineCoverage } from '../../lineCoverage.js';
import { createSequenceCones, thinImages } from '../../sequenceCones.js';
import { tileBounds } from '../../tileMath.js';
import { metresBetween } from '../../view.js';
import { createVegbilderSource } from './source.js';
import { createVegbilderViewer } from './viewer.js';
import {
  COLORS,
  COVERAGE_MAX_HEIGHT_M,
  COVERAGE_NOUN,
  COVERAGE_TUNING,
  COVERAGE_ZOOM,
  IMAGE_RECORD_TTL_MS,
  LINE_CLICK_HINT,
  MISSING_FILE_MESSAGE,
  NEAREST_PROBES,
  NEAREST_RADIUS_M,
  NO_COVERAGE_HINT,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
  TOO_HIGH_HINT,
  VEGBILDER_CREDIT_HTML,
  VEGBILDER_LABEL,
  VEGBILDER_NAME,
  VEGBILDER_PROVIDER_ID,
  coverageLayers,
  driveFilter,
  firstShownUrl,
  linesFromImages,
  normalizeImage,
  passOf,
  passesVegbilderFilter,
  searchLayers,
} from './policy.js';

/** Photos kept in memory by id. */
const IMAGE_CACHE_SIZE = 4000;
/** Decoded coverage tiles (per feature type) kept, and for how long. */
const TILE_CACHE_SIZE = 60;
const TILE_CACHE_TTL_MS = 10 * 60_000;
/** Drive windows kept. */
const DRIVE_CACHE_SIZE = 16;
/** A drive is fetched around 200 m buckets of road, ± DRIVE_WINDOW_M. */
const DRIVE_BUCKET_M = 200;
/** Feature types searched at once for the nearest photo. */
const SEARCH_BATCH = 4;

/** Mainland Norway and its coast, padded: Vegbilder has nothing elsewhere. */
export const NORWAY_BOUNDS = Object.freeze({
  west: 4.0,
  south: 57.8,
  east: 31.5,
  north: 71.3,
});

function overlapsNorway({ west, south, east, north }) {
  return (
    east >= NORWAY_BOUNDS.west &&
    west <= NORWAY_BOUNDS.east &&
    north >= NORWAY_BOUNDS.south &&
    south <= NORWAY_BOUNDS.north
  );
}

/**
 * Whether a photo's file is there: some listed photos (many of Oslo's 360°
 * ones) answer 404, and the store takes no HEAD or range request, so the
 * address the viewer shows first is loaded (the viewer then has it cached).
 */
export function loadsInBrowser(image) {
  const url = firstShownUrl(image);
  if (!url) return Promise.resolve(false);
  if (typeof globalThis.Image !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    const probe = new globalThis.Image();
    probe.onload = () => resolve(true);
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
}

/** z15 near the street, nothing above. */
export function vegbilderZoomFor(heightM) {
  if (!Number.isFinite(heightM) || heightM > COVERAGE_MAX_HEIGHT_M) return null;
  return { zoom: COVERAGE_ZOOM, kind: 'sequence' };
}

/** Least-recently-used map: reading an entry renews it. */
function createLru(limit) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

/** A box `radiusM` around a point, in degrees. */
function boxAround({ lat, lon }, radiusM) {
  const dLat = radiusM / 110_540;
  const dLon =
    radiusM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    west: lon - dLon,
    south: lat - dLat,
    east: lon + dLon,
    north: lat + dLat,
  };
}

/**
 * Vegbilder Street Level provider: Statens vegvesen's road photos of
 * Norway, keyless. Coverage lines are drawn from the photo points near the
 * street, a click opens the nearest photo, cones and ‹ › follow its drive.
 * @param {{source?: ReturnType<typeof createVegbilderSource>, viewerOptions?: object, now?: () => number, probeImage?: typeof loadsInBrowser}} [options]
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createVegbilderProvider({
  source = createVegbilderSource(),
  viewerOptions = {},
  now = Date.now,
  probeImage = loadsInBrowser,
} = {}) {
  return Object.freeze({
    id: VEGBILDER_PROVIDER_ID,
    name: VEGBILDER_NAME,
    label: VEGBILDER_LABEL,
    requiresKeyId: null,
    pickPrefix: PICK_PREFIX.root,
    colors: COLORS,
    marker: Object.freeze({ kind: 'view-cone', color: COLORS.coverage }),
    credit: Object.freeze({ html: VEGBILDER_CREDIT_HTML }),
    defaultOn: false,
    filters: Object.freeze(['pano', 'since']),
    // Lines are passes cut per tile: a selected drive shows as cones.
    highlightsSequence: false,
    coverageLabel: Object.freeze({
      noun: COVERAGE_NOUN,
      action: LINE_CLICK_HINT,
    }),

    create(context) {
      const state = {
        context,
        services: context.services,
        viewer: null,
        keyRequired: false,
        keyRejected: false,
        statusKnown: true,
        coverage: {
          zoom: null,
          tiles: new Map(),
          stale: new Map(),
          staleTimer: null,
          pending: new Map(),
          lastError: null,
          holdUntil: 0,
          holdTimer: null,
          debounceTimer: null,
          removeCameraListener: null,
          terrainReady: null,
          hint: '',
          kind: null,
        },
        sequence: {
          selectedId: null,
          images: [],
          cache: new Map(),
          collection: null,
          loading: false,
          abort: null,
        },
      };
      const images = createLru(IMAGE_CACHE_SIZE);
      const tiles = createLru(TILE_CACHE_SIZE);
      const drives = createLru(DRIVE_CACHE_SIZE);
      /** The photo last opened in each drive: its cones centre on it. */
      const anchors = new Map();
      /** The drive window the cones were drawn from. */
      let drawnWindow = null;
      /** The pass the cones show, for the panel's count. */
      let drawnCount = 0;

      /** A record as a photo; a known one keeps its signed addresses until they age. */
      function remember(feature) {
        const fresh = normalizeImage(feature);
        if (!fresh) return null;
        const known = images.get(fresh.id);
        if (known && !fresh.urls.full) {
          fresh.urls = known.urls;
          fresh.signedAt = known.signedAt;
        } else if (fresh.urls.full) fresh.signedAt = now();
        images.set(fresh.id, fresh);
        return fresh;
      }

      /** Photo id → whether its file loads; only a load is remembered. */
      const probes = createLru(IMAGE_CACHE_SIZE);
      function showable(image) {
        let probe = probes.get(image.id);
        if (!probe) {
          probe = probeImage(image).then((ok) => {
            if (!ok) probes.delete(image.id);
            return ok;
          });
          probes.set(image.id, probe);
        }
        return probe;
      }

      /** A photo with addresses signed within the last hour. */
      async function getImage(id, { signal } = {}) {
        const cached = images.get(id);
        if (
          cached?.urls.full &&
          now() - (cached.signedAt ?? 0) < IMAGE_RECORD_TTL_MS
        )
          return cached;
        const image = remember(await source.getImage(id, { signal }));
        if (!image) throw new Error('Vegbilder has no such photo');
        return image;
      }

      /** One feature type's lines in a tile, kept a while. */
      async function layerTile(layer, tile, { signal }) {
        const key = `${layer}|${tile.z}/${tile.x}/${tile.y}`;
        const entry = tiles.get(key);
        if (entry && now() - entry.at < TILE_CACHE_TTL_MS) return entry.lines;
        const { west, south, east, north } = tileBounds(tile.x, tile.y, tile.z);
        const features = await source.imagesInBox(
          layer,
          { west, south, east, north },
          { signal },
        );
        const lines = linesFromImages(
          features.map(normalizeImage).filter(Boolean),
        ).sequences;
        tiles.set(key, { at: now(), lines });
        return lines;
      }

      async function fetchTile(tile, options) {
        const bounds = tileBounds(tile.x, tile.y, tile.z);
        if (!overlapsNorway(bounds)) return { sequences: [], overview: [] };
        const layers = coverageLayers(context.getFilter(), now());
        const parts = await Promise.all(
          layers.map((layer) => layerTile(layer, tile, options)),
        );
        return { sequences: parts.flat(), overview: [] };
      }
      let drawnLayers = coverageLayers(context.getFilter(), now()).join();

      /** The pass around `image` (its drive's photos within a few hundred metres). */
      async function passAround(image) {
        const bucket = Math.floor((image.meter ?? 0) / DRIVE_BUCKET_M);
        const key = `${image.driveId}@${bucket}`;
        let entry = drives.get(key);
        if (!entry) {
          const centre = { ...image, meter: (bucket + 0.5) * DRIVE_BUCKET_M };
          entry = source
            .driveImages(image.layer, driveFilter(centre))
            .then((features) => features.map(remember).filter(Boolean));
          drives.set(key, entry);
          entry.catch(() => drives.delete(key));
        }
        return { key, pass: passOf(image, await entry) };
      }

      /** The photo `delta` along the drive from `image`, or null at its end. */
      async function step(image, delta) {
        if (!image?.driveId) return null;
        const { pass } = await passAround(image);
        const at = pass.findIndex((other) => other.id === image.id);
        return pass[at + delta]?.id ?? null;
      }

      const coverage = createLineCoverage({
        state,
        fetchTile,
        zoomFor: vegbilderZoomFor,
        colors: COLORS,
        pickPrefix: PICK_PREFIX.line,
        renderKey: 'vegbilder-coverage',
        tuning: COVERAGE_TUNING,
        messages: { rateLimited: RATE_LIMITED_MESSAGE, tooHigh: TOO_HIGH_HINT },
      });

      const cones = createSequenceCones({
        state,
        async loadImages(driveId, { signal }) {
          let anchor = anchors.get(driveId);
          if (!anchor) return [];
          let around = await passAround(anchor);
          signal?.throwIfAborted();
          while (anchors.get(driveId) !== anchor) {
            anchor = anchors.get(driveId);
            around = await passAround(anchor);
            signal?.throwIfAborted();
          }
          drawnWindow = around.key;
          drawnCount = around.pass.length;
          return thinImages(
            around.pass.map((image) => ({
              id: image.id,
              lon: image.lon,
              lat: image.lat,
              compassAngle: image.heading ?? 0,
              capturedAt: image.capturedAt ?? 0,
              isPano: image.isPano,
            })),
          );
        },
        colors: COLORS,
        pickPrefix: PICK_PREFIX.image,
        spriteId: 'street-level:vegbilder-cones',
        renderKey: 'vegbilder-sequence',
        passes: passesVegbilderFilter,
      });

      /** The cones show a few hundred metres of a drive: follow the open photo. */
      async function recentreCones(image) {
        if (!image?.driveId || state.sequence.selectedId !== image.driveId)
          return;
        const around = await passAround(image).catch(() => null);
        if (
          around &&
          drawnWindow !== null &&
          around.key !== drawnWindow &&
          anchors.get(image.driveId) === image
        )
          cones.select(image.driveId, { force: true });
      }

      const viewer = createVegbilderViewer({
        getImage: async (id) => {
          const image = await getImage(id);
          if (image.driveId) anchors.set(image.driveId, image);
          return image;
        },
        step,
        onStep: (id) => context.actions.openImage(id, { frame: false }),
        onShown: recentreCones,
        render: context.services?.render,
        ...viewerOptions,
      });

      return {
        async status() {
          return { configured: true };
        },

        init(cesiumViewer) {
          state.viewer = cesiumViewer;
          cones.ensureCollections(cesiumViewer);
          cones.setVisible(false);
        },

        activate(cesiumViewer) {
          state.viewer = cesiumViewer;
          cones.setVisible(true);
          coverage.attach(cesiumViewer);
        },

        deactivate() {
          coverage.detach();
          coverage.clear();
          coverage.resetErrors();
          cones.clearSelection();
          cones.setVisible(false);
          drawnWindow = null;
          tiles.clear();
          drives.clear();
        },

        destroy(cesiumViewer) {
          coverage.detach();
          coverage.clear();
          coverage.resetErrors();
          cones.destroy(cesiumViewer);
          tiles.clear();
          drives.clear();
        },

        refreshCoverage: () => coverage.refresh(),

        /** A filter that changes the years or kinds asks Vegvesen again; any other only redraws. */
        setFilter() {
          const layers = coverageLayers(context.getFilter(), now()).join();
          if (layers !== drawnLayers) {
            drawnLayers = layers;
            coverage.reload();
          } else coverage.rebuild();
          cones.rerender();
        },

        setSurface() {
          coverage.setSurface();
          cones.rerender();
        },

        coverageStats() {
          const { hint } = state.coverage;
          const count = coverage.sequenceCount();
          const loading = state.coverage.pending.size > 0;
          const empty =
            state.coverage.zoom !== null &&
            !loading &&
            count === 0 &&
            !state.coverage.lastError;
          return {
            count,
            zoom: state.coverage.zoom,
            kind: state.coverage.kind,
            loading,
            hint: hint || (empty ? NO_COVERAGE_HINT : ''),
            error: state.coverage.lastError,
            keyRequired: false,
            keyRejected: false,
          };
        },

        /** A line opens the photo nearest the click; a cone opens its photo. */
        handlePick(pickId, { groundPoint } = {}) {
          if (pickId.startsWith(PICK_PREFIX.image)) {
            context.actions.openImage(pickId.slice(PICK_PREFIX.image.length));
            return true;
          }
          if (pickId.startsWith(PICK_PREFIX.line)) {
            const point = groundPoint?.();
            if (point) context.actions.openNearest(point);
            return true;
          }
          return false;
        },

        selectSequence: (driveId) => cones.select(driveId, { force: true }),
        clearSequence: () => {
          cones.clearSelection();
          drawnWindow = null;
        },
        sequenceStats: () => ({
          selectedId: state.sequence.selectedId,
          images: drawnCount || state.sequence.images.length,
          loading: state.sequence.loading,
        }),

        /**
         * The nearest photo within the search radius whose file loads: the
         * nearest of each feature type, newest year first (a few types at a
         * time), tried in that order. Null outside Norway or with none.
         */
        async nearestImage({ lat, lon }, { signal } = {}) {
          const point = { lat, lon };
          const box = boxAround(point, NEAREST_RADIUS_M);
          if (!overlapsNorway(box)) return null;
          const filter = context.getFilter();
          const layers = searchLayers(filter, now());
          let tried = 0;
          for (let i = 0; i < layers.length; i += SEARCH_BATCH) {
            const batch = layers.slice(i, i + SEARCH_BATCH);
            const answers = await Promise.all(
              batch.map((layer) =>
                source.imagesInBox(layer, box, { signal, withUrls: true }),
              ),
            );
            signal?.throwIfAborted();
            for (const features of answers) {
              let best = null;
              for (const feature of features) {
                const image = remember(feature);
                if (!image || !passesVegbilderFilter(image, filter)) continue;
                const metres = metresBetween(point, image);
                if (
                  metres <= NEAREST_RADIUS_M &&
                  (!best || metres < best.metres)
                )
                  best = { image, metres };
              }
              if (!best) continue;
              const ok = await showable(best.image);
              signal?.throwIfAborted();
              if (ok) return best.image.id;
              if (++tried >= NEAREST_PROBES)
                throw new Error(MISSING_FILE_MESSAGE);
            }
          }
          if (tried) throw new Error(MISSING_FILE_MESSAGE);
          return null;
        },

        viewer,
      };
    },
  });
}
