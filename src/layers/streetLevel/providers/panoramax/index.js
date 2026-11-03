import {
  createLineCoverage,
  freshCoverage,
  sequenceIdFromPick,
} from '../../lineCoverage.js';
import { createSequenceCones, thinImages } from '../../sequenceCones.js';
import { passesImageryFilter } from '../../filter.js';
import { lonToTileX, latToTileY, tileBounds } from '../../tileMath.js';
import { metresBetween } from '../../view.js';
import { createLru, createTileCache } from '../../tileCache.js';
import { decodeCoverageTileSliced, decodePictures } from './decode.js';
import { createPanoramaxSource } from './source.js';
import { createPanoramaxViewer } from './viewer.js';
import { msg } from '../../../../i18n/index.js';
import {
  COLORS,
  COVERAGE_LINES_BELOW_M,
  COVERAGE_TUNING,
  COVERAGE_Z11_BELOW_M,
  COVERAGE_Z12_BELOW_M,
  COVERAGE_Z13_BELOW_M,
  COVERAGE_Z14_BELOW_M,
  GONE_MESSAGE,
  LINE_CLICK_HINT,
  LINE_CLICK_RADIUS_MAX_M,
  LINE_CLICK_RADIUS_PER_HEIGHT,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  FILTERED_HINT,
  NO_COVERAGE_HINT,
  PANORAMAX_CREDIT_HTML,
  PANORAMAX_LABEL,
  PANORAMAX_NAME,
  PANORAMAX_PROVIDER_ID,
  PICK_PREFIX,
  PICTURE_TILE_EDGE_M,
  PICTURE_TILE_ZOOM,
  RATE_LIMITED_MESSAGE,
  UNREADABLE_TILE_MESSAGE,
  ZOOM_IN_HINT,
  normalizeItem,
} from './policy.js';

/**
 * A tile's bytes decoded by `decode`; a body that is not a vector tile
 * (an HTML error page, a cut-off answer) reads as such, not as a parser's
 * "Unimplemented type: 4".
 */
async function readable(decode) {
  try {
    return await decode();
  } catch (error) {
    if (error?.name === 'AbortError' || error?.status !== undefined)
      throw error;
    throw new Error(UNREADABLE_TILE_MESSAGE);
  }
}

/** Pictures kept in memory by id (lookups and ‹ › fill it). */
const PHOTO_CACHE_SIZE = 2000;
/** Sequences whose cone centre is remembered. */
const ANCHOR_CACHE_SIZE = 50;
/** Decoded coverage tiles kept (a simplified dense z10 tile is ~4 MB). */
const COVERAGE_TILE_CACHE_SIZE = 16;
/** One sequence's pictures in a z15 tile, kept for re-centring. */
const PICTURE_LIST_CACHE_SIZE = 32;

/**
 * Sequence lines at z10–14 below 60 km; above, nothing is drawn (the hint
 * says to zoom in).
 */
export function panoramaxZoomFor(heightM) {
  if (!Number.isFinite(heightM) || heightM > COVERAGE_LINES_BELOW_M)
    return null;
  return heightM <= COVERAGE_Z14_BELOW_M
    ? 14
    : heightM <= COVERAGE_Z13_BELOW_M
      ? 13
      : heightM <= COVERAGE_Z12_BELOW_M
        ? 12
        : heightM <= COVERAGE_Z11_BELOW_M
          ? 11
          : 10;
}

/**
 * The imagery filter for lines. A line is dated by its sequence's first
 * day, so a sequence still growing may hide under "since" while its newer
 * pictures can be opened; a line with no camera type or no day is kept (a
 * click finds out).
 */
export function passesCoverage(record, filter) {
  if (!filter) return true;
  return passesImageryFilter(record, {
    pano: typeof record.isPano === 'boolean' ? filter.pano : 'all',
    sinceMs: record.capturedAt ? filter.sinceMs : null,
  });
}

/** The z15 tile holding a point. */
function pictureTileOf({ lon, lat }) {
  const z = PICTURE_TILE_ZOOM;
  return { x: lonToTileX(lon, z), y: latToTileY(lat, z), z };
}

/**
 * The z15 tiles whose pictures surround a point: its own first, and the
 * neighbours it sits within PICTURE_TILE_EDGE_M of (at most nine).
 */
export function pictureTilesAround(point) {
  const home = pictureTileOf(point);
  const box = tileBounds(home.x, home.y, home.z);
  const near = (lon, lat) =>
    metresBetween(point, { lon, lat }) <= PICTURE_TILE_EDGE_M;
  // Near both edges at once where tiles are narrow (high latitudes).
  const dxs = [0];
  if (near(box.west, point.lat)) dxs.push(-1);
  if (near(box.east, point.lat)) dxs.push(1);
  const dys = [0];
  if (near(point.lon, box.north)) dys.push(-1);
  if (near(point.lon, box.south)) dys.push(1);
  const max = 2 ** home.z;
  const tiles = [];
  for (const dy of dys)
    for (const dx of dxs) {
      const y = home.y + dy;
      if (y < 0 || y >= max) continue;
      tiles.push({ x: (home.x + dx + max) % max, y, z: home.z });
    }
  return tiles;
}

