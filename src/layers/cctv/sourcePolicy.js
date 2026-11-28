export const FRAME_ENDPOINT = '/api/cctv/frame';

export const MEDIA_ENDPOINT = '/api/cctv/media';

export const ACTIVE_FRAME_REFRESH_MS = 10000;

/** The methods every camera source supplies. */
export const CCTV_SOURCE_METHODS = Object.freeze([
  'getCatalog',
  'getHealth',
  'getFrameUrl',
  'getMediaUrl',
]);
