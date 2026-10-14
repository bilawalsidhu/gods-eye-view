/** Widest decoded copy the second surface ever draws. */
export const CCTV_VIDEO_SURFACE_MAX_WIDTH = 1280;
/** Draw ceiling for the second surface, in frames per second. */
export const CCTV_VIDEO_SURFACE_FPS = 60;
const SURFACE_FRAME_MS = 1000 / CCTV_VIDEO_SURFACE_FPS;

/** Paint a second surface from the projection decoder, bounded to 1280px/60 fps. */
export function createCctvVideoSurface(
  canvas,
  getVideo,
  {
    requestFrame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame,
    maxWidth = CCTV_VIDEO_SURFACE_MAX_WIDTH,
    frameMs = SURFACE_FRAME_MS,
  } = {},
) {
  const ctx = canvas.getContext('2d');
  let handle = 0;
  let stopped = false;
  let previous = null;
  let previousTime = -1;
  let paintedAt = -Infinity;
  const paint = (now) => {
    if (stopped) return;
    const video = getVideo();
    if (video !== previous) {
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      previous = video;
      previousTime = -1;
    }
    if (
      ctx &&
      video?.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      now - paintedAt >= frameMs &&
      video.currentTime !== previousTime
    ) {
      const width = Math.min(maxWidth, video.videoWidth);
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
      } catch {
        /* A resolution/decode transition retries on the next frame. */
      }
    }
    handle = requestFrame(paint);
  };
  handle = requestFrame(paint);
  return {
    stop() {
      stopped = true;
      cancelFrame(handle);
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
