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

/** Canonicalize allowlisted public CCTV links to provider-owned players. */
export function normalizeCctvEmbedUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value))
    return '';
  try {
    const url = new URL(value);
    const id = youtubeVideoId(url);
    // Keep provider controls and drop caller-supplied player/tracking parameters.
    if (id) return `https://www.youtube-nocookie.com/embed/${id}?playsinline=1`;
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return '';
    if (url.hostname === 'v.angelcam.com' && url.pathname === '/iframe') {
      const ids = url.searchParams.getAll('v');
      return ids.length === 1 && /^[a-z0-9]{10}$/.test(ids[0])
        ? `https://v.angelcam.com/iframe?v=${ids[0]}&autoplay=1&mute=1`
        : '';
    }
    if (
      /^[a-z0-9-]+\.roundshot\.com$/.test(url.hostname) &&
      url.pathname === '/'
    )
      return `${url.origin}/`;
    let channel;
    if (url.hostname === 'player.twitch.tv' && url.pathname === '/') {
      if (url.searchParams.getAll('channel').length !== 1) return '';
      channel = url.searchParams.get('channel');
    } else if (
      url.hostname === 'www.twitch.tv' ||
      url.hostname === 'twitch.tv'
    ) {
      channel = /^\/([a-zA-Z0-9_]{1,25})\/?$/.exec(url.pathname)?.[1];
    }
    return /^[a-zA-Z0-9_]{1,25}$/.test(channel || '')
      ? `https://player.twitch.tv/?channel=${channel.toLowerCase()}&autoplay=false&muted=true`
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
