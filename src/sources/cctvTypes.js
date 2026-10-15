import { youtubeVideoId } from './youtube.js';

/**
 * Canonicalize a CCTV feed type string to one of:
 * 'image', 'mjpeg', 'mp4', 'webm', 'hls', 'embed', or pass-through.
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

/** Canonicalize public YouTube video links to a provider-owned player. */
export function normalizeCctvEmbedUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value))
    return '';
  try {
    const id = youtubeVideoId(new URL(value));
    // Keep provider controls and drop caller-supplied player/tracking parameters.
    return id
      ? `https://www.youtube-nocookie.com/embed/${id}?playsinline=1`
      : '';
  } catch {
    return '';
  }
}

/** Public attribution links must be HTTPS and must not carry credentials. */
export function normalizeCctvSourcePageUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
