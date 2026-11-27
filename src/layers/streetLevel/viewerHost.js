import { msg } from '../../i18n/index.js';
import { freshStreet } from './state.js';

// Leaving a card withdraws its load while preserving any frame it never replaced.
export const KEEP_OPEN_PHOTO = Symbol('keep-open-photo');

// The fields a pose sets on `state.street` (see applyPose).
const POSE_KEYS = Object.freeze([
  'imageId',
  'position',
  'bearing',
  'altitude',
  'isPano',
  'capturedAt',
  'capturedAtSource',
  'capturedAtPrecision',
  'title',
  'sequenceId',
  'creator',
  'via',
  'license',
  'externalUrl',
  'still',
]);

/** Mount providers in the shared photo viewer and publish their accepted poses. */
export function createViewerHost({ state, parts }) {
  /** @type {{id: string, adapter: object, unsubscribe: () => void}|null} */
  let active = null;
  /** The mount in flight, shared by concurrent opens. @type {{id: string, promise: Promise<object>}|null} */
  let mounting = null;
  let openSeq = 0;
  let pendingPose = null;
  let cancelPending = null;
  let photoAvailable = false;
  let acceptanceRevision = 0;
  let acceptedPhoto = null;
  let paidPhotoSurface = null;

  function rememberPhoto({
    requestId = null,
    cardPhotoId = null,
    opened = false,
    origin,
  } = {}) {
    photoAvailable = true;
    const photo = parts.photos?.remember(state.street, {
      explicit: opened && requestId !== null,
    });
    if (!photo) return;
    const changed = acceptedPhoto?.id !== photo.id;
    if (!opened && changed) state.street.error = null;
    const replacesPhoto = opened || changed;
    acceptedPhoto = Object.freeze({
      ...((replacesPhoto ? origin : acceptedPhoto.origin) ===
        'programmatic' && { origin: 'programmatic' }),
      id: photo.id,
      lat: photo.lat,
      lon: photo.lon,
      revision: replacesPhoto ? ++acceptanceRevision : acceptedPhoto.revision,
      requestId: replacesPhoto ? requestId : acceptedPhoto.requestId,
      cardPhotoId: replacesPhoto ? cardPhotoId : acceptedPhoto.cardPhotoId,
    });
  }

  function notify() {
    state.notify?.();
  }

  function applyPose(pose) {
    Object.assign(state.street, {
      imageId: pose.imageId,
      position: pose.position ? { ...pose.position } : null,
      bearing: Number.isFinite(pose.bearing) ? pose.bearing : null,
      altitude: Number.isFinite(pose.altitude) ? pose.altitude : null,
      isPano: pose.isPano === true,
      capturedAt: pose.capturedAt ?? null,
      capturedAtSource: pose.capturedAtSource ?? null,
      capturedAtPrecision:
        pose.capturedAtPrecision === 'month' ? 'month' : 'day',
      title: pose.title || null,
      sequenceId: pose.sequenceId ?? null,
      creator: pose.creator || null,
      via: pose.via || null,
      license: pose.license || null,
      externalUrl: pose.externalUrl || null,
      still: pose.still || null,
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
  }

  function onPose(pose) {
    if (!state.street.open || active.id !== state.street.providerId) return;
    if (pose === null) {
      pendingPose = null;
      photoAvailable = false;
      notify();
      return;
    }
    if (
      !pose?.imageId ||
      !Number.isFinite(pose.position?.lat) ||
      !Number.isFinite(pose.position?.lon)
    )
      return;
    // Hold an opening pose until this open succeeds. A settled viewer can
    // still take a step while an unrelated nearest lookup is waiting.
    if (state.street.opening) {
      pendingPose = pose;
      return;
    }
    const previousSequence = state.street.sequenceId;
    applyPose(pose);
    rememberPhoto();
    if (state.street.sequenceId !== previousSequence) selectCurrentSequence();
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
  function mount(entry, isVisible) {
    const id = entry.def.id;
    if (active?.id === id) return Promise.resolve(active.adapter);
    if (mounting?.id === id) return mounting.promise;
    if (active) {
      active.adapter.close();
      active.unsubscribe();
      active.adapter.unmount();
      active = null;
      acceptedPhoto = null;
      photoAvailable = false;
      // The photo being replaced belonged to that source: none of its details
      // (id, place, author, link) describe the one loading now.
      // The open under way keeps `opening` until it is accepted or given up.
      const {
        open,
        loading,
        opening,
        error,
        providerId,
        providerName,
        providerLabel,
      } = state.street;
      Object.assign(state.street, freshStreet(), {
        open,
        loading,
        opening,
        error,
        providerId,
        providerName,
        providerLabel,
      });
      parts.marker.clear();
    }
    const adapter = entry.instance.viewer;
    const promise = (async () => {
      await adapter.mount(state.street.host, { isVisible });
      if (mounting?.promise !== promise) {
        // Unmounted (layer off, provider switched) while loading. A newer
        // mount of this provider shares the adapter: tearing it down here
        // would leave that mount without a viewer.
        if (active?.id !== id && mounting?.id !== id) adapter.unmount();
        throw new Error('Street-level viewer was closed');
      }
      // Listen only once current: an outdated mount releasing the same
      // `applyPose` would otherwise unhook the mount that replaced it.
      const mounted = { id, adapter, unsubscribe: null };
      active = mounted;
      mounted.unsubscribe = adapter.onPose((pose) => {
        if (active === mounted) onPose(pose);
      });
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
   * Open an image: true once its first pose is in, false if it failed, was
   * overtaken, or `signal` fired first. An abort while the viewer mounts or
   * loads closes the photo: nothing opens for a request that was withdrawn.
   */
  async function open(
    providerId,
    imageId,
    {
      frame = true,
      signal = null,
      request = true,
      requestId = null,
      cardPhotoId = null,
      origin,
      proceed = null,
      commit = null,
      restore = null,
    } = {},
  ) {
    const entry = state.providers.get(providerId);
    if (!entry || !imageId || signal?.aborted) return false;
    if (request) requestId = ++state.photoRequests;
    const paid = entry.def.billedPerImage ? paidPhotoSurface : null;
    if (!state.street.host || (entry.def.billedPerImage && !paid)) {
      // A nearest-image lookup may have set it; nothing is loading now.
      state.street.loading = false;
      // English data: Street Level's UI translates it (translateKnown).
      state.street.error = msg('Open Context to view street-level imagery');
      notify();
      return false;
    }
    const previousImageId = state.street.imageId;
    const previousMount = active;
    const docked = commit !== null || restore !== null;
    const seq = ++openSeq;
    pendingPose = null;
    const current = () => seq === openSeq;
    const cancel = (keep) => {
      if (!current()) return;
      if (docked) {
        unmount();
        return;
      }
      if (
        !keep ||
        !photoAvailable ||
        active !== previousMount ||
        active?.id !== providerId ||
        !active.adapter.cancelOpenKeeping?.(previousImageId)
      ) {
        close();
        return;
      }
      openSeq++;
      pendingPose = null;
      Object.assign(state.street, { loading: false, opening: false });
      notify();
    };
    const onAbort = () => cancel(signal.reason === KEEP_OPEN_PHOTO);
    cancelPending = cancel;
    signal?.addEventListener('abort', onAbort, { once: true });
    // Claimed now, honoured after loading only if nothing newer took the camera.
    const ticket = frame
      ? parts.framing.begin({ keepSelection: docked })
      : null;
    Object.assign(state.street, {
      loading: true,
      opening: true,
      error: null,
      open: true,
      providerId,
      providerName: entry.def.name,
      providerLabel: entry.def.label,
    });
    notify();
    let failed = false;
    const isVisible = paid
      ? () =>
          paidPhotoSurface === paid &&
          state.street.open &&
          state.street.providerId === providerId &&
          paid.isVisible()
      : undefined;
    try {
      if (paid) {
        if (!current()) return false;
        if (proceed && proceed() !== true) {
          cancel(true);
          return false;
        }
        // Publish the opening request before the shell claims its visible surface.
        await Promise.resolve();
        if (!current()) return false;
        const visible = await paid.prepare(requestId);
        if (!current()) return false;
        if (!visible || !isVisible() || (proceed && proceed() !== true)) {
          cancel(true);
          return false;
        }
      }
      const adapter = await mount(entry, isVisible);
      if (!current()) return false;
      if (paid && (!isVisible() || (proceed && proceed() !== true))) {
        cancel(true);
        return false;
      }
      // Keep a displayed photo's fit controls until the new pose is accepted.
      if (!photoAvailable)
        state.street.renderModes = typeof adapter.setRenderMode === 'function';
      const displayId = await adapter.open(String(imageId), {
        explicit: requestId !== null,
      });
      if (!current()) return false;
      if (
        !pendingPose ||
        (displayId && String(pendingPose.imageId) !== String(displayId)) ||
        (restore && String(pendingPose.imageId) !== String(imageId))
      )
        throw new Error(msg('Image could not be opened'));
      if ((proceed && proceed() !== true) || (commit && !commit())) {
        // The dock owns the original and will restore it.
        if (docked) state.street.opening = false;
        else close();
        return false;
      }
      // Remounting can reset panorama yaw even for the same photo.
      applyPose(
        restore
          ? { ...pendingPose, ...restore.street, bearing: pendingPose.bearing }
          : pendingPose,
      );
      if (docked) {
        // Publish the dock's accepted pose before framing reads it.
        Object.assign(state.street, { opening: false, error: null });
        if (restore) {
          acceptedPhoto = restore.acceptance;
          photoAvailable = Boolean(acceptedPhoto);
        } else {
          rememberPhoto({ requestId, cardPhotoId, origin, opened: true });
        }
      }
      if (ticket) parts.framing.frame(ticket);
    } catch (error) {
      failed = true;
      if (current()) {
        if (paid && !isVisible()) cancel(true);
        else
          state.street.error =
            error?.message || msg('Image could not be opened');
      }
    } finally {
      if (cancelPending === cancel) cancelPending = null;
      signal?.removeEventListener('abort', onAbort);
      if (current()) {
        pendingPose = null;
        state.street.loading = false;
      }
      notify();
    }
    if (!current()) return false;
    // Only this open's own failure fails it: an error another request left
    // meanwhile (an empty nearest lookup) belongs to that request.
    if (failed) {
      // The attempted pose was staged separately. Keep the settled pose
      // unless the adapter reported that its displayed frame was lost.
      state.street.opening = false;
      if (!photoAvailable && state.street.imageId) {
        const empty = freshStreet();
        for (const key of POSE_KEYS) state.street[key] = empty[key];
        parts.marker.clear();
      }
      notify();
      return false;
    }
    // Accepted: still current and still wanted. Only now is the photo
    // published: announced, in the history that Nearby lists, selected.
    if (!docked) {
      Object.assign(state.street, { opening: false, error: null });
      rememberPhoto({ requestId, cardPhotoId, origin, opened: true });
    }
    selectCurrentSequence();
    notify();
    return true;
  }

  /** Close the image and stop any framing flight; the adapter stays mounted. */
  function close() {
    openSeq++;
    cancelPending = null;
    pendingPose = null;
    acceptedPhoto = null;
    photoAvailable = false;
    parts.framing.cancel();
    active?.adapter.close();
    Object.assign(state.street, freshStreet());
    parts.marker.clear();
    notify();
  }

  /** Billed providers require a surface with prepare(requestId) and isVisible(). */
  function attach(element, surface = null) {
    state.street.host = element || null;
    paidPhotoSurface = element ? surface : null;
    if (element && state.street.open) resize();
  }

  function resize() {
    active?.adapter.resize();
  }

  /** Stop a sequence playing in the open photo (adapters that play). */
  function stopPlayback() {
    active?.adapter.stopPlayback?.();
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

  /**
   * Destroy `providerId`'s viewer and leave the current photo state alone: what a
   * request leaves behind once it replaced or closed that source's photo.
   */
  function release(providerId) {
    if (active?.id !== providerId && mounting?.id !== providerId) return;
    const pending = mounting;
    mounting = null;
    active?.unsubscribe();
    (active?.adapter ?? pending?.adapter)?.unmount();
    active = null;
    acceptedPhoto = null;
    photoAvailable = false;
    notify();
  }

  return {
    attach,
    open,
    close,
    resize,
    setRenderMode,
    stopPlayback,
    cancelPending: () => cancelPending?.(true),
    unmount,
    release,
    reaffirm(cardPhotoId) {
      rememberPhoto({
        requestId: ++state.photoRequests,
        cardPhotoId,
        opened: true,
      });
      notify();
    },
    acceptedPhoto: () => (photoAvailable ? acceptedPhoto : null),
  };
}
