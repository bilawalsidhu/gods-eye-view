import { createState } from './state.js';
import { createMarker } from './marker.js';
import { createCameraFraming } from './cameraFraming.js';
import { createCredits } from './credits.js';
import { creditFromMarkup } from '../../render/creditMarkup.js';
import { createPickRouter } from './pickRouter.js';
import { createSelection } from './selection.js';
import { createViewerHost, KEEP_OPEN_PHOTO } from './viewerHost.js';
import {
  createPhotoHistory,
  nearPointId,
  parseNearPointId,
  parsePhotoId,
  photoId,
} from './photos.js';
import { subscribePhotoViewers } from './photoViewers.js';
import { filtersOf, requiresKeyIdFor, validateProviders } from './registry.js';
import { normalizeFilter, resolveFilter, sameFilter } from './filter.js';
import { worldTimeFor } from '../../time/worldClock.js';
import { decodeParams, encodeParams } from './params.js';
import {
  composeUIState,
  keyAlternatives,
  summarizeCoverage,
} from './uiState.js';
import {
  canvasSize,
  groundUnderCamera,
  metresBetween,
  viewCentre,
} from './view.js';
import { toLonLatH } from '../../geo/index.js';
import { findCamera, findQuery } from '../../render/rendererOf.js';
import { isPickedWorldPosition } from '../../data/scenePick.js';
import { createGroundClick, groundClickHeightOk } from './groundClick.js';
import { msg, t, translateKnown } from '../../i18n/index.js';
import {
  AIM_AT_GROUND_MESSAGE,
  keyStatusLabel,
  NEAREST_RADIUS_M,
  NEAREST_RADIUS_MAX_M,
  POSITION_PICK_ID,
  STREET_LEVEL_LAYER_ID,
} from './policy.js';

export { STREET_LEVEL_LAYER_ID } from './policy.js';

/** Longest wait for a provider's key status; past it, the provider decides. */
const KEY_STATUS_TIMEOUT_MS = 10_000;
/** Re-measures of a ground not loaded yet (Google 3D), a second apart. */
const GROUND_RETRY_LIMIT = 5;
const GROUND_RETRY_MS = 1000;
/**
 * An armed point stays the OPEN button's target while the view centre is
 * this close to it (m); a user who moved on opens what the view shows now.
 */
const ARMED_REACH_M = 1000;

/**
 * The Street Level layer over imagery providers (contract in registry.js).
 * The core owns what they share: the filter and switches, the photo viewer
 * host, the position marker, the click handler and nearest-image lookups.
 * Providers own coverage, sequences and their viewer. One source is lit at
 * a time. It reaches the camera, queries and frames through the renderer's
 * ports; given a Cesium viewer with no renderer bound,
 * the caller loads the package's `./render/cesium/unbound` export first.
 * @param {{providers: Array<import('./registry.js').StreetLevelProvider>, services?: object}} options
 */
// "Since N days" counts back from the world time.
const streetLevelTime = worldTimeFor(STREET_LEVEL_LAYER_ID);

