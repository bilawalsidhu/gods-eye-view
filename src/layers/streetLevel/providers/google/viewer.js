import {
  GOOGLE_PROVIDER_ID,
  KEY_REJECTED_MESSAGE,
  NO_ANSWER_MESSAGE,
  OPEN_TIMEOUT_MS,
  creatorFrom,
  imageDateMs,
  streetViewUrl,
} from './policy.js';

/** Google's own controls, minus those the Street Level panel already has. */
const PANORAMA_OPTIONS = Object.freeze({
  visible: false,
  // The address goes in the panel caption: Google's card covers half a
  // docked panorama.
  addressControl: false,
  linksControl: true,
  panControl: true,
  zoomControl: true,
  clickToGo: true,
  showRoadLabels: true,
  // The panel has EXPAND and ×; Google's fullscreen would leave the modal.
  fullscreenControl: false,
  enableCloseButton: false,
  motionTracking: false,
  motionTrackingControl: false,
});

/**
 * Viewer adapter over Google's StreetViewPanorama. It renders in its own
 * element inside the core's host, and emits a provider-neutral pose for every
 * panorama and view change, including steps along Google's own arrows.
 * `getService` hands out the StreetViewService the provider shares.
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
  /** Settles the open waiting for its panorama, when a close overtakes it. */
  let cancelShown = null;
  /** Bumped by `unmount`, so a construction it overtook builds nothing. */
  let generation = 0;
  let subscriptions = [];
  /** Panorama id → its {capturedAt, creator, title}. */
  const described = new Map();
  /** Panorama ids whose lookup is in flight. */
  const lookingUp = new Set();
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
   * Look up a panorama's date, photographer and address once; the pose
   * already out is sent again with them. A failed lookup is asked again on
   * the next event.
   */
  async function describe(panoId) {
    if (described.has(panoId) || lookingUp.has(panoId)) return;
    lookingUp.add(panoId);
    try {
      service ||= getService
        ? await getService()
        : new (await ensureLibrary()).StreetViewService();
      const { data } = await service.getPanorama({ pano: panoId });
      described.set(panoId, metaFrom(data));
    } catch {
      return;
    } finally {
      lookingUp.delete(panoId);
    }
    publishPose();
  }

  /** Emit the pose on screen now, dated once its lookup has answered. */
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
    // Not pano_changed: it can fire before the new panorama's data, with the
    // old position. A step along an arrow moves the position.
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
   * Resolves once `panoId` shows: an OK status, or (when the status was
   * already OK and does not change) the new position. Rejects when Google has
   * no imagery for it, refuses the key (reported apart from the status), or
   * does not answer. Google may show a newer id for the same place.
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
      const check = () => {
        if (pendingOpen !== panoId) return finish(resolve);
        const status = instance.getStatus();
        if (status === 'OK') finish(resolve);
        else if (status)
          finish(
            reject,
            new Error('Street View has no imagery for this place'),
          );
      };
      const subscriptions = ['status_changed', 'position_changed'].map((name) =>
        instance.addListener(name, check),
      );
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

    /** Resolves once the panorama is on screen and its first pose was emitted. */
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

    /** Keep a lookup's answer, so the panorama it found needs no second one. */
    remember(panoId, data) {
      if (panoId && data) described.set(String(panoId), metaFrom(data));
    },
  };
}
