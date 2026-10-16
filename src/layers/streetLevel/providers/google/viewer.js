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

const PANORAMA_OPTIONS = Object.freeze({
  visible: false,
  // The caption has the address; Google's card covers a docked panorama.
  addressControl: false,
  linksControl: true,
  panControl: true,
  zoomControl: true,
  clickToGo: true,
  showRoadLabels: true,
  // The panel has EXPAND and ×.
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
  let service = null;
  let pendingOpen = null;
  let cancelShown = null;
  /** Bumped by `unmount`: a construction it overtook builds nothing. */
  let generation = 0;
  let subscriptions = [];
  const described = new Map();
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

  function emit(pose) {
    for (const listener of [...listeners]) {
      try {
        listener(pose);
      } catch {
        /* listener errors are the core's to log */
      }
    }
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
          service ||= getService
            ? await getService()
            : new (await ensureLibrary()).StreetViewService();
          return service.getPanorama({ pano: panoId });
        })().then(resolve, reject);
      });
      if (!current()) return;
      described.set(panoId, metaFrom(data));
      retryAfter.delete(panoId);
    } catch {
      if (current())
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

  function publishPose() {
    const panoId = panorama?.getPano?.();
    const latLng = panorama?.getPosition?.();
    if (!panoId || !latLng || pendingOpen === null) return;
    const meta = described.get(panoId);
    if (!meta) describe(panoId);
    const pov = panorama.getPov() || {};
    emit({
      providerId: GOOGLE_PROVIDER_ID,
      imageId: panoId,
      position: { lon: latLng.lng(), lat: latLng.lat() },
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

  async function ensurePanorama(target) {
    if (panorama && host === target) return panorama;
    const built = generation;
    const { StreetViewPanorama } = await ensureLibrary();
    if (built !== generation) throw new Error('Street View was unmounted');
    if (panorama && host === target) return panorama;
    destroyPanorama();
    element = target.ownerDocument.createElement('div');
    element.className = 'sl-google-panorama';
    element.style.cssText = 'position:absolute;inset:0;';
    target.append(element);
    host = target;
    panorama = new StreetViewPanorama(element, PANORAMA_OPTIONS);
    // Not pano_changed: it can fire with the old panorama's position.
    subscriptions = ['position_changed', 'pov_changed'].map((name) =>
      panorama.addListener(name, () => publishPose()),
    );
    return panorama;
  }

  function destroyPanorama() {
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
  }

  /**
   * Resolves once `panoId` shows (OK status, or a new position when the
   * status stays OK); rejects on no imagery, a refused key or no answer.
   */
  function shown(instance, panoId) {
    if (instance.getPano() === panoId && instance.getStatus() === 'OK')
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(reject, new Error(NO_ANSWER_MESSAGE)),
        OPEN_TIMEOUT_MS,
      );
      const stopAuthWatch = loader.onAuthFailure(() =>
        finish(reject, new Error(KEY_REJECTED_MESSAGE)),
      );
      cancelShown = () => finish(resolve);
      // At a position event the status may still be the last panorama's failure.
      const onStatus = () => {
        if (pendingOpen !== panoId) return finish(resolve);
        const status = instance.getStatus();
        if (status === 'OK') finish(resolve);
        else if (status)
          finish(
            reject,
            new Error(msg('Street View has no imagery for this place')),
          );
      };
      const onPosition = () => {
        if (pendingOpen !== panoId || instance.getStatus() === 'OK')
          finish(resolve);
      };
      const subscriptions = [
        instance.addListener('status_changed', onStatus),
        instance.addListener('position_changed', onPosition),
      ];
      function finish(settle, value) {
        cancelShown = null;
        clearTimeout(timer);
        for (const subscription of subscriptions) subscription.remove();
        stopAuthWatch();
        settle(value);
      }
    });
  }

  return {
    async mount(target) {
      if (!target) throw new Error('Street Level viewer has no host element');
      await ensurePanorama(target);
    },

    async open(imageId) {
      const panoId = String(imageId);
      if (!host) throw new Error('Street View is not mounted');
      if (loader.authFailed()) throw new Error(KEY_REJECTED_MESSAGE);
      pendingOpen = panoId;
      const instance = await ensurePanorama(host);
      if (pendingOpen !== panoId) return;
      const ready = shown(instance, panoId);
      instance.setPano(panoId);
      instance.setVisible(true);
      await ready;
      if (pendingOpen !== panoId) return;
      publishPose();
    },

    close() {
      pendingOpen = null;
      cancelShown?.();
      try {
        panorama?.setVisible(false);
      } catch {
        /* torn down */
      }
    },

    unmount() {
      pendingOpen = null;
      cancelShown?.();
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
