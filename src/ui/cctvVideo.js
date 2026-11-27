/** How long a painted video may go without a new frame before it is stalled. */
export const CCTV_VIDEO_STALL_MS = 15_000;

/**
 * Paint a second surface from the projection decoder, bounded to 640px/15 fps.
 * `onState` hears what the surface shows: 'waiting' until its first frame
 * (and again after the decoder changes, which clears it), 'playing' while
 * frames arrive, and 'stalled' when none has for `stallMs` (the last one
 * stays drawn). With `clearOnSwitch` false, a change of decoder for the same
 * camera (the dock taking the stream over from the map) keeps the last frame
 * drawn while it waits for the next. While stalled it looks for a new frame
 * once every `stalledPollMs` instead of on every animation frame.
 */
export function createCctvVideoSurface(
  canvas,
  getVideo,
  {
    requestFrame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame,
    onState = () => {},
    stallMs = CCTV_VIDEO_STALL_MS,
    clearOnSwitch = true,
    stalledPollMs = 1000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  const ctx = canvas.getContext('2d');
  let handle = 0;
  let timer = 0;
  let stopped = false;
  let previous = null;
  let previousTime = -1;
  let paintedAt = -Infinity;
  // It starts out waiting; the caller knows that without being told.
  let state = 'waiting';
  const tell = (next) => {
    if (next === state) return;
    state = next;
    onState(next);
  };
  const paint = (now) => {
    if (stopped) return;
    const video = getVideo();
    if (video !== previous) {
      if (clearOnSwitch) ctx?.clearRect(0, 0, canvas.width, canvas.height);
      previous = video;
      previousTime = -1;
      paintedAt = -Infinity;
      tell('waiting');
    }
    if (
      ctx &&
      video?.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      now - paintedAt >= 1000 / 15 &&
      video.currentTime !== previousTime
    ) {
      const width = Math.min(640, video.videoWidth);
      const height = Math.max(
        1,
        Math.round((width * video.videoHeight) / video.videoWidth),
      );
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      try {
        ctx.drawImage(video, 0, 0, width, height);
        previousTime = video.currentTime;
        paintedAt = now;
        tell('playing');
      } catch {
        /* A resolution/decode transition retries on the next frame. */
      }
    } else if (state === 'playing' && now - paintedAt >= stallMs) {
      tell('stalled');
    }
    if (state === 'stalled') {
      timer = setTimer(() => {
        timer = 0;
        if (!stopped) handle = requestFrame(paint);
      }, stalledPollMs);
      return;
    }
    handle = requestFrame(paint);
  };
  handle = requestFrame(paint);
  return {
    stop() {
      stopped = true;
      cancelFrame(handle);
      clearTimer(timer);
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
