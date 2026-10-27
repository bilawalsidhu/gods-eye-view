import { msg } from '../../i18n/index.js';
import { freshStreet } from './state.js';

/**
 * The panel's photo viewer element and the provider adapter mounted in it.
 * Adapter poses update `state.street` and the marker.
 */
export function createViewerHost({ state, parts }) {
  /** @type {{id: string, adapter: object, unsubscribe: () => void}|null} */
  let active = null;
  /** The mount in flight, shared by concurrent opens. @type {{id: string, promise: Promise<object>}|null} */
  let mounting = null;
  let openSeq = 0;

  function notify() {
    state.notify?.();
  }

  function applyPose(pose) {
    if (!active || !state.street.open) return;
    const previousSequence = state.street.sequenceId;
    Object.assign(state.street, {
      imageId: pose.imageId,
      position: pose.position ? { ...pose.position } : null,
      bearing: Number.isFinite(pose.bearing) ? pose.bearing : null,
      altitude: Number.isFinite(pose.altitude) ? pose.altitude : null,
      isPano: pose.isPano === true,
      capturedAt: pose.capturedAt ?? null,
      capturedAtPrecision:
        pose.capturedAtPrecision === 'month' ? 'month' : 'day',
      title: pose.title || null,
      sequenceId: pose.sequenceId ?? null,
      creator: pose.creator || null,
      license: pose.license || null,
      externalUrl: pose.externalUrl || null,
      // FIT / FILL, unless this image has no frame to fit (a panorama).
      renderModes:
        typeof active.adapter.setRenderMode === 'function' &&
        active.adapter.supportsRenderModes?.() !== false,
    });
    parts.marker.set(
      state.street.position,
      state.street.bearing,
      state.providers.get(active.id)?.def.marker,
    );
    // Select the sequence only once the image is on screen, so its lookup
    // never competes with the image download.
    if (!state.street.loading && state.street.sequenceId !== previousSequence)
      selectCurrentSequence();
    notify();
  }

  function selectCurrentSequence() {
    const { sequenceId, providerId } = state.street;
    const entry = state.providers.get(providerId);
    if (!sequenceId || !entry?.instance.selectSequence || !state.enabled)
      return;
    if (entry.instance.sequenceStats?.()?.selectedId !== sequenceId)
      entry.instance.selectSequence(sequenceId);
  }

  /**
   * Mount a provider's adapter, releasing another provider's first. It
   * counts as mounted only on success, so a failed mount is retried on the
   * next open; concurrent opens share one.
   */
  function mount(entry) {
    const id = entry.def.id;
    if (active?.id === id) return Promise.resolve(active.adapter);
    if (mounting?.id === id) return mounting.promise;
    if (active) {
      active.adapter.close();
      active.unsubscribe();
      active.adapter.unmount();
      active = null;
    }
    const adapter = entry.instance.viewer;
    const promise = (async () => {
      await adapter.mount(state.street.host);
      if (mounting?.promise !== promise) {
        // Unmounted (layer off, provider switched) while loading. A newer
        // mount of this provider shares the adapter: tearing it down here
        // would leave that mount without a viewer.
        if (active?.id !== id && mounting?.id !== id) adapter.unmount();
        throw new Error('Street-level viewer was closed');
      }
      // Listen only once current: an outdated mount releasing the same
      // `applyPose` would otherwise unhook the mount that replaced it.
      active = { id, adapter, unsubscribe: adapter.onPose(applyPose) };
      adapter.setRenderMode?.(state.street.renderMode);
      return adapter;
    })();
    mounting = { id, adapter, promise };
    const settle = () => {
      if (mounting?.promise === promise) mounting = null;
    };
    promise.then(settle, settle);
    return promise;
  }

  /**
   * Open an image: true once its first pose is in, false if it failed or was
   * overtaken. `frame: false` leaves the camera where it is.
   */
  async function open(providerId, imageId, { frame = true } = {}) {
    const entry = state.providers.get(providerId);
    if (!entry || !imageId) return false;
    if (!state.street.host) {
      // A nearest-image lookup may have set it; nothing is loading now.
      state.street.loading = false;
      // English data: the Street Level panel translates it (translateKnown).
      state.street.error = msg('Open the Street Level panel to view imagery');
      notify();
      return false;
    }
    const seq = ++openSeq;
    const current = () => seq === openSeq;
    // Claimed now, honoured after loading only if nothing newer took the camera.
    const ticket = frame ? parts.framing.begin() : null;
    Object.assign(state.street, {
      loading: true,
      error: null,
      open: true,
      providerId,
      providerName: entry.def.name,
      providerLabel: entry.def.label,
    });
    notify();
    try {
      const adapter = await mount(entry);
      if (!current()) return false;
      // Per open: close() resets it, and a reopen skips mount().
      state.street.renderModes = typeof adapter.setRenderMode === 'function';
      await adapter.open(String(imageId));
      if (!current()) return false;
      if (ticket) parts.framing.frame(ticket);
    } catch (error) {
      if (current())
        state.street.error = error?.message || msg('Image could not be opened');
    } finally {
      if (current()) state.street.loading = false;
      notify();
    }
    if (!current() || state.street.error) return false;
    selectCurrentSequence();
    return true;
  }

  /** Close the image and stop any framing flight; the adapter stays mounted. */
  function close() {
    openSeq++;
    parts.framing.cancel();
    active?.adapter.close();
    Object.assign(state.street, freshStreet());
    parts.marker.clear();
    notify();
  }

  function attach(element) {
    state.street.host = element || null;
    if (element && state.street.open) resize();
  }

  function resize() {
    active?.adapter.resize();
  }

  function setRenderMode(mode) {
    state.street.renderMode = mode === 'fill' ? 'fill' : 'letterbox';
    active?.adapter.setRenderMode?.(state.street.renderMode);
    notify();
  }

  /**
   * Close the image and destroy the viewer (and its WebGL context): every
   * provider's, or only `providerId`'s. A mount still in flight is told too,
   * so it builds nothing when its library lands.
   */
  function unmount(providerId) {
    if (providerId && active?.id !== providerId && mounting?.id !== providerId)
      return;
    close();
    const pending = mounting;
    mounting = null;
    active?.unsubscribe();
    (active?.adapter ?? pending?.adapter)?.unmount();
    active = null;
  }

  return { attach, open, close, resize, setRenderMode, unmount };
}
