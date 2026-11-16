import { msg } from '../i18n/marker.js';

/**
 * Live streams the app can show for a selected object: a fixed list, each
 * entry a broadcast on a platform's own player (YouTube today), attached to
 * the subjects it shows by key. Any layer can name its selected subject's
 * keys (`getLiveSubjectKeys`), and the LIVE section in Context offers the
 * streams that match; the satellites layer names the ISS as `station:iss`
 * whichever of the station's catalog entries is selected.
 *
 * These are broadcasts in the platform's embedded player, not camera feeds:
 * the CCTV layer is for those. A stream's id changes when its broadcaster
 * restarts it, so each entry is one line to update.
 */

/** Where YouTube's embedded player is served from: the privacy-enhanced host. */
export const YOUTUBE_EMBED_HOST = 'https://www.youtube-nocookie.com';

/** @typedef {{id: string, platform: 'youtube', videoId: string, title: string,
 *   owner: string, ownerUrl: string, subjects: readonly string[],
 *   note: string}} LiveStream */

/** @type {readonly LiveStream[]} */
export const LIVE_STREAMS = Object.freeze([
  Object.freeze({
    id: 'iss-exterior',
    platform: 'youtube',
    videoId: 'ROboUHfPUrU',
    title: msg('Exterior cameras'),
    owner: 'NASA',
    ownerUrl: 'https://www.youtube.com/@NASA',
    subjects: Object.freeze(['station:iss']),
    note: msg('NASA video, via YouTube'),
  }),
  Object.freeze({
    id: 'iss-crew',
    platform: 'youtube',
    videoId: 'M3HKLzjvKPc',
    title: msg('Live video and space-to-ground audio'),
    owner: 'NASA',
    ownerUrl: 'https://www.youtube.com/@NASA',
    subjects: Object.freeze(['station:iss']),
    note: msg('NASA video, via YouTube'),
  }),
]);

/**
 * The streams attached to any of `subjectKeys`, in list order.
 * @param {Iterable<string>|null|undefined} subjectKeys
 * @param {readonly LiveStream[]} [streams]
 * @returns {LiveStream[]}
 */
export function liveStreamsFor(subjectKeys, streams = LIVE_STREAMS) {
  const keys = new Set(subjectKeys ?? []);
  if (!keys.size) return [];
  return streams.filter((stream) =>
    stream.subjects.some((subject) => keys.has(subject)),
  );
}

/** The video's own page, for the "Open on YouTube" link. */
export function youtubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/**
 * The parameters the live player is created with: starts on creation (the
 * player is built as soon as a subject with a stream is selected), muted so
 * the browser lets it, inline on phones, no related videos, and the page's
 * origin so the player API may be spoken to.
 * @param {string} origin The page's origin.
 * @returns {Record<string, string|number>}
 */
export function youtubeLivePlayerVars(origin) {
  return {
    autoplay: 1,
    mute: 1,
    playsinline: 1,
    rel: 0,
    enablejsapi: 1,
    ...(origin ? { origin } : {}),
  };
}
