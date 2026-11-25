/**
 * YouTube's IFrame Player API, loaded once per document: the only in-page
 * way to learn a player's state (playing, ended) and errors (video gone,
 * embedding refused), which the live-stream player needs to tell an offline
 * stream from one still loading. The page's script-src allows
 * `https://www.youtube.com`.
 */

const youtubeApis = new WeakMap();

/**
 * Load the API, or return the one already there.
 * @param {Document} documentRef
 * @param {object} globalRef The window: `YT`, `onYouTubeIframeAPIReady`,
 *   timers.
 * @returns {Promise<object>} The `YT` namespace.
 */
export function loadYouTubeApi(documentRef, globalRef) {
  if (typeof globalRef.YT?.Player === 'function')
    return Promise.resolve(globalRef.YT);
  if (youtubeApis.has(documentRef)) return youtubeApis.get(documentRef);
  const pending = new Promise((resolve, reject) => {
    const previous = globalRef.onYouTubeIframeAPIReady;
    let timer;
    let settled = false;
    const script = documentRef.createElement('script');
    const finish = (error) => {
      if (settled) return;
      settled = true;
      globalRef.clearTimeout(timer);
      if (globalRef.onYouTubeIframeAPIReady === ready)
        globalRef.onYouTubeIframeAPIReady = previous;
      if (error) {
        script.remove();
        reject(error);
      } else resolve(globalRef.YT);
    };
    const ready = () => {
      try {
        previous?.();
      } finally {
        finish(
          typeof globalRef.YT?.Player === 'function'
            ? null
            : new Error('YouTube API unavailable'),
        );
      }
    };
    globalRef.onYouTubeIframeAPIReady = ready;
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.addEventListener(
      'error',
      () => finish(new Error('YouTube API unavailable')),
      { once: true },
    );
    timer = globalRef.setTimeout(
      () => finish(new Error('YouTube API timed out')),
      5000,
    );
    documentRef.head.append(script);
  }).catch((error) => {
    youtubeApis.delete(documentRef);
    throw error;
  });
  youtubeApis.set(documentRef, pending);
  return pending;
}
