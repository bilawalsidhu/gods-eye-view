import { freshStreet } from './state.js';

/**
 * Owns the panel's viewer element and the provider adapter mounted in it.
 * Adapter poses update `state.street`, the marker and the follow camera.
 */
export function createViewerHost({ state, parts }) {
  /** @type {{id: string, adapter: object, unsubscribe: () => void}|null} */
  let active = null;
  /** @type {{id: string, promise: Promise<object>}|null} */
  let mounting = null;
  let openSeq = 0;
  /** Prewarmed, inactive adapters; each holds a live viewer (WebGL context) until `unmount`. */
  const warmed = new Map();

  function notify() {
    state.notify?.();
  }

  function providerEntry(providerId) {
    return state.providers.get(providerId) || null;
  }

  function applyPose(pose) {
    if (!active || !state.street.open || pose.providerId !== active.id) return;
    const previousSequence = state.street.sequenceId;
    Object.assign(state.street, {
      providerId: pose.providerId,
      imageId: pose.imageId,
      position: pose.position ? { ...pose.position } : null,
      bearing: Number.isFinite(pose.bearing) ? pose.bearing : null,
      tilt: Number.isFinite(pose.tilt) ? pose.tilt : 0,
      altitude: Number.isFinite(pose.altitude) ? pose.altitude : null,
      isPano: pose.isPano === true,
      capturedAt: pose.capturedAt ?? null,
      capturedAtPrecision:
        pose.capturedAtPrecision === 'month' ? 'month' : 'day',
      title: pose.title || null,
      sequenceId: pose.sequenceId ?? null,
      creator: pose.creator || null,
      externalUrl: pose.externalUrl || null,
    });
    parts.marker.set(state.street.position, state.street.bearing);
    parts.follow.followCamera();
    // Select the sequence only once the image is on screen, so its lookup
    // never competes with the image download.
    if (!state.street.loading && state.street.sequenceId !== previousSequence)
      selectCurrentSequence();
    notify();
  }

  function selectCurrentSequence() {
    const { sequenceId, providerId } = state.street;
    const entry = providerEntry(providerId);
    if (!sequenceId || !entry?.instance.selectSequence || !state.enabled)
      return;
    const current = entry.instance.sequenceStats?.()?.selectedId;
    if (current !== sequenceId) entry.instance.selectSequence(sequenceId);
  }

  /**
   * Mount a provider's adapter. It becomes `active` only on success, so a
   * failed mount is retried on the next open; concurrent opens share one.
   */
  function mount(entry) {
    if (active?.id === entry.def.id) return Promise.resolve(active.adapter);
    if (mounting?.id === entry.def.id) return mounting.promise;
    if (active) {
      active.adapter.close();
      active.unsubscribe();
      active.adapter.unmount();
      active = null;
    }
    // Another provider's prewarmed viewer shares the host: it would sit
    // under this one, holding its WebGL context.
    for (const [id, warm] of warmed) {
      if (id === entry.def.id) continue;
      warmed.delete(id);
      warm.unmount();
    }
    const adapter = entry.instance.viewer;
    const promise = (async () => {
      await adapter.mount(state.street.host);
      if (mounting?.promise !== promise) {
        // Unmounted (layer off, provider switched) while loading. A newer
        // mount of this provider shares the adapter and its viewer: tearing
        // it down here would leave that mount active with no viewer.
        const reused =
          active?.id === entry.def.id || mounting?.id === entry.def.id;
        if (!reused) adapter.unmount();
        throw new Error('Street-level viewer was closed');
      }
      // Listen only once current: an outdated mount releasing the same
      // `applyPose` would otherwise unhook the mount that replaced it.
      const unsubscribe = adapter.onPose(applyPose);
      active = { id: entry.def.id, adapter, unsubscribe };
      warmed.delete(entry.def.id);
      adapter.setRenderMode?.(state.street.renderMode);
      return adapter;
    })();
    mounting = { id: entry.def.id, promise };
    promise.then(
      () => {
        if (mounting?.promise === promise) mounting = null;
      },
      () => {
        if (mounting?.promise === promise) mounting = null;
      },
    );
    return promise;
  }

  /** Open an image: true once its first pose is in, false if it failed or was overtaken. */
  async function open(providerId, imageId, { frame = true } = {}) {
    const entry = providerEntry(providerId);
    if (!entry || !imageId) return false;
    if (!state.street.host) {
      // A nearest-image lookup may have set it; nothing is loading now.
      state.street.loading = false;
      state.street.error = 'Open the Street Level panel to view imagery';
      notify();
      return false;
    }
    const seq = ++openSeq;
    const current = () => seq === openSeq;
    // Claimed now, honoured after loading only if nothing newer took the camera.
    const ticket =
      frame && !state.street.follow ? parts.follow.beginFraming() : null;
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
      if (ticket && !state.street.follow) parts.follow.lookAtPosition(ticket);
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

  /** Close the image and stop any framing flight; the adapter stays warm. */
  function close() {
    openSeq++;
    parts.follow.cancelFraming();
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
    try {
      active?.adapter.resize();
    } catch {
      /* no-op */
    }
  }

  function setRenderMode(mode) {
    state.street.renderMode = mode === 'fill' ? 'fill' : 'letterbox';
    try {
      active?.adapter.setRenderMode?.(state.street.renderMode);
    } catch {
      /* adapter not ready */
    }
    notify();
  }

  /** Stand active providers' viewers up ahead of the first image. */
  async function prewarm(entries) {
    const host = state.street.host;
    if (!host || !state.enabled) return;
    for (const entry of entries) {
      const adapter = entry.instance.viewer;
      if (!adapter.prewarm || !entry.on) continue;
      // Another provider's viewer is showing in the host: do not build under it.
      if (active && active.id !== entry.def.id) continue;
      try {
        await adapter.prewarm(host);
      } catch {
        /* the real open reports errors */
      }
      if (active?.id === entry.def.id || mounting?.id === entry.def.id)
        continue;
      // Switched off while it loaded, or another provider's viewer took the
      // host meanwhile: release it now rather than keep it under that one.
      if (!state.enabled || !entry.on || active || mounting) adapter.unmount();
      else warmed.set(entry.def.id, adapter);
    }
  }

  /** Tear down every viewer, or only `providerId`'s (active or prewarmed). */
  function unmount(providerId) {
    if (
      !providerId ||
      active?.id === providerId ||
      mounting?.id === providerId
    ) {
      close();
      mounting = null;
      if (active) {
        active.unsubscribe();
        active.adapter.unmount();
        active = null;
      }
    }
    for (const [id, adapter] of warmed) {
      if (providerId && id !== providerId) continue;
      warmed.delete(id);
      adapter.unmount();
    }
  }

  return {
    attach,
    open,
    close,
    resize,
    setRenderMode,
    prewarm,
    unmount,
  };
}
