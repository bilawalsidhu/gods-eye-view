import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { createCctvVideoSurface } from './cctvVideo.js';
import {
  canKeepCameraFrame,
  captureFrameStill,
  isBlankFrame,
} from './frameStill.js';

// A refresh interval is how often to poll, not a deadline for the image download.
const STILL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A docked camera's picture, and whether it is live.
 *
 * A video camera plays its own stream. While Cameras is on and it is the
 * active camera, the dock paints from the decoder the map's projection runs
 * (no second connection); once the layer lets that go (Cameras off, Clear
 * all, another camera picked), the dock holds the camera's stream itself, one
 * connection, until it is closed. A stream that cannot go on leaves that
 * camera's last drawn frame, paused, never another picture.
 *
 * A still camera shows its frame, read again on its refresh interval. It is
 * live only once a frame has loaded and is not blank; until then it is
 * loading, and a failed or blank frame says so.
 *
 * While `suspended` (the dock is hidden: under Context's full-height column,
 * or with the corner put away by Cockpit, clean view or recording) nothing
 * runs: no stream of its own, no painter and no frame reads; the
 * dock says 'paused' and starts again when it shows.
 *
 * `feed` is what the dock says: 'live', 'loading', 'stalled', 'paused',
 * 'failed', 'lost' (no frame), or '' when no camera is docked.
 */
