import {
  createPhotoViewer,
  loadImage as loadAnyImage,
} from '../../photoViewer.js';
import {
  FLAT_FULL_SIZE,
  FLAT_VIEW_SIZE,
  IMAGE_TIMEOUT_MS,
  KARTAVIEW_NAME,
  KARTAVIEW_PROVIDER_ID,
  PANO_PREVIEW_SIZE,
  cameraBearing,
  kartaViewPhotoUrl,
  resizedImageUrl,
} from './policy.js';

export { panoSizeFor } from '../../photoViewer.js';

const LOAD_FAILED = 'The KartaView photo could not be loaded';

/** Load a KartaView photo (see photoViewer.js `loadImage`). */
export function loadImage(url, options = {}) {
  return loadAnyImage(url, {
    timeoutMs: IMAGE_TIMEOUT_MS,
    failure: LOAD_FAILED,
    ...options,
  });
}

/**
 * Where KartaView photos come from. Only KartaView's image proxy can shrink
 * a 13,000 px panorama, so panoramas and flat upgrades go through it.
 * @type {import('../../photoViewer.js').PhotoSources}
 */
const KARTAVIEW_SOURCES = Object.freeze({
  hasPano: (photo) => Boolean(photo.isPano && photo.urls.pano),
  panoFirst: (photo) => ({
    url: resizedImageUrl(photo.urls.pano, PANO_PREVIEW_SIZE),
    width: 0,
    resize: PANO_PREVIEW_SIZE,
  }),
  panoSharp: (photo, size) => ({
    url: resizedImageUrl(photo.urls.pano, size),
  }),
  // The proxy's 1,280 px version is a few hundred kB; KartaView's own
  // "large thumbnail" can be 1.7 MB. Either serves when the other fails.
  // A 360° photo's front view is only on storage.
  flatFirst: (photo) => [
    photo.isPano ? null : resizedImageUrl(photo.urls.full, FLAT_VIEW_SIZE),
    photo.urls.view,
  ],
  // A docked viewer shows the 1,280 px version in full: the 2,560 px one
  // (~0.6 MB a photo) waits until the viewer is bigger than that.
  flatSharp: (photo, pixels) =>
    pixels > FLAT_VIEW_SIZE[0]
      ? resizedImageUrl(photo.urls.full, FLAT_FULL_SIZE)
      : null,
  // The camera's direction, which the drive's track may refine.
  bearingOf: (photo) => cameraBearing(photo),
  describe: (photo) => ({
    // KartaView's only place name is the sequence's, where the drive began.
    title: null,
    creator: null,
    externalUrl: kartaViewPhotoUrl(photo),
  }),
});

/**
 * Viewer adapter for KartaView photos: a flat photo in an <img>, a 360°
 * photo on a WebGL panorama, and ‹ › along the sequence (photoViewer.js).
 *
 * @param {object} options
 * @param {(photoId: string) => Promise<object>} options.getPhoto   A normalized photo (policy.js normalizePhoto).
 * @param {(photo: object, delta: -1|1) => Promise<string|null>} options.step
 * @param {(imageId: string) => void} options.onStep
 * @param {(photo: object) => void} [options.onShown]
 * @param {object} [options.render]
 * @param {(url: string, options?: object) => Promise<HTMLImageElement>} [options.load]
 * @param {(canvas: HTMLCanvasElement) => object} [options.createRenderer]
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createKartaViewViewer({ load = loadImage, ...options }) {
  return createPhotoViewer({
    providerId: KARTAVIEW_PROVIDER_ID,
    name: KARTAVIEW_NAME,
    sources: KARTAVIEW_SOURCES,
    load,
    ...options,
  });
}
