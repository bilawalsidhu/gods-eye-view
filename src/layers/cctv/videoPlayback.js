import { isMobileResourceConstrained } from '../../mobileResourcePolicy.js';

/** One decoder per active camera; both surfaces consume this video element. */
export function attachCctvVideo(
  video,
  url,
  feedType,
  {
    loadHls = () => import('hls.js'),
    onFailure = () => {},
    onReady = () => {},
    fetchImpl = globalThis.fetch,
    constrained = isMobileResourceConstrained(),
    lifecycleTarget = globalThis.window,
  } = {},
) {
  // Preserve replay for existing finite video feeds; live HLS must not loop.
  video.loop = feedType !== 'hls';
  let disposed = false;
  let hls = null;
  const leaseId = feedType === 'hls' ? globalThis.crypto.randomUUID() : null;
  const mediaUrl =
    feedType === 'hls'
      ? `${url}${url.includes('?') ? '&' : '?'}lease=${leaseId}`
      : url;
  let timer = null;
  let startup = null;
  let governor = null;
  let retries = 0;
  let releasePending = null;
  let released = feedType !== 'hls';
  const pagehide = (event) => {
    if (!event.persisted) dispose();
  };
  const release = () => {
    if (released) return Promise.resolve(true);
    if (releasePending) return releasePending;
    // Await this acknowledgement before replacing our lease. Failure stays
    // retryable; normal fire-and-forget teardown never rejects a promise.
    let request;
    try {
      request = fetchImpl(mediaUrl, {
        method: 'DELETE',
        keepalive: true,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      request = Promise.reject(new Error('Release unavailable'));
    }
    releasePending = Promise.resolve(request)
      .then((response) => (released = response?.ok === true))
      .catch(() => false)
      .finally(() => {
        releasePending = null;
      });
    return releasePending;
  };
  const dispose = () => {
    if (disposed) return release();
    disposed = true;
    clearTimeout(timer);
    clearTimeout(startup);
    clearInterval(governor);
    hls?.destroy();
    hls = null;
    video.removeEventListener('canplay', play);
    video.removeEventListener('error', fail);
    lifecycleTarget?.removeEventListener('pagehide', pagehide);
    video.pause();
    video.removeAttribute('src');
    video.load();
    return release();
  };
  const fail = () => {
    if (disposed) return;
    dispose();
    onFailure();
  };
  const play = () => {
    if (disposed) return;
    clearTimeout(startup);
    video.play().catch(() => {});
    onReady();
  };
  video.addEventListener('canplay', play);
  video.addEventListener('error', fail);
  lifecycleTarget?.addEventListener('pagehide', pagehide);
  startup = setTimeout(fail, 30000);
  const ready = (async () => {
    if (feedType !== 'hls') {
      video.src = mediaUrl;
      return;
    }
    try {
      const { default: Hls } = await loadHls();
      if (disposed) return;
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl'))
          video.src = mediaUrl;
        else fail();
        return;
      }
      hls = new Hls({
        enableWorker: true,
        maxBufferLength: constrained ? 8 : 24,
        maxMaxBufferLength: constrained ? 10 : 30,
        backBufferLength: 0,
        maxBufferSize: (constrained ? 4 : 16) * 1024 * 1024,
        liveSyncDurationCount: 3,
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || !data?.fatal) return;
        if (++retries > 2) {
          fail();
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (disposed) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else hls.loadSource(mediaUrl);
        }, 2000);
      });
      governor = setInterval(() => {
        if (disposed || !video.buffered?.length) return;
        const ahead =
          video.buffered.end(video.buffered.length - 1) - video.currentTime;
        // Some agency encoders publish less media time than wall time. Bound
        // correction rather than repeatedly draining the live buffer at 1x.
        video.playbackRate = constrained
          ? ahead < 2
            ? 0.8
            : ahead < 4
              ? 0.9
              : ahead > 8
                ? 1.05
                : 1
          : ahead < 6
            ? 0.8
            : ahead < 12
              ? 0.9
              : ahead > 24
                ? 1.05
                : 1;
      }, 1000);
      hls.attachMedia(video);
      hls.loadSource(mediaUrl);
    } catch {
      fail();
    }
  })();
  return { dispose, release, ready };
}
