/** How often the live-rate governor resamples the buffer. */
export const LIVE_RATE_POLL_MS = 500;

/** Seconds of buffered media ahead of playback that trigger each rate band. */
export const LIVE_RATE_BANDS = Object.freeze([
  { maxAhead: 2, playbackRate: 0.9 },
  { maxAhead: 6, playbackRate: 0.95 },
  { maxAhead: 10, playbackRate: 1 },
  { maxAhead: 20, playbackRate: 1.15 },
  { maxAhead: Infinity, playbackRate: 1.25 },
]);

/** Selects the live playback rate for the given buffer runway. */
export function livePlaybackRateFor(ahead) {
  return (
    LIVE_RATE_BANDS.find((band) => ahead < band.maxAhead)?.playbackRate ?? 1
  );
}

/** One decoder per active camera; both surfaces consume this video element. */
export function attachCctvVideo(
  video,
  url,
  feedType,
  {
    loadHls = () => import('hls.js'),
    onFailure = () => {},
    fetchImpl = globalThis.fetch,
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
  const release = () => {
    if (feedType === 'hls') {
      void fetchImpl?.(mediaUrl, { method: 'DELETE', keepalive: true }).catch(
        () => {},
      );
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearTimeout(startup);
    clearInterval(governor);
    hls?.destroy();
    hls = null;
    video.removeEventListener('canplay', play);
    video.removeEventListener('error', fail);
    video.pause();
    video.removeAttribute('src');
    video.load();
    release();
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
  };
  const applyLiveRate = () => {
    if (disposed || !video.buffered?.length) return;
    const ahead =
      video.buffered.end(video.buffered.length - 1) - video.currentTime;
    // Some agency encoders publish less media time than wall time, so a thin
    // buffer backs off toward the encoder's own rate rather than stalling. A
    // fat buffer means we are behind live, so close the gap instead of idling.
    video.playbackRate = livePlaybackRateFor(ahead);
  };
  const startGovernor = () => {
    if (disposed || governor) return;
    governor = setInterval(applyLiveRate, LIVE_RATE_POLL_MS);
  };
  video.addEventListener('canplay', play);
  video.addEventListener('error', fail);
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
        startGovernor();
        return;
      }
      hls = new Hls({
        enableWorker: true,
        maxBufferLength: 12,
        maxMaxBufferLength: 18,
        backBufferLength: 0,
        maxBufferSize: 16 * 1024 * 1024,
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
      startGovernor();
      hls.attachMedia(video);
      hls.loadSource(mediaUrl);
    } catch {
      fail();
    }
  })();
  return { dispose, ready };
}
