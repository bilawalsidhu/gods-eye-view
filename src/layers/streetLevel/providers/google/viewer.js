import {
  DETAILS_RETRY_COOLDOWN_MS,
  DETAILS_TIMEOUT_MS,
  GOOGLE_PROVIDER_ID,
  KEY_REJECTED_MESSAGE,
  NO_ANSWER_MESSAGE,
  OPEN_TIMEOUT_MS,
  creatorFrom,
  imageDateMs,
  streetViewUrl,
} from './policy.js';
import { msg } from '../../../../i18n/index.js';

const alwaysVisible = () => true;
const PANORAMA_OPTIONS = Object.freeze({
  visible: false,
  // The caption already shows the address.
  addressControl: false,
  linksControl: true,
  panControl: true,
  zoomControl: true,
  clickToGo: true,
  showRoadLabels: true,
  // The shared viewer handles expand and close.
  fullscreenControl: false,
  enableCloseButton: false,
  motionTracking: false,
  motionTrackingControl: false,
});

/**
 * Viewer adapter over Google's StreetViewPanorama: emits a pose for every
 * panorama and view change, including steps along Google's arrows.
 * @param {{loader: ReturnType<import('./mapsLoader.js').createMapsLoader>, getService?: () => Promise<object>, render?: object}} options
 * @returns {import('../../registry.js').ViewerAdapter & {remember: Function}}
 */
