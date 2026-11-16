import { loadYouTubeApi } from './youtubeApi.js';
import { YOUTUBE_EMBED_HOST, youtubeLivePlayerVars } from './liveStreams.js';

/**
 * One live stream in YouTube's embedded player, with its state read back
 * through the player API: `loading` until the video plays, `playing`, and
 * `offline` once the player says the video has ended, cannot be found or
 * never starts. The player cannot say "this broadcast is off air" in so
 * many words: a live stream that is off air is reported as a video that
 * cannot play, or that never reaches playing, so both read as offline here.
 * Embedding refused by the video's owner is `unavailable`, which no retry
 * will change.
 */

/** A stream that has not started playing this long after its player was ready is offline. */
export const LIVE_START_TIMEOUT_MS = 25_000;

/** YouTube's player states. */
const ENDED = 0;
const PLAYING = 1;
/** Error codes: embedding not allowed on this page. */
const EMBED_REFUSED = new Set([101, 150]);

/**
 * @param {{host: HTMLElement, videoId: string, documentRef?: Document,
 *   globalRef?: object, loadApi?: typeof loadYouTubeApi,
 *   onChange: (state: {state: 'loading'|'playing'|'offline'|'unavailable',
 *   reason: string|null}) => void}} options `host` is emptied and given the
 *   player's iframe.
 * @returns {{destroy: () => void}}
 */
export function createYouTubeLivePlayer({
  host,
  videoId,
  documentRef = globalThis.document,
  globalRef = globalThis,
  loadApi = loadYouTubeApi,
  onChange,
}) {
  let destroyed = false;
  let player = null;
  let timer = null;
  let current = null;

  const set = (state, reason = null) => {
    if (destroyed || current === state) return;
    current = state;
    onChange({ state, reason });
  };
  const clearTimer = () => {
    if (timer !== null) globalRef.clearTimeout(timer);
    timer = null;
  };
  const armTimer = () => {
    clearTimer();
    timer = globalRef.setTimeout(() => {
      timer = null;
      if (current === 'loading') set('offline', 'timeout');
    }, LIVE_START_TIMEOUT_MS);
  };

  set('loading');
  host.replaceChildren();
  const mount = documentRef.createElement('div');
  host.append(mount);

  loadApi(documentRef, globalRef).then(
    (YT) => {
      if (destroyed) return;
      try {
        player = new YT.Player(mount, {
          host: YOUTUBE_EMBED_HOST,
          videoId,
          playerVars: youtubeLivePlayerVars(globalRef.location?.origin),
          events: {
            onReady: () => {
              if (!destroyed) armTimer();
            },
            onStateChange: (event) => {
              if (destroyed) return;
              if (event?.data === PLAYING) {
                clearTimer();
                set('playing');
              } else if (event?.data === ENDED) {
                clearTimer();
                set('offline', 'ended');
              }
            },
            onError: (event) => {
              if (destroyed) return;
              clearTimer();
              const code = Number(event?.data);
              if (EMBED_REFUSED.has(code)) set('unavailable', `error-${code}`);
              else set('offline', `error-${code}`);
            },
          },
        });
        // The API may never call onReady for a video it cannot load.
        armTimer();
      } catch {
        set('offline', 'player');
      }
    },
    () => {
      if (!destroyed) set('unavailable', 'api');
    },
  );

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimer();
      try {
        player?.destroy?.();
      } catch {
        // A player half-created has nothing to destroy.
      }
      player = null;
      host.replaceChildren();
    },
  };
}
