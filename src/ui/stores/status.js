import { defineStore } from 'pinia';
import { presented } from './presented.js';

/**
 * The scene's status chips as their views render them. ShellFeedback
 * (src/ui/shellFeedback.js) publishes the top-center loading status and the
 * road network chip, CctvControls the camera grid chip; the toast shows
 * what any owner's createToast() (src/ui/toast.js) publishes, and the title
 * bar the FPS readout createFrameRateMonitor() publishes. Each label keeps its
 * last text while hidden, so the next change flaps from what was shown. The
 * render failure notice is what installRenderFailureNotice()
 * (src/render/cesium/renderFailure.js) publishes while the globe cannot draw.
 */
export const useStatusStore = defineStore('gev-status', () => {
  /**
   * `{hidden, state, label, detail, stopped}`; null until first published.
   * `stopped` rests a label for good once its owner is destroyed.
   */
  const [loading, publishLoading] = presented();
  /** `{visible, label, immediate, progress, stopped}`, or null. */
  const [traffic, publishTraffic] = presented();
  /** `{visible, label, immediate, progress, stopped}`, or null. */
  const [cctv, publishCctv] = presented();

  /**
   * The page toast, `{text, visible, shown}`; null until the first one.
   * `shown` changes with every show, which rewrites the text.
   */
  const [toast, publishToast] = presented();

  /**
   * The title bar's FPS readout, `{visible, text}`; null while no monitor
   * counts frames.
   */
  const [fps, publishFps] = presented();

  /**
   * The globe's render failure, `{reason, detail, retry, reset}`; null while
   * the globe draws. `reason` is 'render-error' or 'context-lost', and `retry`
   * and `reset` are null where that action is not offered.
   */
  const [renderFailure, publishRenderFailure] = presented();

  return {
    fps,
    publishFps,
    toast,
    publishToast,
    loading,
    publishLoading,
    traffic,
    publishTraffic,
    cctv,
    publishCctv,
    renderFailure,
    publishRenderFailure,
  };
});