export function createStreetLevelLayer({
  providers: definitions,
  services = {},
}) {
  const defs = validateProviders(definitions);
  const state = createState({ services });
  const parts = {};
  const context = { state, parts };
  parts.credits = createCredits();
  parts.marker = createMarker(context);
  parts.framing = createCameraFraming(context);
  parts.photos = createPhotoHistory();
  parts.router = createPickRouter(() => state.providers.values(), {
    positionId: POSITION_PICK_ID,
  });
  parts.viewerHost = createViewerHost(context);
  parts.hasSelectedSequence = () =>
    [...state.providers.values()].some(
      (entry) => entry.instance.sequenceStats?.()?.selectedId,
    );
  parts.clearSequences = () => {
    for (const entry of state.providers.values())
      entry.instance.clearSequence?.();
  };
  parts.selection = createSelection(context);
  parts.openAtGround = createGroundClick({
    state,
    openNearest: (point, options) => layer.openNearest(point, options),
    isAvailable: (entry) => providerAvailable(entry),
  });

  /** Who presents the layer row's filters (the UI), and the panels' row invalidation. */
  let rowControlsPresenter = null;
  let rowControlsListener = null;

  let notifyQueued = false;
  function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      const snapshot = getUIState();
      for (const listener of [...state.listeners]) {
        try {
          listener(snapshot);
        } catch (error) {
          console.warn('[Data:StreetLevel] listener error:', error);
        }
      }
      // The Data Layers row repaints its filters from the fresh state, but
      // not for a photo's pose: dragging a panorama poses every frame.
      const row = rowSignature(snapshot);
      if (row === lastRowSignature) return;
      lastRowSignature = row;
      rowControlsListener?.();
    });
  }
  let lastRowSignature = '';
  /** What the row shows: everything but the open photo's pose. */
  function rowSignature(snapshot) {
    const { street, ...rest } = snapshot;
    return JSON.stringify([rest, street.open, street.loading, street.error]);
  }
  state.notify = notify;

  function providerContext(entry) {
    return Object.freeze({
      services: state.services,
      /** Resolved against now, so "since N days" keeps up with the clock. */
      getFilter: () => resolveFilter(state.filter, streetLevelTime()),
      /** The layer and this provider's switch are both on. */
      isActive: () => state.enabled && entry.on,
      notify,
      actions: {
        /** `{frame: false}` opens it without moving the camera. */
        openImage: (imageId, options) =>
          openImage(entry.def.id, imageId, options),
        /** This provider's image nearest a point the user picked on the map. */
        openNearest: (point, sequenceId = null) =>
          layer.openNearest(point, {
            providerIds: [entry.def.id],
            frame: false,
            sequenceId,
          }),
        cancelNearest: () => {
          const replacement = pendingDockReplacement();
          if (replacement) {
            if (!replacement.restore) layer.cancelDockedPhoto();
            return;
          }
          releaseCardPhotoOwner(undefined, KEEP_OPEN_PHOTO);
          abortNearest();
          parts.viewerHost.cancelPending();
          state.street.loading = false;
          notify();
        },
        /**
         * Show a provider error, or withdraw it (null). A withdrawal clears
         * only this provider's own error, never a newer one from elsewhere.
         */
        reportError: (message, imageId = null) => {
          if (
            imageId &&
            (entry.def.id !== state.street.providerId ||
              imageId !== state.street.imageId)
          )
            return;
          if (message) {
            state.street.error = entry.reportedError = message;
          } else {
            if (!entry.reportedError) return;
            if (state.street.error === entry.reportedError)
              state.street.error = null;
            entry.reportedError = null;
          }
          notify();
        },
      },
    });
  }

  /** `def` if its key is ready, else the first keyless provider not refused. */
  function keylessInstead(def, refused = () => false) {
    if (def.keyReady?.() !== false) return def;
    return defs.find((d) => !d.requiresKeyId && !refused(d.id)) || def;
  }

  // One source at a time: the first provider that defaults on. Without its
  // key, the first keyless source instead, so a fresh keyless install opens
  // on coverage rather than KEY REQUIRED.
  const preferred = defs.find((def) => def.defaultOn !== false);
  const startsOn = preferred && keylessInstead(preferred);
  for (const def of defs) {
    const entry = {
      def,
      instance: null,
      on: def === startsOn,
      status: null,
      /** The status request in flight; overlapping checks share it. */
      statusCheck: null,
      /** The error this provider last reported, until it withdraws it. */
      reportedError: null,
    };
    entry.instance = def.create(providerContext(entry));
    state.providers.set(def.id, entry);
  }

  let mapStack = null;
  let unsubscribeMapStack = null;

  /** Usable only on its map stack (Google's terms: Street View on Google 3D only). */
  function providerAvailable(entry) {
    const required = entry.def.requiresMapStack;
    return !required || mapStack?.getActiveId?.() === required;
  }

  /** Leaving a provider's map stack closes its image, viewer and credit. */
  function syncProviderAvailability() {
    const loading = state.providers.get(cardPhotoRequest?.providerId);
    if (loading && !providerAvailable(loading)) releaseCardPhotoOwner();
    const owner = state.providers.get(state.street.providerId);
    if (state.street.open && owner && !providerAvailable(owner)) {
      if (dockReplacement) dockReplacement.controller.abort();
      else layer.closeViewer();
    }
    // An armed lookup for a source whose map left dies too.
    const armedFor = state.street.armed?.providerIds?.map((id) =>
      state.providers.get(id),
    );
    if (armedFor?.some((entry) => entry && !providerAvailable(entry)))
      state.street.armed = null;
    for (const entry of state.providers.values()) {
      if (!entry.def.requiresMapStack) continue;
      if (state.enabled && entry.on && providerAvailable(entry))
        parts.credits.show(state.viewer, entry.def);
      else {
        parts.credits.hide(state.viewer, entry.def);
        parts.viewerHost.unmount(entry.def.id);
      }
    }
    remeasureGround();
    notify();
  }

  let groundRetry = null;
  let groundRetries = 0;
  function cancelGroundRetry() {
    clearTimeout(groundRetry);
    groundRetry = null;
  }

  /**
   * Whether a ground click can open an image: the camera is at street zoom.
   * Under Google 3D the ground is unknown until its tiles load, so an unknown
   * ground is measured again a few times instead of waiting for the next move.
   */
  function syncGroundClickReady() {
    cancelGroundRetry();
    const ready = state.enabled && groundClickHeightOk(state.viewer);
    if (
      state.enabled &&
      !ready &&
      groundRetries < GROUND_RETRY_LIMIT &&
      groundUnderCamera(state.viewer) === null
    ) {
      groundRetries++;
      groundRetry = setTimeout(syncGroundClickReady, GROUND_RETRY_MS);
    }
    if (ready === state.groundClickReady) return;
    state.groundClickReady = ready;
    notify();
  }

  /** A camera move or a map change measures afresh. */
  function remeasureGround() {
    groundRetries = 0;
    syncGroundClickReady();
  }

  let removeCameraListener = null;
  function watchCamera(viewer) {
    removeCameraListener?.();
    removeCameraListener =
      (viewer && findCamera(viewer)?.on('moveEnd', remeasureGround)) || null;
  }

  const activeEntries = () =>
    [...state.providers.values()].filter((entry) => entry.on);

  /** A provider's key status. A hung server must not hold LOADING, or the next check, forever. */
  function checkStatus(entry) {
    entry.statusCheck ||= (async () => {
      try {
        entry.status = await entry.instance.status({
          signal: AbortSignal.timeout(KEY_STATUS_TIMEOUT_MS),
        });
      } catch {
        entry.status = null;
      }
      notify();
    })().finally(() => {
      entry.statusCheck = null;
    });
    return entry.statusCheck;
  }

  function activate(entry) {
    if (!state.viewer) return;
    entry.instance.activate(state.viewer);
    // Without a known key, a switch-on asks again: the server may be back,
    // or have a key now.
    if (entry.status?.configured !== true) checkStatus(entry);
    if (providerAvailable(entry)) parts.credits.show(state.viewer, entry.def);
  }

  /** Sources whose open photo a replacing request keeps up while it switches them off. */
  const heldViewers = new Map();

  function deactivate(entry) {
    if (cardPhotoRequest?.providerId === entry.def.id) releaseCardPhotoOwner();
    if (!heldViewers.has(entry.def.id)) parts.viewerHost.unmount(entry.def.id);
    entry.instance.deactivate();
    parts.credits.hide(state.viewer, entry.def);
  }

  /** The nearest-image lookup in flight; any newer user action aborts it. */
  let nearestLookup = null;
  // The Context card that asked for an image or a nearby lookup owns its
  // cancellation until that request settles or a new route takes over.
  let cardPhotoRequest = null;

  function releaseCardPhotoOwner(signal, reason) {
    if (!cardPhotoRequest || cardPhotoRequest.signal === signal) return;
    const previous = cardPhotoRequest;
    cardPhotoRequest = null;
    previous.controller.abort(reason);
  }

  let readDockedPhoto = null;
  let canPresentDockedPhoto = null;
  let dockReplacement = null;
  let dockFallback = null;
  let dockRequestGeneration = 0;
  // A short word for the dock after a replacement it could not show:
  // 'failed' (the original came back) or 'restoring' (a pick was refused
  // while the original reloads). It goes with the next pick, or by itself.
  let dockNotice = null;
  let dockNoticeTimer = 0;
  const DOCK_NOTICE_MS = 4_000;

  function setDockNotice(kind) {
    clearTimeout(dockNoticeTimer);
    dockNoticeTimer = 0;
    if (!kind && !dockNotice) return;
    dockNotice = kind;
    if (kind)
      dockNoticeTimer = setTimeout(() => {
        dockNoticeTimer = 0;
        dockNotice = null;
        notify();
      }, DOCK_NOTICE_MS);
    notify();
  }

  function pendingDockReplacement() {
    return dockReplacement?.committed ? null : dockReplacement;
  }

  function readDockedStreet() {
    const id = readDockedPhoto?.()?.identity.id;
    if (!id) return null;
    const previous =
      pendingDockReplacement()?.original ??
      dockFallback?.street ??
      state.street;
    return photoId(previous.providerId, previous.imageId) === id
      ? previous
      : null;
  }

  async function withinPhotoDeadline(controller, signal, ms, run) {
    if (signal.aborted) return false;
    if (ms <= 0) {
      controller.abort();
      return false;
    }
    let cancelled;
    const aborted = new Promise((resolve) => {
      cancelled = () => resolve(false);
      signal.addEventListener('abort', cancelled, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await Promise.race([run(signal), aborted]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
    }
  }

  function abandonDockReplacement() {
    dockRequestGeneration++;
    const old = dockReplacement;
    dockReplacement = null;
    dockFallback = null;
    old?.controller.abort();
    old?.restore?.abort();
    setDockNotice(null);
  }

  async function runPhotoRequest(
    original,
    run,
    { signal: callerSignal = null, proceed = null, id, onFailure } = {},
  ) {
    if (callerSignal?.aborted) return false;
    if (!original) return run({ signal: callerSignal, proceed, dock: null });
    if (canPresentDockedPhoto?.() === false) return false;
    const previous = pendingDockReplacement();
    const owner = readDockedPhoto?.();
    const originalId = photoId(original.providerId, original.imageId);
    const acceptance =
      previous?.acceptance ??
      dockFallback?.acceptance ??
      parts.viewerHost.acceptedPhoto();
    if (previous?.restore) {
      setDockNotice('restoring');
      return false;
    }
    setDockNotice(null);
    const request = {
      id,
      original: {
        ...original,
        position: original.position && { ...original.position },
      },
      acceptance: acceptance?.id === originalId ? acceptance : null,
      controller: new AbortController(),
      // Successive replacements share a deadline. Reserve time to reload
      // the original using the same single viewer.
      deadline: previous?.deadline ?? Date.now() + 10_000,
      touchedViewer: previous?.touchedViewer ?? false,
      restore: null,
      committed: false,
      // Set by Cancel: the person withdrew it, so the dock says nothing.
      cancelled: false,
    };
    dockRequestGeneration++;
    dockReplacement = request;
    previous?.controller.abort();
    const canCommit = () =>
      dockReplacement === request &&
      readDockedPhoto?.() === owner &&
      canPresentDockedPhoto?.() !== false;
    // Whether the original still comes back if the replacement does not
    // show: while the dock holds it, and also once the dock let it go
    // without taking another (Show here moves it to its card). A dock that
    // closed with the photo's card gone closes the photo itself
    // (closePhoto), which ends this request.
    const keepsOriginal = () => {
      const now = readDockedPhoto?.();
      return now === owner || !now;
    };
    notify();
    const signal = callerSignal
      ? AbortSignal.any([request.controller.signal, callerSignal])
      : request.controller.signal;
    // Publish the replacement once its frame and pose are ready. A photo
    // event may synchronously advance the card that owns the dock.
    request.commit = () => {
      if (!canCommit() || signal.aborted || Date.now() >= request.deadline)
        return false;
      request.committed = true;
      dockFallback = null;
      return true;
    };
    try {
      await withinPhotoDeadline(
        request.controller,
        signal,
        request.deadline - Date.now(),
        (signal) =>
          run({
            signal,
            proceed: () => canCommit() && proceed?.() !== false,
            dock: request,
          }),
      );
      if (request.committed) return true;
      if (dockReplacement !== request) return false;
      const { error, nearestOutcome } = state.street;
      onFailure?.({ error, nearestOutcome });
      releaseCardPhotoOwner();
      abortNearest();
      const stillOpen =
        state.street.open &&
        photoId(state.street.providerId, state.street.imageId) === originalId;
      if (request.touchedViewer || (!dockFallback && !stillOpen)) {
        parts.viewerHost.unmount();
        const { providerId, imageId } = request.original;
        if (state.enabled && keepsOriginal()) {
          const entry = state.providers.get(providerId);
          let restored = false;
          if (
            entry?.on &&
            providerAvailable(entry) &&
            !entry.def.billedPerImage
          ) {
            const restore = new AbortController();
            request.restore = restore;
            // The dock says it is restoring and no longer offers Cancel.
            notify();
            const deadline = Math.min(
              Date.now() + 4_000,
              request.deadline + 4_000,
            );
            restored = await withinPhotoDeadline(
              restore,
              restore.signal,
              deadline - Date.now(),
              (restoreSignal) =>
                parts.viewerHost.open(providerId, imageId, {
                  frame: false,
                  signal: restoreSignal,
                  request: false,
                  restore: {
                    street: request.original,
                    acceptance: request.acceptance,
                  },
                  proceed: () =>
                    keepsOriginal() &&
                    entry.on &&
                    providerAvailable(entry) &&
                    Date.now() < deadline,
                }),
            );
          }
          if (dockReplacement !== request) return false;
          // A provider can be unavailable even for the original photo.
          // Keep its identity and still without leaving the dock busy.
          if (restored) dockFallback = null;
          else {
            parts.viewerHost.unmount();
            if (readDockedPhoto?.() === owner)
              dockFallback = {
                street: request.original,
                acceptance: request.acceptance,
              };
            // Out of the dock, its card says the photo did not come back.
            else state.street.error = msg('Image could not be opened');
          }
        }
      } else if (stillOpen) {
        Object.assign(state.street, request.original, { loading: false });
      }
      // The assistant reports its own failures (onFailure); a pick from a
      // list or a pin hears it here.
      if (
        !onFailure &&
        !request.cancelled &&
        !callerSignal?.aborted &&
        readDockedPhoto?.() === owner
      )
        setDockNotice('failed');
      return false;
    } finally {
      if (dockReplacement === request) {
        dockReplacement = null;
        notify();
      }
    }
  }

  function abortNearest() {
    nearestLookup?.abort();
    nearestLookup = null;
  }

  /** Close the image and deselect its sequence on the map. */
  function closeViewer() {
    abandonDockReplacement();
    releaseCardPhotoOwner();
    abortNearest();
    parts.viewerHost.close();
    parts.clearSequences();
  }

  /**
   * Ground under the screen centre: the drawn surface, else the ellipsoid;
   * null for sky, undefined when it cannot aim.
   */
  function screenCentreGround() {
    const { width, height } = canvasSize(state.viewer);
    const query = state.viewer ? findQuery(state.viewer) : null;
    if (!query || !width || !height) return undefined;
    const [x, y] = [width / 2, height / 2];
    // A pick that fails is a miss, as the ellipsoid's is.
    const attempt = (pick) => {
      try {
        const position = pick();
        return isPickedWorldPosition(position) ? position : null;
      } catch {
        return null;
      }
    };
    const position =
      attempt(() => query.pickPosition(x, y)) ??
      attempt(() => query.pickEllipsoid(x, y));
    const ground = position && toLonLatH(position);
    return ground ? { lon: ground.lon, lat: ground.lat } : null;
  }

  /** `frame: false` keeps the camera where it is (the user picked the spot). */
  function openImage(providerId, imageId, options = {}) {
    const entry = state.providers.get(providerId);
    if (!state.enabled || !entry) return Promise.resolve(false);
    const original = readDockedStreet();
    const cursorStep = options.request === false && options.requestId == null;
    if (
      cursorStep &&
      (cardPhotoRequest ||
        nearestLookup ||
        pendingDockReplacement() ||
        (original && providerId !== original.providerId))
    )
      return Promise.resolve(false);
    return runPhotoRequest(
      original,
      (owner) =>
        openRequestedImage(
          entry,
          imageId,
          {
            ...options,
            frame: original && cursorStep ? false : options.frame,
          },
          owner,
        ),
      options,
    );
  }

  function openRequestedImage(
    entry,
    imageId,
    { frame = true, request = true, requestId = null, origin },
    { signal, proceed, dock },
  ) {
    if (!state.enabled || signal?.aborted || (!entry.on && !dock))
      return Promise.resolve(false);
    if (!dock) abandonDockReplacement();
    releaseCardPhotoOwner(signal);
    if (request || requestId !== null) {
      abortNearest();
      state.street.armed = null;
    }
    if (!providerAvailable(entry)) {
      state.street.loading = false;
      state.street.error = unavailableReason(entry);
      notify();
      return Promise.resolve(false);
    }
    if (dock) {
      if (dock !== pendingDockReplacement()) return Promise.resolve(false);
      dock.explicit = request || requestId !== null;
      if (state.street.host) dock.touchedViewer = true;
    }
    return parts.viewerHost.open(entry.def.id, imageId, {
      frame,
      signal,
      requestId,
      origin,
      commit: dock?.commit,
      proceed,
      request,
      cardPhotoId:
        signal && signal === cardPhotoRequest?.signal
          ? cardPhotoRequest.id
          : null,
    });
  }

  async function openRequestedNearest(
    point,
    {
      providerIds = null,
      frame = true,
      aim = 'view',
      radiusM = null,
      armed: useArmed = true,
      replace = false,
      sequenceId = null,
      origin,
    },
    owner,
  ) {
    const { signal: callerSignal, proceed, dock } = owner;
    if (!dock) abandonDockReplacement();
    state.street.nearestOutcome = null;
    state.street.nearestRefusal = null;
    // An OPEN press after a link armed a lookup opens what the link asked;
    // any other lookup is a new request and drops the armed one.
    const armed = useArmed ? state.street.armed : null;
    if (useArmed) state.street.armed = null;
    const closeReplaced = () => {
      if (!dock && replace && state.street.open) closeViewer();
    };
    if (!point && aim === 'screen-centre' && armed) {
      // OPEN promises the view centre: the link's spot only while the view
      // still shows it, or when the view cannot be picked.
      const centre = armed.point ? screenCentreGround() : null;
      if (!armed.point) radiusM ??= armed.radiusM;
      else if (
        centre === undefined ||
        (centre && metresBetween(centre, armed.point) <= ARMED_REACH_M)
      ) {
        point = armed.point;
        radiusM ??= armed.radiusM;
      }
    }
    const radius = Number.isFinite(radiusM)
      ? Math.min(NEAREST_RADIUS_MAX_M, Math.max(1, radiusM))
      : NEAREST_RADIUS_M;
    let view = point;
    if (!view && aim === 'screen-centre') {
      view = screenCentreGround();
      if (view === null) {
        releaseCardPhotoOwner(callerSignal, KEEP_OPEN_PHOTO);
        abortNearest();
        parts.viewerHost.cancelPending();
        closeReplaced();
        state.street.loading = false;
        state.street.error = AIM_AT_GROUND_MESSAGE;
        state.street.nearestOutcome = 'sky';
        notify();
        return false;
      }
    }
    view ||= viewCentre(state.viewer);
    if (!Number.isFinite(view?.lat) || !Number.isFinite(view?.lon))
      return false;
    releaseCardPhotoOwner(callerSignal, KEEP_OPEN_PHOTO);
    abortNearest();
    parts.viewerHost.cancelPending();
    // The lookup is the request; the photo it opens is not a second one.
    const requestId = ++state.photoRequests;
    const lookup = new AbortController();
    nearestLookup = lookup;
    const { signal } = lookup;
    const onCallerAbort = () => lookup.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const retired = () => {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      // A newer lookup owns the panel, its spinner and its error.
      if (nearestLookup !== lookup) return false;
      nearestLookup = null;
      if (state.street.loading) {
        state.street.loading = false;
        notify();
      }
      return false;
    };
    state.street.loading = true;
    state.street.error = null;
    notify();
    let lastError = null;
    const asked = (entry) =>
      (!providerIds || providerIds.includes(entry.def.id)) &&
      typeof entry.instance.nearestImage === 'function' &&
      providerAvailable(entry);
    const explicitDockSource = dock && providerIds?.length > 0;
    const entries = (
      explicitDockSource ? listedEntries() : activeEntries()
    ).filter(asked);
    for (const entry of entries) {
      let imageId = null;
      try {
        imageId = await entry.instance.nearestImage(
          { lat: view.lat, lon: view.lon },
          {
            signal,
            ...(radius === NEAREST_RADIUS_M ? {} : { radiusM: radius }),
            ...(sequenceId ? { sequenceId } : {}),
          },
        );
      } catch (error) {
        if (callerSignal?.aborted) return retired();
        // Overtaken: whatever replaced it owns the panel, errors included.
        if (signal.aborted) return retired();
        // One provider failing (no key, offline) must not hide the others.
        lastError = error;
        continue;
      }
      if (callerSignal?.aborted) return retired();
      if (signal.aborted) return retired();
      if (!state.enabled) break;
      // Switched off, or its map left, while it looked: try the next.
      if (
        !imageId ||
        (!entry.on && !explicitDockSource) ||
        !providerAvailable(entry)
      )
        continue;
      if (proceed && proceed() !== true) return retired();
      nearestLookup = null;
      callerSignal?.removeEventListener('abort', onCallerAbort);
      // A sequence playing in the replaced photo would step past this one.
      if (state.street.open) parts.viewerHost.stopPlayback();
      // The caller's signal and its proceed() still count while the
      // viewer mounts and loads.
      const imageOptions = { frame, requestId, request: false, origin };
      // A lookup can start on a card and finish after its photo was docked.
      const newlyDocked = !dock && readDockedStreet();
      if (newlyDocked)
        return runPhotoRequest(
          newlyDocked,
          (next) => openRequestedImage(entry, imageId, imageOptions, next),
          owner,
        );
      return openRequestedImage(entry, imageId, imageOptions, owner);
    }
    callerSignal?.removeEventListener('abort', onCallerAbort);
    // Replaced while it looked: the panel is the newer lookup's.
    if (nearestLookup !== lookup) return false;
    // Given up by its caller: the panel stays as it was.
    if (proceed && proceed() !== true) return retired();
    nearestLookup = null;
    closeReplaced();
    // Switched off while it looked: nothing to open, nothing to report.
    const stillOn = entries.some(
      (entry) => (entry.on || explicitDockSource) && providerAvailable(entry),
    );
    if (state.enabled && stillOn) {
      if (lastError?.message) {
        state.street.error = lastError.message;
      } else {
        if (!lastError) state.street.nearestOutcome = 'empty';
        const key = point
          ? msg('No street-level imagery within {radius} m of that point')
          : msg('No street-level imagery within {radius} m of the view centre');
        const text = t(key, { radius });
        state.street.error = text;
        state.street.nearestRefusal = { key, radius, text };
      }
    }
    state.street.loading = false;
    notify();
    return false;
  }

  function unavailableReason(entry) {
    return t('{name} needs the Google 3D map: choose it under MAP SOURCE', {
      name: translateKnown(entry.def.name),
    });
  }

  /** One imagery source at a time: lighting a provider darkens the others. */
  function setProviderEnabled(providerId, on) {
    const entry = state.providers.get(providerId);
    if (!entry) return false;
    const before = litIds();
    const next = on !== false;
    if (next)
      for (const other of state.providers.values())
        if (other !== entry && other.on) switchProvider(other, false);
    switchProvider(entry, next);
    sourceChanged(before);
    notify();
    return true;
  }

  const litIds = () =>
    [...state.providers]
      .filter(([, entry]) => entry.on)
      .map(([id]) => id)
      .join();

  /**
   * After a chip, voice or a link changed the lit source: a lookup still
   * running and its spinner or error were about the source switched away
   * (an open photo keeps its own state).
   */
  function sourceChanged(before) {
    if (litIds() === before) return;
    dockRequestGeneration++;
    dockReplacement?.controller.abort();
    abortNearest();
    if (state.street.open) return;
    state.street.error = null;
    state.street.loading = false;
  }

  function switchProvider(entry, on) {
    if (entry.on === on) return;
    entry.on = on;
    // A lookup armed for this source dies with it.
    if (!on && state.street.armed?.providerIds?.includes(entry.def.id))
      state.street.armed = null;
    if (!state.enabled) return;
    if (on) activate(entry);
    else deactivate(entry);
  }

  /**
   * The one provider params leave lit: of those they switch on, the one
   * already on (reapplying never flips), else the first; with none, the lit
   * one unless they switch it off.
   */
  function litByParams(switches) {
    const asked = [...state.providers.keys()].filter(
      (id) => switches.get(id) === true,
    );
    const current = [...state.providers]
      .filter(([, entry]) => entry.on)
      .map(([id]) => id);
    if (asked.length)
      return asked.find((id) => current.includes(id)) ?? asked[0];
    return current.find((id) => switches.get(id) !== false) ?? null;
  }

  function setCoverageFilter(next) {
    const filter = normalizeFilter(next, state.filter);
    if (sameFilter(filter, state.filter)) return;
    state.filter = filter;
    const resolved = resolveFilter(filter, streetLevelTime());
    for (const entry of state.providers.values())
      entry.instance.setFilter(resolved);
    notify();
  }

  /** The hint a ground-click provider shows, or the provider's own. */
  function hintFor(entry, stats) {
    if (entry.def.groundClick && stats.hint && !state.groundClickReady)
      // No-break spaces keep a provider name (Google Street View) on one line.
      return t('zoom in to a street to open {name}', {
        name: translateKnown(entry.def.name).replace(/ /g, '\u00a0'),
      });
    return stats.hint || '';
  }

  /** Providers usable on this map stack; the others are not shown at all. */
  const listedEntries = () =>
    [...state.providers.values()].filter((entry) => providerAvailable(entry));

  function providerSnapshots(includeRecordRevision = false) {
    return listedEntries().map((entry) => {
      const stats = entry.instance.coverageStats();
      return {
        id: entry.def.id,
        name: entry.def.name,
        label: entry.def.label,
        on: entry.on,
        configured: entry.status ? entry.status.configured === true : null,
        // A rejected key gates the provider exactly like a missing one.
        keyRequired: stats.keyRequired === true || stats.keyRejected === true,
        keyRejected: stats.keyRejected === true,
        requiresKeyId: entry.def.requiresKeyId || null,
        loading: stats.loading === true,
        count: stats.count || 0,
        ...(includeRecordRevision && { drawnVersion: stats.drawnVersion ?? 0 }),
        hint: hintFor(entry, stats),
        error: stats.error || null,
        color: entry.def.colors.coverage,
        coverageLabel: entry.def.coverageLabel || null,
        sinceBasis: entry.def.sinceBasis === 'upload' ? 'upload' : 'capture',
        groundClick: entry.def.groundClick === true,
        ...(entry.def.billedPerImage === true && { billed: true }),
        filters: [...filtersOf(entry.def)],
      };
    });
  }

  /** The selected sequence; the provider showing the open image answers first. */
  function sequenceSnapshot() {
    const owner = state.providers.get(state.street.providerId);
    const candidates = owner
      ? [owner, ...[...state.providers.values()].filter((e) => e !== owner)]
      : [...state.providers.values()];
    for (const entry of candidates) {
      const stats = entry.instance.sequenceStats?.();
      if (stats?.selectedId || stats?.loading || stats?.error)
        return {
          providerId: entry.def.id,
          selectedId: stats.selectedId || null,
          images: stats.images || 0,
          loading: stats.loading === true,
          error: stats.error || null,
        };
    }
    return {
      providerId: null,
      selectedId: null,
      images: 0,
      loading: false,
      error: null,
    };
  }

  function acceptedPhoto() {
    const replacement = pendingDockReplacement();
    const accepted = parts.viewerHost.acceptedPhoto();
    // During a dock replacement only the untouched original is confirmed.
    if (!replacement) return accepted;
    return !replacement.touchedViewer &&
      accepted?.id === replacement.acceptance?.id
      ? accepted
      : null;
  }

  function getUIState() {
    const replacement = pendingDockReplacement();
    const pendingPaid =
      replacement?.explicit === true &&
      !replacement.restore &&
      state.street.opening === true &&
      state.providers.get(state.street.providerId)?.def.billedPerImage === true;
    const { host, ...street } =
      replacement?.original ?? dockFallback?.street ?? state.street;
    const ui = composeUIState({
      enabled: state.enabled,
      groundClickReady: state.groundClickReady,
      filter: state.filter,
      providers: providerSnapshots(),
      street: replacement
        ? { ...street, loading: true, ...(pendingPaid && { opening: true }) }
        : street,
      sequence: sequenceSnapshot(),
    });
    // The lit source cannot run on this map: say so, not a blank panel.
    const stranded = [...state.providers.values()].find(
      (entry) => entry.on && !providerAvailable(entry),
    );
    if (stranded && !ui.providers.some((p) => p.on))
      ui.coverage.hint = unavailableReason(stranded);
    if (replacement) ui.dockPhotoLoading = true;
    // Reloading the original after a replacement failed or was cancelled:
    // nothing to cancel, and the dock stays busy until it is back.
    if (replacement?.restore) ui.dockPhotoRestoring = true;
    if (dockFallback) ui.dockPhotoUnavailable = true;
    if (dockNotice) ui.dockPhotoNotice = dockNotice;
    ui.photoRequests = state.photoRequests;
    ui.billedPhoto =
      pendingPaid ||
      state.providers.get(street.providerId)?.def.billedPerImage === true;
    ui.acceptedPhoto = acceptedPhoto();
    return ui;
  }

  const layer = {
    id: STREET_LEVEL_LAYER_ID,
    name: 'Street Level',
    icon: '📷',
    /** The sources usable on this map (Street View only on Google 3D). */
    get source() {
      return listedEntries()
        .map((entry) => entry.def.name)
        .join(' · ');
    },
    updateInterval: 0,
    statsRefreshInterval: 1000,
    /** The key the switched-on providers share (or null), for the layer row. */
    get requiresKeyId() {
      const on = activeEntries();
      return requiresKeyIdFor(on.length ? on.map((entry) => entry.def) : defs);
    },
    /** Registered providers, in chip order. */
    providerIds: defs.map((def) => def.id),
    /** The map stack a provider needs (`requiresMapStack`), or null for any. */
    requiredMapStack(providerId) {
      const def = defs.find((entry) => entry.id === providerId);
      return def?.requiresMapStack || null;
    },
    /**
     * A provider's name and key state on any map (the panel lists a provider
     * only on the map it needs). `configured` is null until its status call
     * answers; `keyRequired` covers a missing or refused key.
     */
    providerStatus(providerId) {
      const entry = state.providers.get(providerId);
      if (!entry) return null;
      const stats = entry.instance.coverageStats();
      return {
        id: entry.def.id,
        name: entry.def.name,
        on: entry.on,
        configured: entry.status ? entry.status.configured === true : null,
        keyRequired: stats.keyRequired === true || stats.keyRejected === true,
        keyRejected: stats.keyRejected === true,
        groundClick: entry.def.groundClick === true,
        billed: entry.def.billedPerImage === true,
        available: providerAvailable(entry),
        error: stats.error || null,
      };
    },
    getSourceAvailability() {
      const available = defs.length > 0;
      return {
        available,
        source: STREET_LEVEL_LAYER_ID,
        reason: available
          ? null
          : 'No street-level imagery providers configured',
      };
    },

    init(viewer, { panel = null } = {}) {
      // The panels' handle: the row repaints through it.
      rowControlsListener = panel ? () => panel.invalidate() : null;
      state.viewer = viewer;
      parts.marker.ensure(viewer);
      parts.marker.setVisible(false);
      for (const entry of state.providers.values()) {
        entry.instance.init(viewer);
        checkStatus(entry);
      }
      console.log('[Data:StreetLevel] Initialized');
    },

    enable(viewer) {
      state.enabled = true;
      state.viewer = viewer;
      parts.marker.setVisible(true);
      parts.selection.install(viewer);
      for (const entry of activeEntries()) activate(entry);
      watchCamera(viewer);
      remeasureGround();
      notify();
    },

    disable() {
      state.enabled = false;
      abandonDockReplacement();
      releaseCardPhotoOwner();
      abortNearest();
      removeCameraListener?.();
      removeCameraListener = null;
      cancelGroundRetry();
      parts.viewerHost.unmount();
      parts.photos.clear();
      for (const entry of state.providers.values()) entry.instance.deactivate();
      syncGroundClickReady();
      parts.credits.hideAll(state.viewer);
      parts.selection.uninstall();
      parts.marker.setVisible(false);
      notify();
    },

    async update() {
      return state.enabled;
    },

    destroy(viewer = state.viewer) {
      rowControlsListener = null;
      layer.disable();
      for (const entry of state.providers.values())
        entry.instance.destroy(viewer);
      parts.marker.destroy(viewer);
      parts.framing.attachNavigation(null);
      unsubscribeMapStack?.();
      unsubscribeMapStack = null;
      mapStack = null;
      state.listeners.clear();
      state.viewer = null;
    },

    getStats() {
      // The lifecycle polls this every second: summarise, don't snapshot.
      // English data: the layer panel translates these through translateKnown.
      const snapshots = providerSnapshots(true);
      const coverage = summarizeCoverage(snapshots);
      const keyLabel = keyStatusLabel(coverage);
      let loadingLabel = '';
      if (keyLabel) loadingLabel = keyLabel;
      else if (coverage.loading) loadingLabel = msg('loading coverage...');
      else if (coverage.hint && state.enabled) loadingLabel = coverage.hint;
      return {
        source: layer.source,
        count: coverage.count,
        recordsRevision: [
          parts.photos.revision,
          ...snapshots
            .filter((p) => p.on)
            .map((p) => p.id + ':' + p.drawnVersion),
        ].join('|'),
        loading: coverage.loading,
        keyRequired: coverage.keyRequired,
        keyAlternatives: keyAlternatives(snapshots),
        // A rejected key's message names the fix; a missing one says so.
        error: keyLabel
          ? coverage.keyRejected
            ? coverage.error || keyLabel
            : keyLabel
          : coverage.error,
        loadingLabel,
      };
    },

    /** A photo frames itself only if it still owns the camera once loaded. */
    attachNavigation(navigation) {
      parts.framing.attachNavigation(navigation);
    },

    /** The application map stack; Street View is usable only on Google 3D. */
    attachMapStackController(controller) {
      unsubscribeMapStack?.();
      mapStack = controller || null;
      unsubscribeMapStack =
        mapStack?.subscribe?.(syncProviderAvailability) || null;
      syncProviderAvailability();
    },

    /** Share-link and stored state: provider switches plus the filter. */
    getParams() {
      return encodeParams({
        providers: [...state.providers].map(([id, entry]) => [id, entry.on]),
        filter: state.filter,
      });
    },

    /** Unknown providers and malformed values are ignored, so any link applies. */
    setParams(params = {}) {
      const decoded = decodeParams(params, {
        providerIds: state.providers.keys(),
        filter: state.filter,
      });
      // A restored "Mapillary on" (the codec default) would light a source a
      // keyless install cannot draw. Only redirect a provider the params switch
      // on: a filter-only update keeps whatever the user chose.
      const asked = litByParams(decoded.providers);
      const lit =
        asked && decoded.providers.get(asked) === true
          ? keylessInstead(
              state.providers.get(asked).def,
              (id) => decoded.providers.get(id) === false,
            ).id
          : asked;
      const before = litIds();
      for (const [id, entry] of state.providers)
        if (id !== lit) switchProvider(entry, false);
      if (lit) switchProvider(state.providers.get(lit), true);
      sourceChanged(before);
      notify();
      setCoverageFilter(decoded.filter);
      return true;
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    getUIState,
    /** The DOM element provider viewers render into. */
    attachViewerHost(element, surface) {
      parts.viewerHost.attach(element, surface);
    },
    /**
     * Receive every presentation of the photo viewer the providers whose
     * photos are plain files (KartaView, Panoramax) mount in the viewer
     * host, the one mounted last (see photoViewers.js), starting with the
     * current one; null while none is mounted. A view draws it (see
     * photoViewer.js); with nobody subscribed, those providers' photos
     * cannot open.
     * @param {(view: ?object) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribePhotoViewer(listener) {
      return subscribePhotoViewers(
        [...state.providers.values()].map((entry) => entry.instance.viewer),
        listener,
      );
    },
    setProviderEnabled,
    openImage,
    attachDockedPhoto(reader, canPresent) {
      readDockedPhoto = reader;
      canPresentDockedPhoto = canPresent ?? null;
      if (!reader && dockReplacement) closeViewer();
    },
    hasDockedPhoto: () => Boolean(readDockedStreet()),
    /** Whether the dock is reloading its original photo, so refuses a pick. */
    dockedPhotoRestoring: () => Boolean(dockReplacement?.restore),
    canPresentDockedPhoto: () => canPresentDockedPhoto?.() !== false,
    dockedPhotoAdmission() {
      if (!readDockedStreet()) return null;
      const owner = readDockedPhoto?.();
      const generation = dockRequestGeneration;
      return () =>
        readDockedPhoto?.() === owner &&
        dockRequestGeneration === generation &&
        canPresentDockedPhoto?.() !== false;
    },
    /** Withdraw the replacement; the restore of the original runs on. */
    cancelDockedPhoto() {
      if (dockReplacement) dockReplacement.cancelled = true;
      dockReplacement?.controller.abort();
    },
    /**
     * Open the nearest image of the active providers (or `providerIds`) near
     * a point, else the view centre, or with `aim: 'screen-centre'` the ground
     * under the screen centre (sky: nothing). Providers without
     * `nearestImage` are skipped. Options:
     * - `radiusM` widens the search where a provider can (a geocoded landmark
     *   is rarely within 50 m of a street);
     * - `signal` retires the lookup: nothing opens after it fires;
     * - `armed: false` (the assistant's own request) ignores a link's armed
     *   point and keeps it until a photo opens;
     * - `replace: true` keeps an open photo (and EXPAND) up while it looks and
     *   closes it if nothing opens;
     * - `proceed()` is asked before a found photo loads, after it loads and
     *   before an empty lookup reports; false retires the request: before
     *   loading it leaves the viewer as it was, after loading it closes the
     *   photo before it is announced;
     * - `sequenceId` asks providers that can for that sequence's photo first
     *   (a Nearby line row).
     * Why nothing opened is in `street.nearestOutcome`: 'empty', 'sky' or
     * null (an error).
     */
    openNearest(point, options = {}) {
      return runPhotoRequest(
        readDockedStreet(),
        (owner) => openRequestedNearest(point, options, owner),
        {
          signal: options.signal,
          proceed: options.proceed,
          onFailure: options.onDockedFailure,
        },
      );
    },
    closeViewer,
    /**
     * Keep the open photo up while a request that replaces it switches its
     * source off, so EXPAND stays; only that source's own switch-off is held,
     * a source switched by hand meanwhile still stops a load. Release frees
     * the old viewer.
     */
    holdViewer() {
      const id = state.street.open ? state.street.providerId : null;
      if (!id) return () => {};
      heldViewers.set(id, (heldViewers.get(id) || 0) + 1);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const left = heldViewers.get(id) - 1;
        if (left > 0) return void heldViewers.set(id, left);
        heldViewers.delete(id);
        if (state.providers.get(id)?.on !== false) return;
        // Its photo still up (the request gave up) closes with its source;
        // otherwise the request replaced or closed it, and the panel keeps
        // what that request left (an error, an armed OPEN).
        if (state.street.open && state.street.providerId === id)
          parts.viewerHost.unmount(id);
        else parts.viewerHost.release(id);
      };
    },
    /**
     * Arm a nearest lookup for the next OPEN press without running it (a link
     * to a source that bills every load). Any other lookup, open or close, the
     * source switched off or its map leaving clears it.
     */
    armNearest(point, { providerIds = null, radiusM = null } = {}) {
      state.street.armed = {
        point:
          Number.isFinite(point?.lat) && Number.isFinite(point?.lon)
            ? { lat: point.lat, lon: point.lon }
            : null,
        providerIds: Array.isArray(providerIds) ? [...providerIds] : null,
        radiusM: Number.isFinite(radiusM) ? radiusM : null,
      };
      notify();
    },
    setViewerRenderMode: (mode) => parts.viewerHost.setRenderMode(mode),
    resizeViewer: () => parts.viewerHost.resize(),

    // ── Context: the open photo's card, and the others nearby ───────────
    /** Remembered photos from providers that can currently open them. */
    getAnalystRecords(maxCount) {
      if (!state.enabled) return [];
      return parts.photos.list(maxCount, ({ providerId }) => {
        const entry = state.providers.get(providerId);
        return entry?.on && providerAvailable(entry);
      });
    },
    /**
     * Eligible remembered photos, plus drawn lines within `radiusKm` for each
     * enabled source. Context applies its radius to the combined records.
     * Line ids come from {@link nearPointId}; openPhoto opens them.
     * @param {{lat: number, lon: number}} point
     * @param {number} radiusKm
     * @param {?object} rect Optional viewport to clip each drawn line against.
     * @returns {Array<object>}
     */
    getRecordsNear(point, radiusKm, rect = null, clip = null) {
      if (!state.enabled) return [];
      const records = layer.getAnalystRecords();
      for (const entry of listedEntries()) {
        if (!entry.on || typeof entry.instance.coverageNear !== 'function')
          continue;
        for (const line of entry.instance.coverageNear(
          point,
          radiusKm,
          rect,
          clip,
        ))
          records.push({
            id: nearPointId(entry.def.id, line),
            name: entry.def.name || null,
            lat: line.lat,
            lon: line.lon,
            providerId: entry.def.id,
            provider: entry.def.name || null,
            sequenceId: line.sequenceId,
            pano: line.isPano,
            capturedAt: line.capturedAt || null,
          });
      }
      return records;
    },
    /** Inspector can list the visible portion of drawn coverage as well as photos. */
    getViewRecords(maxCount, area) {
      return area?.rect
        ? layer
            .getRecordsNear(area.center, Infinity, area.rect, {
              visible: area.visible ?? null,
              crossing: area.crossing ?? null,
              key: area.visibleKey ?? '',
            })
            .slice(0, maxCount)
        : layer.getAnalystRecords(maxCount);
    },
    /** The photo the viewer currently confirms as shown. */
    settledPhotoId: () => acceptedPhoto()?.id ?? null,
    /** Whether a photo open or dock restore is still in progress. */
    photoOpening: () =>
      state.street.opening || Boolean(pendingDockReplacement()),
    // A dock can show an explicit photo from a source outside the Nearby list.
    getContextRecord(id) {
      if (state.enabled && acceptedPhoto()?.id === id)
        return parts.photos.get(id);
      return undefined;
    },
    /** A remembered photo by its id (`<providerId>:<imageId>`), or null. */
    photo(id) {
      return state.enabled ? parts.photos.get(id) : null;
    },
    /**
     * A provider's on-map credit as plain text, for its pictures shown away
     * from the globe (a pinned still, the dock), or '' for no such provider.
     */
    providerCredit(providerId) {
      const html = state.providers.get(providerId)?.def?.credit?.html;
      return html ? creditFromMarkup(html).text : '';
    },
    /**
     * Open a Nearby row: a remembered photo again, or a drawn line's photo
     * nearest its point (`near:` id), from that line's sequence where the
     * provider can tell. `frame: false` keeps the camera where it is.
     * @returns {Promise<boolean|null>} Whether it opened; null when a newer
     *   request took over first.
     */
    async openPhoto(id, { frame = false } = {}) {
      if (!state.enabled) return false;
      const near = parseNearPointId(id);
      const parsed = near ? null : parsePhotoId(id);
      if (!near && !parsed) return false;
      const providerId = (near ?? parsed).providerId;
      const entry = state.providers.get(providerId);
      if (!entry || !providerAvailable(entry)) return false;
      const original = readDockedStreet();
      const reaffirmDocked =
        original &&
        !pendingDockReplacement() &&
        !dockFallback &&
        !near &&
        parts.viewerHost.acceptedPhoto()?.id === id;
      if (!original && !entry.on) return false;
      if (!original) abandonDockReplacement();
      return runPhotoRequest(
        reaffirmDocked ? null : original,
        async (owner) => {
          const controller = new AbortController();
          const signal = owner.signal
            ? AbortSignal.any([controller.signal, owner.signal])
            : controller.signal;
          releaseCardPhotoOwner(signal, KEEP_OPEN_PHOTO);
          if (
            !owner.signal &&
            !near &&
            parts.viewerHost.acceptedPhoto()?.id === id
          ) {
            abortNearest();
            parts.viewerHost.cancelPending();
            if (parts.viewerHost.acceptedPhoto()?.id === id) {
              Object.assign(state.street, { loading: false, error: null });
              parts.viewerHost.reaffirm(id);
              if (frame) parts.framing.frame(parts.framing.begin());
              return true;
            }
          }
          parts.viewerHost.stopPlayback();
          const request = { id, providerId, controller, signal };
          cardPhotoRequest = request;
          try {
            const cardOwner = { ...owner, signal };
            const opened = await (near
              ? openRequestedNearest(
                  near.point,
                  {
                    providerIds: [near.providerId],
                    frame,
                    armed: false,
                    sequenceId: near.sequenceId,
                  },
                  cardOwner,
                )
              : openRequestedImage(
                  entry,
                  parsed.imageId,
                  { frame },
                  cardOwner,
                ));
            // Taken over by a newer request (another card, a map click): not a
            // failure of this photo, whose card says nothing about it.
            return signal.aborted && !opened ? null : opened;
          } finally {
            if (cardPhotoRequest === request) cardPhotoRequest = null;
          }
        },
        { id },
      );
    },
    /**
     * Close the photo whose card went away, unless another request already
     * took the viewer. On a card-to-card handoff, withdraw the previous
     * request while it is loading and leave settled photos open.
     * @returns {boolean} Whether the request or open photo was closed.
     */
    closePhoto(id, { pendingOnly = false } = {}) {
      const replacement = pendingDockReplacement();
      if (replacement?.id && replacement.id === id) {
        layer.cancelDockedPhoto();
        return true;
      }
      const original = replacement?.original ?? dockFallback?.street;
      if (
        !pendingOnly &&
        original &&
        photoId(original.providerId, original.imageId) === id &&
        !readDockedPhoto?.()
      ) {
        closeViewer();
        return true;
      }
      if (cardPhotoRequest?.id === id) {
        releaseCardPhotoOwner(
          undefined,
          pendingOnly ? KEEP_OPEN_PHOTO : undefined,
        );
        if (!state.street.open) parts.clearSequences();
        return true;
      }
      // A step or a map lookup may still be loading over the displayed photo.
      if (pendingOnly || cardPhotoRequest) return false;
      if (!id || parts.viewerHost.acceptedPhoto()?.id !== id) return false;
      closeViewer();
      return true;
    },
    /**
     * Something else was picked: close the photo, whether it shows on its
     * card, waits offscreen or is still loading, and withdraw every request
     * in flight (a card's, a lookup, a line's image), so none opens later.
     * @returns {boolean} Whether there was anything to close.
     */
    withdrawPhoto() {
      const { open, loading, opening } = state.street;
      if (!open && !loading && !opening && !cardPhotoRequest && !nearestLookup)
        return false;
      closeViewer();
      return true;
    },

    // ── The Data Layers row: providers, panorama and SINCE filters ──────
    /** The UI presents the row's controls from the layer's state. */
    presentRowControls(presenter) {
      rowControlsPresenter = typeof presenter === 'function' ? presenter : null;
      lastRowSignature = '';
      rowControlsListener?.();
    },
    getRowControls() {
      return rowControlsPresenter?.() ?? null;
    },

    /** Stop a sequence playing in the open photo, leaving the photo open. */
    stopPlayback() {
      if (state.street.open) parts.viewerHost.stopPlayback();
    },
  };
  return layer;
}
