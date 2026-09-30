/** How long one stream may take to produce playable media before the next. */
export const LIVE_TV_STARTUP_MS = 15_000;

/**
 * Why a stream cannot be tried at all from this page. A secure page cannot
 * load an http:// playlist (mixed content), so it is skipped rather than
 * left to fail after a timeout.
 * @param {string} url
 * @param {string} [pageProtocol]
 * @returns {'insecure' | null}
 */
export function liveTvStreamBlocker(url, pageProtocol) {
  return pageProtocol === 'https:' && /^http:/i.test(url) ? 'insecure' : null;
}

/**
 * Play a channel's HLS streams in one <video>, directly from the
 * broadcaster: the first stream that produces media wins, and a fatal error
 * or a silent startup moves on to the next. Nothing is proxied or retried in
 * the background; when every stream fails the caller hears `unavailable`.
 * @param {HTMLVideoElement} video
 * @param {Array<{url: string}>} streams
 * @param {{
 *   loadHls?: () => Promise<{default: any}>,
 *   onStatus?: (status: {state: string, index: number, total: number, reason?: string}) => void,
 *   pageProtocol?: string,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} [options]
 * @returns {{dispose: () => void}}
 */
export function attachLiveTvStreams(
  video,
  streams,
  {
    loadHls = () => import('hls.js'),
    onStatus = () => {},
    pageProtocol = globalThis.location?.protocol,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  let disposed = false;
  let hls = null;
  let startup = null;
  let index = -1;
  let playing = false;
  let reason = '';
  const total = streams.length;

  const detach = () => {
    clearTimer(startup);
    startup = null;
    hls?.destroy();
    hls = null;
    video.removeEventListener('playing', onPlaying);
    video.removeEventListener('error', onError);
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
  function onPlaying() {
    if (disposed || playing) return;
    playing = true;
    clearTimer(startup);
    onStatus({ state: 'playing', index, total });
  }
  function onError() {
    next('error');
  }
  function next(why) {
    if (disposed) return;
    if (why) reason = why;
    detach();
    playing = false;
    index += 1;
    while (index < total) {
      const blocker = liveTvStreamBlocker(streams[index].url, pageProtocol);
      if (!blocker) break;
      reason = blocker;
      index += 1;
    }
    if (index >= total) {
      onStatus({ state: 'unavailable', index: total - 1, total, reason });
      return;
    }
    const attempt = index;
    const url = streams[attempt].url;
    onStatus({ state: 'connecting', index: attempt, total });
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);
    (async () => {
      try {
        const { default: Hls } = await loadHls();
        if (disposed || attempt !== index) return;
        // Armed once the player code is here, so a slow first download of
        // hls.js is never blamed on the stream.
        startup = setTimer(() => {
          if (!disposed && attempt === index && !playing) next('timeout');
        }, LIVE_TV_STARTUP_MS);
        if (!Hls.isSupported()) {
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.play().catch(() => {});
          } else next('unsupported');
          return;
        }
        let recovered = false;
        hls = new Hls({
          enableWorker: true,
          maxBufferLength: 20,
          backBufferLength: 0,
          maxBufferSize: 16 * 1024 * 1024,
          // A dead host should give way to the next stream quickly.
          manifestLoadingMaxRetry: 0,
          levelLoadingMaxRetry: 1,
          fragLoadingMaxRetry: 2,
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (disposed || attempt !== index || !data?.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            hls.recoverMediaError();
            return;
          }
          next(
            data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network' : 'media',
          );
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!disposed && attempt === index) video.play().catch(() => {});
        });
        hls.attachMedia(video);
        hls.loadSource(url);
      } catch {
        next('unsupported');
      }
    })();
  }

  next();
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
    },
  };
}
