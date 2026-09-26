/**
 * Own the one viewer element in the panel and whichever provider's viewer
 * adapter is mounted in it. Poses the adapter emits become `state.street`,
 * move the marker and (optionally) the globe camera.
 */
export function createViewerHost({ state, parts }) {
  /** @type {{id: string, adapter: object, unsubscribe: () => void}|null} */
  let active = null;
  /** @type {{id: string, promise: Promise<object>}|null} */
  let mounting = null;
  let openSeq = 0;

  function notify() {
    state.notify?.();
  }

  function providerEntry(providerId) {
    return state.providers.get(providerId) || null;
  }

  function applyPose(pose) {
    if (!active || pose.providerId !== active.id) return;
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
      sequenceId: pose.sequenceId ?? null,
      creator: pose.creator || null,
      externalUrl: pose.externalUrl || null,
    });
    parts.marker.set(state.street.position, state.street.bearing);
    parts.follow.followCamera();
    // Providers highlight the selected image's sequence on the map; mirror
    // that once the image itself is on screen, so the sequence lookup never
    // competes with the image download.
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
   * Mount a provider's viewer adapter in the host. The adapter becomes
   * `active` only once its mount succeeded, so a failed mount (a library
   * that did not load) is retried on the next open; concurrent opens for the
   * same provider share one mount.
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
    const adapter = entry.instance.viewer;
    const promise = (async () => {
      const unsubscribe = adapter.onPose(applyPose);
      try {
        await adapter.mount(state.street.host);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      if (mounting?.promise !== promise) {
        // Unmounted (layer off, provider switched) while loading.
        unsubscribe();
        adapter.unmount();
        throw new Error('Street-level viewer was closed');
      }
      active = { id: entry.def.id, adapter, unsubscribe };
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

  /**
   * Open an image from one provider. Returns once the first pose is in;
   * later poses stream through `state.street` as the user navigates.
   */
  async function open(providerId, imageId, { frame = true } = {}) {
    const entry = providerEntry(providerId);
    if (!entry || !imageId) return;
    if (!state.street.host) {
      state.street.error = 'Open the Street Level panel to view imagery';
      notify();
      return;
    }
    const seq = ++openSeq;
    const current = () => seq === openSeq;
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
      if (!current()) return;
      await adapter.open(String(imageId));
      if (!current()) return;
      if (frame && !state.street.follow) parts.follow.lookAtPosition();
    } catch (error) {
      if (current())
        state.street.error = error?.message || 'Image could not be opened';
    } finally {
      if (current()) state.street.loading = false;
      notify();
    }
    if (current() && !state.street.error) selectCurrentSequence();
  }

  /** Close the image; the mounted adapter stays warm for the next open. */
  function close() {
    openSeq++;
    active?.adapter.close();
    Object.assign(state.street, {
      open: false,
      follow: false,
      providerId: null,
      providerName: null,
      providerLabel: null,
      imageId: null,
      position: null,
      bearing: null,
      tilt: null,
      altitude: null,
      isPano: false,
      capturedAt: null,
      sequenceId: null,
      creator: null,
      externalUrl: null,
      loading: false,
      error: null,
    });
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
      try {
        await entry.instance.viewer.prewarm?.(host);
      } catch {
        /* the real open reports errors */
      }
    }
  }

  /** Tear the mounted adapter down (layer disabled or destroyed). */
  function unmount() {
    close();
    mounting = null;
    if (!active) return;
    active.unsubscribe();
    active.adapter.unmount();
    active = null;
  }

  return {
    attach,
    open,
    close,
    resize,
    setRenderMode,
    prewarm,
    unmount,
    activeProviderId: () => active?.id || null,
  };
}
