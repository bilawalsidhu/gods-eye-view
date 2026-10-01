/**
 * Canonicalize a CCTV feed type string to one of:
 * 'image', 'mjpeg', 'mp4', 'webm', 'hls', or pass-through.
 *
 * @param {string} value - Raw feed type (e.g. 'jpeg', 'mjpg', 'video', 'stream').
 * @returns {string} Normalized feed type.
 */
export function normalizeFeedType(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return 'image';
  if (raw === 'jpeg' || raw === 'jpg' || raw === 'png') return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  return raw;
}

/**
 * Check whether a normalized feed type represents streaming video.
 *
 * @param {string} feedType
 * @returns {boolean}
 */
export function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'webm' || feedType === 'hls';
}

/**
 * Media-availability vocabulary, shared by the proxy and the client layer.
 *
 * This answers "does the OPERATOR publish imagery for this camera at all?",
 * which is a different question from "is a frame arriving right now".
 *
 *   'public'        — imagery is published; a missing frame is an OUTAGE, and
 *                     the proxy's Street View / synthetic fallback chain is
 *                     the right answer to it.
 *   'position-only' — the upstream is a survey of camera POSITIONS with no
 *                     public imagery behind it (e.g. Amsterdam's traffic and
 *                     ANPR register). That is a permanent, documented state,
 *                     so the fallback chain is refused: a Street View still is
 *                     context about the location, not evidence from the
 *                     camera.
 */
export const MEDIA_AVAILABILITY_PUBLIC = 'public';
export const MEDIA_AVAILABILITY_POSITION_ONLY = 'position-only';

/**
 * Coerce a declared media availability, defaulting to 'public'.
 *
 * Unknown values fall back to 'public' rather than to 'position-only': a typo
 * must never silently blind a pack that does have frames.
 *
 * @param {*} value
 * @returns {'public'|'position-only'}
 */
export function normalizeMediaAvailability(value) {
  return String(value || '')
    .trim()
    .toLowerCase() === MEDIA_AVAILABILITY_POSITION_ONLY
    ? MEDIA_AVAILABILITY_POSITION_ONLY
    : MEDIA_AVAILABILITY_PUBLIC;
}

/**
 * Does this source/camera publish no imagery at all?
 *
 * @param {{mediaAvailability?: string}|null|undefined} source
 * @returns {boolean}
 */
export function isPositionOnlySource(source) {
  return (
    normalizeMediaAvailability(source?.mediaAvailability) ===
    MEDIA_AVAILABILITY_POSITION_ONLY
  );
}