export function createGoogleViewer({ loader, getService, render } = {}) {
  let library = null;
  let panorama = null;
  let element = null;
  let host = null;
  let hostVisible = alwaysVisible;
  let service = null;
  let opening = null;
  let active = false;
  let confirmed = null;
  const withdrawn = new Set();
  let walkPosition = null;
  /** Bumped by `unmount`: a construction it overtook builds nothing. */
  let generation = 0;
  let subscriptions = [];
  const described = new Map();
  const resolvedAliases = new Map();
  /** Panorama id → its lookup in flight; a late answer to a dropped one is ignored. */
  const lookingUp = new Map();
  const retryAfter = new Map();
  const listeners = new Set();

  function requestRender() {
    render?.governorRequestRender?.('google-street-view');
  }

  async function ensureLibrary() {
    library ||= await loader.importLibrary('streetView');
    return library;
  }

  function requireVisible(isVisible) {
    if (!isVisible())
      throw new Error(msg('Open Context to view street-level imagery'));
  }

  function emit(pose) {
    for (const listener of [...listeners]) {
      try {
        listener(pose);
      } catch {
        /* listener errors are the core's to log */
      }
    }
  }

  // Metadata and alias checks run on a mounted panorama, after ensureLibrary.
  function createService() {
    return getService ? getService() : new library.StreetViewService();
  }

  function metaFrom(data) {
    return {
      capturedAt: imageDateMs(data?.imageDate),
      creator: creatorFrom(data?.copyright),
      title: data?.location?.description || null,
    };
  }

  /**
   * Look up a panorama's date, photographer and address once, then re-emit
   * the pose. A failed or timed-out lookup can retry after the cooldown.
   */
  async function describe(panoId) {
    if (described.has(panoId) || lookingUp.has(panoId)) return;
    if (Date.now() < (retryAfter.get(panoId) ?? 0)) return;
    const lookup = { timer: null };
    lookingUp.set(panoId, lookup);
    const current = () => lookingUp.get(panoId) === lookup;
    try {
      const { data } = await new Promise((resolve, reject) => {
        lookup.timer = setTimeout(
          () => reject(new Error(NO_ANSWER_MESSAGE)),
          DETAILS_TIMEOUT_MS,
        );
        (async () => {
          service ||= await createService();
          if (!current())
            throw new Error('Street View details lookup was released');
          requireVisible(hostVisible);
          return service.getPanorama({ pano: panoId });
        })().then(resolve, reject);
      });
      if (!current()) return;
      described.set(panoId, metaFrom(data));
      retryAfter.delete(panoId);
    } catch {
      if (current() && hostVisible())
        retryAfter.set(panoId, Date.now() + DETAILS_RETRY_COOLDOWN_MS);
      return;
    } finally {
      clearTimeout(lookup.timer);
      if (current()) lookingUp.delete(panoId);
    }
    publishPose();
  }

  function releaseLookups() {
    for (const lookup of lookingUp.values()) clearTimeout(lookup.timer);
    lookingUp.clear();
  }

  function selectedPanorama(instance) {
    const id = instance.getPano();
    const location = instance.getLocation?.();
    if (location?.pano && location.pano !== id) return null;
    const coordinates = location?.latLng ?? instance.getPosition();
    const lat = coordinates?.lat();
    const lon = coordinates?.lng();
    return id && Number.isFinite(lat) && Number.isFinite(lon)
      ? { id, position: { lat, lon } }
      : null;
  }

  function publishPose() {
    if (
      !active ||
      !hostVisible() ||
      opening ||
      !confirmed ||
      panorama?.getPano() !== confirmed.id ||
      panorama.getStatus() !== 'OK'
    )
      return;
    const { id: panoId, position } = confirmed;
    const meta = described.get(panoId);
    if (!meta) describe(panoId);
    const pov = panorama.getPov() || {};
    emit({
      providerId: GOOGLE_PROVIDER_ID,
      imageId: panoId,
      position,
      bearing: Number.isFinite(pov.heading) ? pov.heading : null,
      tilt: Number.isFinite(pov.pitch) ? pov.pitch : 0,
      altitude: null,
      isPano: true,
      capturedAt: meta?.capturedAt ?? null,
      capturedAtPrecision: 'month',
      creator: meta?.creator ?? null,
      title: meta?.title ?? null,
      sequenceId: null,
      externalUrl: streetViewUrl(panoId, {
        heading: pov.heading || 0,
        pitch: pov.pitch || 0,
      }),
    });
    requestRender();
  }

  function publishWalk(instance) {
    if (
      walkPosition &&
      hostVisible() &&
      instance.getPano() === walkPosition.id &&
      instance.getStatus() === 'OK'
    ) {
      confirmed = walkPosition;
      walkPosition = null;
      publishPose();
    }
  }

  async function ensurePanorama(target, isVisible) {
    requireVisible(isVisible);
    if (panorama && host === target) return panorama;
    const built = generation;
    const { StreetViewPanorama } = await ensureLibrary();
    if (built !== generation) throw new Error('Street View was unmounted');
    requireVisible(isVisible);
    if (panorama && host === target) return panorama;
    destroyPanorama();
    element = target.ownerDocument.createElement('div');
    element.className = 'sl-google-panorama';
    element.style.cssText = 'position:absolute;inset:0;';
    target.append(element);
    host = target;
    hostVisible = isVisible;
    const instance = new StreetViewPanorama(element, PANORAMA_OPTIONS);
    panorama = instance;
    // Capture native arrow activation before the SDK handles the gesture.
    // Only that navigation can release its ID from a cancelled request.
    let inputTurn = null;
    function nativeNavigation(event) {
      if (
        !withdrawn.size ||
        opening ||
        !active ||
        !hostVisible() ||
        !confirmed ||
        instance.getPano() !== confirmed.id
      )
        return;
      if (
        event.type === 'keydown' &&
        !['Enter', ' ', 'ArrowUp', 'ArrowDown'].includes(event.key)
      )
        return;
      clearTimeout(inputTurn);
      inputTurn = setTimeout(() => {
        inputTurn = null;
      }, 0);
    }
    const inputEvents = ['pointerup', 'click', 'keydown'];
    for (const type of inputEvents)
      element.addEventListener?.(type, nativeNavigation, true);
    subscriptions = [
      {
        remove() {
          clearTimeout(inputTurn);
          for (const type of inputEvents)
            element.removeEventListener?.(type, nativeNavigation, true);
        },
      },
      instance.addListener('pano_changed', () => {
        if (inputTurn === null || opening) return;
        withdrawn.delete(instance.getPano());
        clearTimeout(inputTurn);
        inputTurn = null;
      }),
      instance.addListener('position_changed', () => {
        if (
          panorama !== instance ||
          !active ||
          opening ||
          !confirmed ||
          !hostVisible()
        )
          return;
        if (
          withdrawn.has(instance.getPano()) &&
          instance.getPano() !== confirmed.id
        ) {
          active = false;
          confirmed = null;
          walkPosition = null;
          instance.setVisible(false);
          emit(null);
          return;
        }
        walkPosition = selectedPanorama(instance);
        publishWalk(instance);
      }),
      instance.addListener('status_changed', () => {
        if (panorama === instance && active && !opening) publishWalk(instance);
      }),
      instance.addListener('pov_changed', publishPose),
    ];
    return instance;
  }

  function retire(request) {
    if (!request?.issued) return;
    for (const id of [request.id, resolvedAliases.get(request.id)]) {
      if (id && id !== confirmed?.id) withdrawn.add(id);
    }
  }

  function destroyPanorama() {
    opening?.cancel?.();
    opening = null;
    active = false;
    confirmed = null;
    withdrawn.clear();
    resolvedAliases.clear();
    walkPosition = null;
    for (const subscription of subscriptions) subscription.remove();
    subscriptions = [];
    try {
      panorama?.setVisible(false);
    } catch {
      /* already gone */
    }
    element?.remove();
    panorama = null;
    element = null;
    host = null;
    hostVisible = alwaysVisible;
  }

  /** Wait for a current panorama ID, position and successful status. */
  function showPanorama(instance, request) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(reject, new Error(NO_ANSWER_MESSAGE)),
        OPEN_TIMEOUT_MS,
      );
      const stopAuthWatch = loader.onAuthFailure(() =>
        finish(reject, new Error(KEY_REJECTED_MESSAGE)),
      );
      request.cancel = () => finish(resolve);
      let position = null;
      let sawRequestedId = false;
      let redirectedId = null;
      let checkedAlias = false;
      let verifiedAlias = null;
      const current = () => opening === request && request.cancel !== null;

      // An unfamiliar position may belong to an earlier open. Resolve the
      // current request's ID once, within its original deadline.
      async function verifyAlias() {
        try {
          service ||= await createService();
          if (!current() || !hostVisible()) return;
          const { data } = await service.getPanorama({ pano: request.id });
          if (!current() || !hostVisible() || !data?.location?.pano) return;
          verifiedAlias = data.location.pano;
          described.set(verifiedAlias, metaFrom(data));
          accept();
        } catch {
          // A failed lookup cannot make a stale camera position authoritative.
        }
      }

      function accept() {
        if (
          !current() ||
          !position ||
          instance.getPano() !== position.id ||
          instance.getStatus() !== 'OK'
        )
          return;
        // The settled frame can still report its position during a replacement.
        if (
          position.id === request.id ||
          position.id === verifiedAlias ||
          position.id === resolvedAliases.get(request.id) ||
          (!withdrawn.size &&
            position.id !== confirmed?.id &&
            redirectedId === position.id)
        ) {
          finish(resolve, position);
        } else if (
          !withdrawn.has(position.id) &&
          (position.id !== confirmed?.id || redirectedId === position.id) &&
          !checkedAlias
        ) {
          checkedAlias = true;
          void verifyAlias();
        }
      }
      const subscriptions = [
        instance.addListener('pano_changed', () => {
          const id = instance.getPano();
          if (id === request.id) sawRequestedId = true;
          redirectedId = sawRequestedId && id !== request.id ? id : null;
        }),
        instance.addListener('position_changed', () => {
          position = selectedPanorama(instance);
          accept();
        }),
        instance.addListener('status_changed', () => {
          if (opening !== request) return;
          const status = instance.getStatus();
          if (status === 'OK') {
            const location = instance.getLocation?.();
            if (
              location?.pano &&
              location.pano === instance.getPano() &&
              location.latLng
            )
              position = selectedPanorama(instance);
            accept();
          } else if (status && instance.getPano() === request.id)
            finish(
              reject,
              new Error(msg('Street View has no imagery for this place')),
            );
        }),
      ];
      function finish(settle, value) {
        if (request.cancel === null) return;
        request.cancel = null;
        clearTimeout(timer);
        for (const subscription of subscriptions) subscription.remove();
        stopAuthWatch();
        settle(value);
      }
      try {
        requireVisible(hostVisible);
        request.issued = true;
        instance.setPano(request.id);
        requireVisible(hostVisible);
        instance.setVisible(true);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function openPanorama(imageId) {
    const id = String(imageId);
    if (!host) throw new Error('Street View is not mounted');
    if (loader.authFailed()) throw new Error(KEY_REJECTED_MESSAGE);
    const prior = opening;
    retire(prior);
    const request = { id };
    opening = request;
    prior?.cancel?.();
    walkPosition = null;
    try {
      const instance = await ensurePanorama(host, hostVisible);
      if (opening !== request) return;
      requireVisible(hostVisible);
      let selection;
      if (
        confirmed &&
        (confirmed.id === id || confirmed.id === resolvedAliases.get(id)) &&
        instance.getPano() === confirmed.id &&
        instance.getStatus() === 'OK'
      ) {
        instance.setVisible(true);
        selection = confirmed;
      } else {
        selection = await showPanorama(instance, request);
      }
      if (opening !== request) return;
      requireVisible(hostVisible);
      if (
        !selection ||
        instance.getPano() !== selection.id ||
        instance.getStatus() !== 'OK'
      )
        throw new Error(NO_ANSWER_MESSAGE);
      if (selection.id !== id) resolvedAliases.set(id, selection.id);
      confirmed = selection;
      withdrawn.delete(id);
      withdrawn.delete(selection.id);
      active = true;
      opening = null;
      publishPose();
      return selection.id;
    } catch (error) {
      if (opening === request) {
        retire(request);
        if (
          confirmed &&
          (panorama?.getPano() !== confirmed.id ||
            panorama?.getStatus() !== 'OK')
        ) {
          confirmed = null;
          emit(null);
        }
      }
      throw error;
    } finally {
      if (opening === request) opening = null;
    }
  }

  return {
    async mount(target, { isVisible = alwaysVisible } = {}) {
      if (!target) throw new Error('Street Level viewer has no host element');
      await ensurePanorama(target, isVisible);
      hostVisible = isVisible;
    },

    open: openPanorama,

    cancelOpenKeeping(imageId) {
      if (!active || !panorama || confirmed?.id !== imageId) return false;
      const sdkStillShowsConfirmed =
        panorama.getPano() === imageId && panorama.getStatus() === 'OK';
      if (!opening) return sdkStillShowsConfirmed;

      retire(opening);
      opening.cancel?.();
      opening = null;
      walkPosition = null;
      // The host closes the viewer when the SDK no longer shows the original.
      // Only a subsequent explicit open may start another panorama load.
      return sdkStillShowsConfirmed;
    },

    close() {
      retire(opening);
      opening?.cancel?.();
      opening = null;
      active = false;
      walkPosition = null;
      try {
        panorama?.setVisible(false);
      } catch {
        /* torn down */
      }
    },

    unmount() {
      releaseLookups();
      generation++;
      destroyPanorama();
    },

    resize() {
      if (!panorama) return;
      try {
        globalThis.google?.maps?.event?.trigger(panorama, 'resize');
      } catch {
        /* no-op */
      }
    },

    onPose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Seed the details cache from a nearest lookup's answer. */
    remember(panoId, data) {
      if (panoId && data) described.set(String(panoId), metaFrom(data));
    },
  };
}