export function useDockedCamera({
  view,
  tick,
  cards,
  docked,
  pinned,
  activeFrame,
  cctvLive,
  cctvView,
  suspended = ref(false),
  document = globalThis.document,
}) {
  const cameraId = computed(() =>
    view.value?.kind === 'camera' ? String(view.value.identity?.id || '') : '',
  );
  const key = computed(() => (cameraId.value ? view.value.key : ''));
  const layer = () => cards.layerModule('cctv');

  const pageHidden = ref(Boolean(document?.hidden));
  const onVisibility = () => {
    pageHidden.value = Boolean(document?.hidden);
    // A stream that failed tries once more when the page shows again.
    if (!pageHidden.value) retryOwnStream();
  };
  document?.addEventListener?.('visibilitychange', onVisibility);

  // The docked camera's stream, held from when it is first known: its URL
  // carries a time stamp, so reading it again would restart a playing hold.
  const stream = shallowRef(null);
  const ownFailed = ref(false);
  // A failed hold tries again on its own after a wait that grows (5 s,
  // 15 s, 45 s, then every 2 min), and at once when the page shows again.
  const OWN_RETRY_MS = [5_000, 15_000, 45_000, 120_000];
  let ownRetries = 0;
  let ownRetryTimer = 0;
  function cancelOwnRetry() {
    clearTimeout(ownRetryTimer);
    ownRetryTimer = 0;
  }
  function retryOwnStream() {
    cancelOwnRetry();
    if (!ownFailed.value || !cameraId.value) return;
    // The failed URL's time stamp may be why it failed: read it again.
    stream.value =
      layer()?.streamSourceForCamera?.(cameraId.value) || stream.value;
    ownFailed.value = false;
  }
  function ownStreamFailed() {
    ownFailed.value = true;
    cancelOwnRetry();
    const wait = OWN_RETRY_MS[Math.min(ownRetries, OWN_RETRY_MS.length - 1)];
    ownRetries += 1;
    ownRetryTimer = setTimeout(retryOwnStream, wait);
  }
  watch(
    [tick, key],
    ([, next], [, was]) => {
      if (next !== was) {
        stream.value = null;
        ownFailed.value = false;
        ownRetries = 0;
        cancelOwnRetry();
      }
      if (!cameraId.value || stream.value) return;
      stream.value = layer()?.streamSourceForCamera?.(cameraId.value) || null;
    },
    { immediate: true },
  );

  const shared = computed(
    () =>
      Boolean(cameraId.value) &&
      Boolean(cctvLive.value) &&
      cctvView.value?.activeCameraId === cameraId.value,
  );
  watch(
    () =>
      shared.value && !suspended.value && !pageHidden.value
        ? cameraId.value
        : '',
    (id, _, onCleanup) => {
      if (!id) return;
      const module = layer();
      module?.setVideoConsumer?.('dock', id);
      onCleanup(() => module?.setVideoConsumer?.('dock', null));
    },
    { immediate: true },
  );
  // The map has the stream again: the dock's own hold may try again later.
  watch(shared, (isShared) => {
    if (!isShared) return;
    ownFailed.value = false;
    ownRetries = 0;
    cancelOwnRetry();
  });
  const streamMode = computed(() => {
    if (!cameraId.value) return '';
    if (shared.value) return 'shared';
    return stream.value && !ownFailed.value ? 'own' : '';
  });

  // The dock's own hold on the stream, only while the map's is not there.
  const ownVideo = shallowRef(null);
  let hold = null;
  function release() {
    hold?.dispose();
    hold = null;
    ownVideo.value = null;
  }
  watch(
    [() => streamMode.value === 'own', pageHidden, stream, key, suspended],
    ([own, hidden, source, , away]) => {
      release();
      if (!own || hidden || away || !source || !document?.createElement) return;
      const video = document.createElement('video');
      let handle = null;
      handle =
        layer()?.attachCameraStream?.(video, source, {
          onFailure: () => {
            if (!handle || hold !== handle) return;
            release();
            ownStreamFailed();
          },
        }) || null;
      if (!handle) {
        ownStreamFailed();
        return;
      }
      hold = handle;
      ownVideo.value = video;
    },
    { immediate: true },
  );

  // One painter for the dock's canvas, whichever decoder it reads: a handover
  // keeps the last frame drawn while the next one starts.
  const canvas = ref(null);
  const streamState = ref('');
  const streamOn = computed(() => streamMode.value !== '');
  let surface = null;
  // Whether this painter has drawn anything yet (it keeps it over a handover).
  const everDrawn = ref(false);
  function stopPainter() {
    surface?.stop();
    surface = null;
    streamState.value = '';
    everDrawn.value = false;
  }
  watch(
    [streamOn, canvas, pageHidden, key, suspended],
    ([on, element, hidden, , away]) => {
      stopPainter();
      if (!on || !element || hidden || away) return;
      const own = createCctvVideoSurface(
        element,
        () =>
          streamMode.value === 'shared'
            ? layer()?.getActiveVideoElement?.() || null
            : ownVideo.value,
        {
          clearOnSwitch: false,
          onState: (next) => {
            if (surface !== own) return;
            streamState.value = next;
            if (next === 'playing') everDrawn.value = true;
          },
        },
      );
      surface = own;
      streamState.value = 'waiting';
    },
    { flush: 'post', immediate: true },
  );
  const streamDrawn = computed(
    () => streamState.value === 'playing' || streamState.value === 'stalled',
  );

  // Each real frame the dock shows is kept small: the camera's pin shows it
  // while docked, and it is the last frame shown once the stream stops or
  // the dock closes with the layer off. A blank frame is never kept.
  async function keepFrom(shown) {
    const current = view.value;
    if (current?.kind !== 'camera' || !shown || isBlankFrame(shown)) return;
    const pin = pinned.pinFor(current.key);
    const url = await captureFrameStill({ shown, url: '' });
    if (!url || view.value?.key !== current.key) return;
    docked.keepStill(current.key, url);
    pinned.setStill(pin, url);
  }
  let streamStillAt = 0;
  function keepStreamStill(fresh = false) {
    // A stalled picture is the frame already kept; nothing new to save.
    if (streamState.value !== 'playing' || !canvas.value) return;
    const refreshMs = cards.cameraDetails(cameraId.value)?.refreshMs || 10_000;
    if (!fresh && Date.now() - streamStillAt < refreshMs) return;
    streamStillAt = Date.now();
    void keepFrom(canvas.value);
  }
  watch(streamDrawn, (isDrawn) => isDrawn && keepStreamStill(true));
  watch(streamDrawn, (isDrawn) => {
    if (isDrawn && streamMode.value === 'own') ownRetries = 0;
  });

  // A still camera's frame, read again once its refresh interval has
  // passed. The frame the camera's card last showed (the camera store) is
  // only the first picture: docked, the card no longer refreshes it, so the
  // dock reads its own from then on. A video camera that is not playing
  // shows only its own last frame.
  const still = ref('');
  const stillState = ref('');
  let descriptor = null;
  let cardFallback = '';
  let stillAt = 0;
  let pendingUntil = 0;
  const stillAttempt = ref(0);
  watch(
    [tick, key],
    ([, next], [, was]) => {
      const fromCard =
        activeFrame.value?.cameraId === cameraId.value
          ? activeFrame.value.src
          : '';
      if (next !== was) {
        stillState.value = '';
        pendingUntil = 0;
        // A card URL may be a live-only proxy fallback. Keep it only for this
        // open dock; an object URL (a frame read for its time) is the card's
        // and may be freed, so it is never a fallback.
        cardFallback = String(fromCard).startsWith('blob:') ? '' : fromCard;
        descriptor = null;
      }
      if (!cameraId.value) {
        still.value = '';
        return;
      }
      // Hidden (stowed, a mode that hides the corner, or a background tab):
      // the picture shown last stays; nothing is read meanwhile.
      if (suspended.value || pageHidden.value) {
        if (next !== was) still.value = docked.lastStillOf(next);
        return;
      }
      if (streamOn.value) {
        // On a new camera the canvas still holds the previous camera's frame
        // until its painter restarts; that camera's first drawn frame is
        // kept instead (the streamDrawn watcher).
        if (next === was) keepStreamStill();
        still.value = '';
        return;
      }
      if (stream.value) {
        still.value = docked.lastStillOf(next) || cardFallback;
        return;
      }
      if (next !== was) {
        still.value = fromCard || docked.lastStillOf(next);
        if (fromCard) {
          stillAt = Date.now();
          return;
        }
      }
      const frame = cards.cameraFrame(cameraId.value);
      // The camera dropped out of its feed: no stale frame passed off as live.
      if (!frame) {
        pendingUntil = 0;
        still.value = '';
        return;
      }
      const now = Date.now();
      if (pendingUntil && now < pendingUntil) return;
      if (next !== was || now - stillAt >= frame.refreshMs) {
        if (
          frame.url !== still.value ||
          pendingUntil ||
          stillState.value === 'failed'
        ) {
          if (frame.url === still.value) stillAttempt.value++;
          descriptor = frame;
          pendingUntil = now + STILL_REQUEST_TIMEOUT_MS;
          still.value = frame.url;
        }
        stillAt = now;
      }
    },
    { immediate: true },
  );
  // Shown again: the next read fetches a fresh frame.
  watch([suspended, pageHidden], ([away, hidden]) => {
    if (away || hidden) {
      if (pendingUntil) still.value = '';
      pendingUntil = 0;
    } else stillAt = 0;
  });
  // A stream that stops leaves its last frame at once, not on the next read.
  watch(streamOn, (on) => {
    if (on) still.value = '';
    else if (stream.value)
      still.value = docked.lastStillOf(key.value) || cardFallback;
  });
  // A new frame is loading until it loads; one already shown stays live
  // while the next one loads in its place.
  watch(still, (src) => {
    if (!src) stillState.value = '';
    else if (stillState.value !== 'ok') stillState.value = 'loading';
  });
  const display = shallowRef(null);
  function showImage(next) {
    display.value?.release?.();
    display.value = next;
  }
  watch(
    [still, stillAttempt, key, suspended, pageHidden],
    ([url, attempt, cameraKey, away, hidden], _, onCleanup) => {
      if (!url || away || hidden) return showImage(null);
      if (display.value?.cameraKey !== cameraKey) showImage(null);
      const frame = descriptor?.url === url ? descriptor : null;
      const request = { cameraKey, requestUrl: url, attempt };
      if (!frame?.readImage) {
        // A card can hand the dock a proxy URL before a descriptor is available.
        const liveUrl =
          !stream.value && url.startsWith('/api/cctv/frame/')
            ? url + (url.includes('?') ? '&' : '?') + 'liveOnly=1'
            : url;
        return showImage({ ...request, url: liveUrl });
      }
      // The image and its provenance come from the same response. While it
      // downloads, the previous settled picture of this camera stays on screen.
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      frame.readImage(controller.signal, { liveOnly: true }).then(
        (image) => {
          if (controller.signal.aborted) return image.release();
          showImage({ ...request, ...image });
        },
        () => {
          if (controller.signal.aborted) return;
          pendingUntil = 0;
          stillState.value = 'failed';
        },
      );
    },
    { immediate: true },
  );
  function isCurrentImage(image) {
    const shown = display.value;
    return (
      !stream.value &&
      image?.isConnected &&
      shown?.requestUrl === still.value &&
      shown.attempt === stillAttempt.value &&
      image.getAttribute('src') === shown.url
    );
  }
  function stillLoaded(event) {
    const image = event?.target;
    if (!isCurrentImage(image)) return;
    pendingUntil = 0;
    const shown = display.value;
    if (
      ('sourceKind' in shown && !canKeepCameraFrame(shown.sourceKind)) ||
      isBlankFrame(image)
    ) {
      stillState.value = 'failed';
      return;
    }
    stillState.value = 'ok';
    if (canKeepCameraFrame(display.value?.sourceKind)) void keepFrom(image);
  }
  function stillFailed(event) {
    const image = event.target;
    if (!isCurrentImage(image)) return;
    pendingUntil = 0;
    stillState.value = 'failed';
  }

  const feed = computed(() => {
    if (!cameraId.value) return '';
    if (suspended.value) return 'paused';
    if (streamOn.value) {
      if (streamState.value === 'playing') return 'live';
      return streamState.value === 'stalled' ? 'stalled' : 'loading';
    }
    if (stream.value) return still.value ? 'paused' : 'lost';
    if (!still.value) return 'lost';
    if (stillState.value === 'ok') return 'live';
    return stillState.value === 'failed' ? 'failed' : 'loading';
  });
  /** Whether a picture is drawn under the dock's label. */
  const pictured = computed(() => {
    if (streamOn.value) return everDrawn.value;
    if (stream.value) return Boolean(still.value);
    return Boolean(still.value) && stillState.value === 'ok';
  });

  onBeforeUnmount(() => {
    cancelOwnRetry();
    showImage(null);
    stopPainter();
    release();
    document?.removeEventListener?.('visibilitychange', onVisibility);
  });

  return {
    canvas,
    streamOn,
    still: computed(() => display.value?.url || ''),
    stillAttempt,
    stillLoaded,
    stillFailed,
    feed,
    pictured,
  };
}