const tileKey = ({ x, y, z }) => `${z}/${x}/${y}`;

/**
 * Panoramax Street Level provider: the federated, keyless, open
 * street-level commons. Coverage from its vector tiles (sequence lines
 * near the ground, nothing from orbit); a click on a line opens that
 * sequence's picture nearest the click, with cones along the sequence
 * around it and ‹ › to step through it. Flat pictures show as photos, 360°
 * ones on the shared WebGL panorama.
 * @param {{source?: ReturnType<typeof createPanoramaxSource>, viewerOptions?: object}} [options]
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createPanoramaxProvider({
  source = createPanoramaxSource(),
  viewerOptions = {},
} = {}) {
  return Object.freeze({
    id: PANORAMAX_PROVIDER_ID,
    name: PANORAMAX_NAME,
    label: PANORAMAX_LABEL,
    requiresKeyId: null,
    pickPrefix: PICK_PREFIX.root,
    colors: COLORS,
    credit: Object.freeze({ html: PANORAMAX_CREDIT_HTML }),
    defaultOn: false,
    coverageLabel: Object.freeze({
      noun: 'sequences',
      action: LINE_CLICK_HINT,
    }),

    create(context) {
      const state = {
        context,
        services: context.services,
        viewer: null,
        coverage: freshCoverage({ keyless: true }),
        sequence: {
          selectedId: null,
          images: [],
          collection: null,
          loading: false,
          error: null,
          abort: null,
        },
      };
      const photos = createLru(PHOTO_CACHE_SIZE);
      /** Where each sequence's cones centre: the picture last opened in it, or a click. */
      const anchors = createLru(ANCHOR_CACHE_SIZE);
      /** The z15 tiles the cones were drawn from. */
      let drawn = null;
      /** A line click: its sequence's pictures win the next nearest lookup there. */
      let preferred = null;

      function remember(item) {
        const photo = normalizeItem(item);
        if (photo) photos.set(photo.id, photo);
        return photo;
      }

      /**
       * Lookups in flight, shared: ‹ › and the viewer ask for the same
       * picture. A lookup stops once every caller waiting on it has given up
       * (its search would hold one of the two API connections for nothing).
       */
      const inflight = new Map();
      function getPhoto(photoId, { signal } = {}) {
        const id = String(photoId);
        const cached = photos.get(id);
        if (cached) return Promise.resolve(cached);
        if (signal?.aborted) return Promise.reject(signal.reason);
        let lookup = inflight.get(id);
        if (!lookup) {
          const controller = new AbortController();
          lookup = { controller, waiting: 0 };
          lookup.promise = source
            .getItem(id, { signal: controller.signal })
            .catch((error) => {
              // Ids are UUIDs: the API answers 400 to anything else.
              if (error?.status === 400) return null;
              throw error;
            })
            .then((item) => {
              const photo = item && remember(item);
              if (!photo) throw new Error(GONE_MESSAGE);
              return photo;
            })
            .finally(() => {
              if (inflight.get(id) === lookup) inflight.delete(id);
            });
          lookup.promise.catch(() => {});
          inflight.set(id, lookup);
        }
        const shared = lookup;
        shared.waiting++;
        if (!signal) shared.waiting = Infinity;
        return new Promise((resolve, reject) => {
          const leave = () => {
            reject(signal.reason);
            shared.waiting--;
            // A caller in the same tick (the same photo opened again) may
            // still join: stop only if nobody has.
            queueMicrotask(() => {
              if (shared.waiting > 0) return;
              shared.controller.abort(signal.reason);
              if (inflight.get(id) === shared) inflight.delete(id);
            });
          };
          signal?.addEventListener('abort', leave, { once: true });
          shared.promise.then(
            (photo) => {
              signal?.removeEventListener('abort', leave);
              resolve(photo);
            },
            (error) => {
              signal?.removeEventListener('abort', leave);
              reject(error);
            },
          );
        });
      }

      /**
       * How far from a line click its sequence's pictures are looked for:
       * from high up the click may land tens of metres off the line.
       */
      function lineClickRadius() {
        const height = state.viewer?.camera?.positionCartographic?.height;
        if (!Number.isFinite(height)) return NEAREST_RADIUS_M;
        return Math.min(
          LINE_CLICK_RADIUS_MAX_M,
          Math.max(NEAREST_RADIUS_M, height * LINE_CLICK_RADIUS_PER_HEIGHT),
        );
      }

      /** The picture `delta` along its sequence, from its own links (null at an end). */
      async function step(photo, delta) {
        if (!photo?.sequenceId) return null;
        return (delta < 0 ? photo.prevId : photo.nextId) || null;
      }

      // Decoded tiles, kept a while: panning back, or across a zoom band and
      // back, neither fetches nor decodes them again.
      const coverageTiles = createTileCache({
        size: COVERAGE_TILE_CACHE_SIZE,
        load: (tile, { signal }) =>
          readable(async () =>
            decodeCoverageTileSliced(
              await source.getTile(tile, { signal }),
              tile,
              { signal },
            ),
          ),
      });
      /** A z15 tile's pictures of one sequence, by `z/x/y:sequence`. */
      const pictureLists = createLru(PICTURE_LIST_CACHE_SIZE);
      /**
       * Only finished lists are kept: a load in flight belongs to its own
       * selection, whose abort (a re-centre) must not empty the next one's.
       */
      async function picturesIn(tile, sequenceId, signal) {
        const key = `${tileKey(tile)}:${sequenceId}`;
        const kept = pictureLists.get(key);
        if (kept) return kept;
        const list = await readable(async () =>
          decodePictures(
            await source.getTile(tile, { signal, lane: 'pictures' }),
            tile,
            sequenceId,
          ),
        );
        pictureLists.set(key, list);
        return list;
      }

      const coverage = createLineCoverage({
        state,
        fetchTile: (tile, options) => coverageTiles.get(tile, options),
        zoomFor: panoramaxZoomFor,
        colors: COLORS,
        pickPrefix: PICK_PREFIX.sequence,
        renderKey: 'panoramax-coverage',
        tuning: COVERAGE_TUNING,
        messages: { rateLimited: RATE_LIMITED_MESSAGE, tooHigh: ZOOM_IN_HINT },
        passes: passesCoverage,
      });

      const cones = createSequenceCones({
        state,
        async loadImages(sequenceId, { signal }) {
          const anchor = anchors.get(sequenceId);
          if (!anchor) return [];
          const tiles = pictureTilesAround(anchor);
          // Known from the start: a picture opening while these load is
          // judged against them (re-centred if outside, left alone inside).
          const covering = { sequenceId, tiles: new Set(tiles.map(tileKey)) };
          drawn = covering;
          const conesOf = (lists) =>
            thinImages(
              [
                ...new Map(
                  lists.flat().map((image) => [image.id, image]),
                ).values(),
              ].sort((a, b) => a.capturedAt - b.capturedAt),
            );
          const keyOf = (tile) => `${tileKey(tile)}:${sequenceId}`;
          // The home tile is needed now (it holds the open picture).
          const home = await picturesIn(tiles[0], sequenceId, signal);
          signal?.throwIfAborted();
          // Neighbours already read draw with it; the rest (each up to
          // 1.4 MB in central Paris) join the cones as they arrive.
          const neighbours = tiles.slice(1);
          const kept = neighbours
            .map((tile) => pictureLists.get(keyOf(tile)))
            .filter(Boolean);
          const missing = neighbours.filter(
            (tile) => !pictureLists.get(keyOf(tile)),
          );
          if (missing.length)
            Promise.allSettled(
              missing.map((tile) => picturesIn(tile, sequenceId, signal)),
            ).then((lists) => {
              if (signal?.aborted || drawn !== covering) return;
              dropFailed(covering, missing, lists);
              // Only a tile that arrived now redraws (no loop on failures).
              if (lists.some((list) => list.status === 'fulfilled'))
                cones.select(sequenceId, { force: true });
            });
          return conesOf([home, ...kept]);
        },
        colors: COLORS,
        pickPrefix: PICK_PREFIX.image,
        spriteId: 'street-level:panoramax-cones',
        renderKey: 'panoramax-sequence',
        onHighlight: (sequenceId) => coverage.highlight(sequenceId),
      });

      /**
       * A tile that failed is not covered: a picture opening in it later
       * re-centres the cones there (and asks for the tile again).
       */
      function dropFailed(covering, tiles, lists) {
        lists.forEach((list, i) => {
          if (list.status === 'rejected')
            covering.tiles.delete(tileKey(tiles[i]));
        });
      }

      /**
       * The cones show the z15 tiles around one picture: once a picture of
       * the selected sequence opens outside them (‹ ›, a cone), re-centre.
       */
      function recentreCones(photo) {
        if (!photo?.sequenceId) return;
        if (state.sequence.selectedId !== photo.sequenceId) return;
        if (drawn?.sequenceId !== photo.sequenceId) return;
        if (drawn.tiles.has(tileKey(pictureTileOf(photo)))) return;
        cones.select(photo.sequenceId, { force: true });
      }

      const viewer = createPanoramaxViewer({
        getPhoto,
        // The cones centre on the picture actually shown, never on a
        // lookup that came back after the user moved on.
        onShowing: (photo) => {
          if (photo.sequenceId) anchors.set(photo.sequenceId, photo);
        },
        // After a GPU reset the same picture is drawn again by the viewer
        // itself: through the core it would cancel a lookup the user
        // started. A failure still shows.
        onReopen: (photoId) =>
          viewer
            .open(photoId)
            .catch((error) =>
              context.actions.reportError(
                error?.message ||
                  msg('The Panoramax photo could not be loaded'),
              ),
            ),
        step,
        onStep: (photoId) =>
          context.actions.openImage(photoId, { frame: false }),
        onShown: recentreCones,
        // Esc in the viewer clears the selected sequence, as the panel says.
        onEscape: () => {
          if (!state.sequence.selectedId) return false;
          cones.clearSelection();
          drawn = null;
          return true;
        },
        render: context.services?.render,
        ...viewerOptions,
      });

      /** Nearest of `items` within `radius` metres of a point, or null. */
      function nearestOf(items, point, radius = NEAREST_RADIUS_M) {
        let best = null;
        for (const item of items) {
          const photo = remember(item);
          if (!photo) continue;
          const metres = metresBetween(point, photo);
          if (metres > radius) continue;
          if (!best || metres < best.metres) best = { photo, metres };
        }
        return best?.photo ?? null;
      }

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
          coverage.unblock();
          cones.clearSelection();
          cones.setVisible(false);
          drawn = null;
          preferred = null;
          // Off: decoded tiles and lists go (several MB each over a city).
          coverageTiles.clear();
          pictureLists.clear();
        },

        destroy(cesiumViewer) {
          coverage.detach();
          coverage.clear();
          coverage.unblock();
          cones.destroy(cesiumViewer);
        },

        /** The filter changed: redraw. Each draw reads it from the context. */
        setFilter() {
          coverage.rebuild();
          cones.rerender();
        },

        coverageStats() {
          const stats = coverage.stats();
          let fallback = '';
          // Lines drawn for the camera (a zoom), all settled, none shown.
          const settled =
            state.coverage.zoom != null && !stats.loading && !stats.error;
          if (settled && stats.count === 0) {
            // Tiles that held lines the filter hid all of.
            const filteredOut = [...state.coverage.tiles.values()].some(
              (tile) => tile.total > 0,
            );
            fallback = filteredOut ? FILTERED_HINT : NO_COVERAGE_HINT;
          }
          return { ...stats, hint: stats.hint || fallback };
        },

        /**
         * A line opens its sequence's picture nearest the click (the cones
         * follow once it is on screen); a cone opens its picture.
         */
        handlePick(pickId, { groundPoint } = {}) {
          if (pickId.startsWith(PICK_PREFIX.image)) {
            context.actions.openImage(pickId.slice(PICK_PREFIX.image.length));
            return true;
          }
          const sequenceId = sequenceIdFromPick(pickId, PICK_PREFIX.sequence);
          if (!sequenceId) return false;
          const point = groundPoint?.();
          // No ground under the click (the sky beyond a line): nothing to open.
          if (!point) return true;
          anchors.set(sequenceId, { ...point, sequenceId });
          preferred = {
            sequenceId,
            lon: point.lon,
            lat: point.lat,
            radius: lineClickRadius(),
          };
          context.actions.openNearest(point);
          return true;
        },

        selectSequence: (sequenceId) =>
          cones.select(sequenceId, { force: true }),
        clearSequence: () => {
          cones.clearSelection();
          drawn = null;
        },
        sequenceStats: () => ({
          selectedId: state.sequence.selectedId,
          images: state.sequence.images.length,
          loading: state.sequence.loading,
          error: state.sequence.error,
        }),

        /**
         * The nearest picture within the search radius that passes the
         * imagery filter, or null. After a click on a line, that line's
         * sequence is asked first.
         */
        async nearestImage({ lat, lon }, { signal } = {}) {
          const point = { lat, lon };
          const filter = context.getFilter();
          // Only the lookup the click itself asked for (the same point).
          const wanted =
            preferred && metresBetween(preferred, point) < 1 ? preferred : null;
          preferred = null;
          const ask = (collections, radius = NEAREST_RADIUS_M) =>
            source.nearestItems(
              {
                lat,
                lon,
                radius,
                limit: NEAREST_LIMIT,
                collections,
                pano: filter.pano,
                sinceMs: filter.sinceMs,
              },
              { signal },
            );
          if (wanted) {
            const hit = nearestOf(
              await ask(wanted.sequenceId, wanted.radius),
              point,
              wanted.radius,
            );
            if (hit) return hit.id;
          }
          return nearestOf(await ask(null), point)?.id ?? null;
        },

        viewer,
      };
    },
  });
}
