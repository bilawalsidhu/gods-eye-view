import { freshStreet } from './state.js';

/**
 * Owns the panel's viewer element and the photo viewer mounted in it (the
 * MapillaryJS adapter, or a stand-in). Its poses update `state.street` and
 * the marker; MapillaryJS loads on the first open.
 */
export function createViewerHost({ state, parts, adapter }) {
  /** Set once mounted, until `unmount`. */
  let unsubscribe = null;
  /** The mount in flight, shared by concurrent opens. */
  let mounting = null;
  let openSeq = 0;

  function notify() {
    state.notify?.();
  }

  function applyPose(pose) {
    if (!unsubscribe || !state.street.open) return;
    const previousSequence = state.street.sequenceId;
    Object.assign(state.street, {
      imageId: pose.imageId,
      position: pose.position ? { ...pose.position } : null,
      bearing: Number.isFinite(pose.bearing) ? pose.bearing : null,
      tilt: Number.isFinite(pose.tilt) ? pose.tilt : 0,
      altitude: Number.isFinite(pose.altitude) ? pose.altitude : null,
      isPano: pose.isPano === true,
      capturedAt: pose.capturedAt ?? null,
      sequenceId: pose.sequenceId ?? null,
      creator: pose.creator || null,
      externalUrl: pose.externalUrl || null,
    });
    parts.marker.set(state.street.position, state.street.bearing);
    // Select the sequence only once the image is on screen, so its lookup
    // never competes with the image download.
    if (!state.street.loading && state.street.sequenceId !== previousSequence)
      selectCurrentSequence();
    notify();
  }

  function selectCurrentSequence() {
    const { sequenceId } = state.street;
    if (!sequenceId || !state.enabled) return;
    if (state.sequence.selectedId !== sequenceId)
      parts.sequences.select(sequenceId);
  }

  /**
   * Mount the viewer. It counts as mounted only on success, so a failed
   * mount is retried on the next open; concurrent opens share one.
   */
  function mount() {
    if (unsubscribe) return Promise.resolve();
    if (mounting) return mounting;
    const promise = (async () => {
      await adapter.mount(state.street.host);
      if (mounting !== promise) {
        // Unmounted (layer off) while loading. A newer mount shares the
        // viewer: tearing it down here would leave that mount without one.
        if (!mounting && !unsubscribe) adapter.unmount();
        throw new Error('Street-level viewer was closed');
      }
      // Listen only once current: an outdated mount releasing the same
      // `applyPose` would otherwise unhook the mount that replaced it.
      unsubscribe = adapter.onPose(applyPose);
      adapter.setRenderMode?.(state.street.renderMode);
    })();
    mounting = promise;
    const settle = () => {
      if (mounting === promise) mounting = null;
    };
    promise.then(settle, settle);
    return promise;
  }

  /** Open an image: true once its first pose is in, false if it failed or was overtaken. */
  async function open(imageId) {
    if (!imageId) return false;
    if (!state.street.host) {
      state.street.error = 'Open the Street Level panel to view imagery';
      notify();
      return false;
    }
    const seq = ++openSeq;
    const current = () => seq === openSeq;
    // Claimed now, honoured after loading only if nothing newer took the camera.
    const ticket = parts.framing.begin();
    Object.assign(state.street, { loading: true, error: null, open: true });
    notify();
    try {
      await mount();
      if (!current()) return false;
      await adapter.open(String(imageId));
      if (!current()) return false;
      if (ticket) parts.framing.frame(ticket);
    } catch (error) {
      if (current())
        state.street.error = error?.message || 'Image could not be opened';
    } finally {
      if (current()) state.street.loading = false;
      notify();
    }
    if (!current() || state.street.error) return false;
    selectCurrentSequence();
    return true;
  }

  /** Close the image and stop any framing flight; the viewer stays mounted. */
  function close() {
    openSeq++;
    parts.framing.cancel();
    if (unsubscribe) adapter.close();
    Object.assign(state.street, freshStreet());
    parts.marker.clear();
    notify();
  }

  function attach(element) {
    state.street.host = element || null;
    if (element && state.street.open) resize();
  }

  function resize() {
    try {
      if (unsubscribe) adapter.resize();
    } catch {
      /* no-op */
    }
  }

  function setRenderMode(mode) {
    state.street.renderMode = mode === 'fill' ? 'fill' : 'letterbox';
    try {
      if (unsubscribe) adapter.setRenderMode?.(state.street.renderMode);
    } catch {
      /* adapter not ready */
    }
    notify();
  }

  /** Close the image and destroy the viewer (and its WebGL context). */
  function unmount() {
    close();
    mounting = null;
    unsubscribe?.();
    unsubscribe = null;
    adapter.unmount();
  }

  return { attach, open, close, resize, setRenderMode, unmount };
}
