import {
  PANO_FULL_SIZE,
  createPhotoViewer,
  loadImage,
} from '../../photoViewer.js';
import {
  HD_TIMEOUT_MS,
  PANORAMAX_NAME,
  PANORAMAX_PROVIDER_ID,
  PANO_HD_MAX_WIDTH,
  SD_WIDTH,
  panoramaxPictureUrl,
} from './policy.js';

/** An HD original small enough to decode (its width is known and under the cap). */
function hdDecodable(photo) {
  return Boolean(
    photo.urls.hd && photo.width && photo.width <= PANO_HD_MAX_WIDTH,
  );
}

/**
 * Where Panoramax pictures come from: the instance holding each one serves
 * a 2,048 px SD derivative (equirectangular for a 360° picture) and the HD
 * original. SD shows first; HD only once the viewer is wide enough to use
 * it. A 360° original is shrunk to the texture size while it decodes.
 * @type {import('../../photoViewer.js').PhotoSources}
 */
export const PANORAMAX_SOURCES = Object.freeze({
  hasPano: (photo) =>
    Boolean(photo.isPano && (photo.urls.sd || hdDecodable(photo))),
  // Without an SD derivative the original goes straight to the texture size.
  panoFirst: (photo) => {
    // Decoded at SD's own size, whatever the host actually serves.
    if (photo.urls.sd)
      return {
        url: photo.urls.sd,
        width: SD_WIDTH,
        resize: [SD_WIDTH, SD_WIDTH / 2],
      };
    if (!hdDecodable(photo)) return null;
    const width = Math.min(photo.width, PANO_FULL_SIZE[0]);
    return { url: photo.urls.hd, width, resize: [width, width / 2] };
  },
  // The original is several megabytes with no server to shrink it: only
  // for the expanded viewer (a docked one on a dense screen asks too).
  panoSharp: (photo, size, { expanded = false } = {}) => {
    const width = photo.width || 0;
    if (!expanded || !photo.urls.hd || !photo.urls.sd) return null;
    // An original no wider than the SD one adds nothing; a huge one would
    // take hundreds of megabytes to decode.
    if (width <= SD_WIDTH || width > PANO_HD_MAX_WIDTH) return null;
    const target = Math.min(size[0], width);
    return {
      url: photo.urls.hd,
      resize: [target, target / 2],
      timeoutMs: HD_TIMEOUT_MS,
    };
  },
  // A 360° picture shown flat (no WebGL) is its whole equirectangular image.
  // When SD fails the thumbnail stands in; the original (megabytes) only
  // for the expanded viewer, and only one of a size it may decode.
  flatFirst: (photo, { expanded = false } = {}) => [
    photo.urls.sd,
    expanded && hdDecodable(photo) ? photo.urls.hd : null,
    photo.urls.thumb,
  ],
  // The original once the viewer is wider than SD, if its width is known
  // and decodable (a 200 MP phone photo is 16,000 px across).
  flatSharp: (photo, pixels) =>
    photo.urls.sd && hdDecodable(photo) && pixels > SD_WIDTH
      ? photo.urls.hd
      : null,
  describe: (photo) => ({
    // Where no author can be named, the instance holding the photo is.
    title: !photo.creator && photo.via ? `via ${photo.via}` : null,
    creator: photo.creator,
    license: photo.license,
    externalUrl: panoramaxPictureUrl(photo.id),
  }),
});

/**
 * Viewer adapter for Panoramax pictures: flat in an <img>, 360° on the
 * shared WebGL panorama, ‹ › along the sequence (photoViewer.js).
 * @param {object} options   See photoViewer.js `createPhotoViewer`.
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createPanoramaxViewer({ load = loadImage, ...options }) {
  return createPhotoViewer({
    providerId: PANORAMAX_PROVIDER_ID,
    name: PANORAMAX_NAME,
    sources: PANORAMAX_SOURCES,
    load,
    ...options,
  });
}
