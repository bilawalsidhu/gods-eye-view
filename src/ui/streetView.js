import {
  claimPointer,
  isLeaseCurrent,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';

const STREET_VIEW_POINTER_OWNER = 'street-view';
const MAPS_CALLBACK = '__gevStreetViewMapsReady';
/** Search radii, metres: snap to the nearest road first, then look further out. */
const SEARCH_RADII_M = Object.freeze([50, 250]);
const MARKER_ID = 'street-view:marker';
/**
 * Google bills each panorama instantiation (Dynamic Street View: 5,000 free a
 * month) and offers no quota row to cap it, so the app caps itself. 150 × 31
 * stays under the free tier. Panning and walking inside a panorama are free.
 */
export const STREET_VIEW_DAILY_LIMIT = 150;
const DAILY_LOADS_KEY = 'godsEyeView.streetView.dailyLoads';

/** Google's quota day runs on Pacific time. */
function quotaDay(now) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * Today's panorama-load count. Storage can be missing or throw (private
 * windows, blocked site data); the count then starts from zero.
 */
function readDailyLoads(storage, memory, now) {
  const day = quotaDay(now);
  let count = memory.day === day ? memory.count : 0;
  try {
    const saved = JSON.parse(storage?.getItem(DAILY_LOADS_KEY) || 'null');
    if (saved?.day === day && Number.isInteger(saved.count))
      count = Math.max(count, saved.count);
  } catch {
    // Unreadable storage falls back to this page's own count.
  }
  return count;
}

/** `memory` keeps the count when storage is unavailable. */
function recordDailyLoad(storage, memory, now) {
  const count = readDailyLoads(storage, memory, now) + 1;
  memory.day = quotaDay(now);
  memory.count = count;
  try {
    storage?.setItem(
      DAILY_LOADS_KEY,
      JSON.stringify({ day: quotaDay(now), count }),
    );
  } catch {
    // Without storage the limit holds for this page session only.
  }
  return count;
}

/**
 * Load the Maps JavaScript API once and resolve its Street View library.
 * A failed load clears the cache so the next attempt can retry.
 */
let mapsLibraryPromise = null;
function loadStreetViewLibrary(documentRef, apiKey) {
  if (mapsLibraryPromise) return mapsLibraryPromise;
  const win = documentRef.defaultView;
  mapsLibraryPromise = new Promise((resolve, reject) => {
    if (win.google?.maps?.importLibrary) {
      resolve();
      return;
    }
    win[MAPS_CALLBACK] = () => resolve();
    const script = documentRef.createElement('script');
    script.async = true;
    script.src =
      'https://maps.googleapis.com/maps/api/js?key=' +
      encodeURIComponent(apiKey) +
      `&v=weekly&loading=async&callback=${MAPS_CALLBACK}`;
    script.onerror = () =>
      reject(new Error('Could not load Google Maps — check your connection'));
    documentRef.head.appendChild(script);
  })
    .then(() => win.google.maps.importLibrary('streetView'))
    .catch((error) => {
      mapsLibraryPromise = null;
      throw error;
    });
  return mapsLibraryPromise;
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Street View: press the shortcut, click the globe, and walk the street in a
 * Google Street View panel. A globe marker follows the panorama as it moves.
 *
 * Arming is a TOOL in the inputOwnership sense: it claims the pointer so the
 * placing click does not also select whatever layer entity sits under it.
 * @param {object} options
 * @param {import('cesium').Viewer} options.viewer
 * @param {typeof import('cesium')} options.Cesium
 * @param {Document} options.documentRef
 * @param {() => string|undefined} options.getApiKey Browser Google Maps key.
 * @param {(message: string) => void} options.showToast
 * @param {Storage} [options.storage] Holds the daily load count.
 * @param {number} [options.dailyLimit] Panorama loads allowed per Pacific day.
 * @param {() => Date} [options.now]
 * @returns {{toggle: Function, openAt: Function, close: Function, isOpen: Function, destroy: Function}}
 */
export function createStreetView({
  viewer,
  Cesium,
  documentRef,
  getApiKey,
  showToast,
  storage = safeLocalStorage(),
  dailyLimit = STREET_VIEW_DAILY_LIMIT,
  now = () => new Date(),
}) {
  const sessionLoads = { day: null, count: 0 };
  let lease = null;
  let releaseTimer = null;
  let pendingRelease = null;
  let panel = null;
  let panorama = null;
  let listeners = [];
  let openSeq = 0;
  let destroyed = false;

  const canvas = viewer.scene.canvas;
  const clickHandler = new Cesium.ScreenSpaceEventHandler(canvas);
  clickHandler.setInputAction((click) => {
    if (!isLeaseCurrent(lease)) return;
    const point = pickGround(click.position);
    if (!point) return;
    // Hold the claim until this click finishes dispatching so ambient layer
    // handlers registered after this one still see the pointer as taken.
    disarm({ afterDispatch: true });
    void openAt(point);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    if (isLeaseCurrent(lease)) disarm();
    else if (panel) close();
  };
  documentRef.addEventListener('keydown', onKeyDown);

  function pickGround(screenPosition) {
    const scene = viewer.scene;
    let cartesian;
    try {
      if (scene.pickPositionSupported)
        cartesian = scene.pickPosition(screenPosition);
    } catch {
      cartesian = undefined;
    }
    if (!Cesium.defined(cartesian)) {
      cartesian = viewer.camera.pickEllipsoid(
        screenPosition,
        Cesium.Ellipsoid.WGS84,
      );
    }
    if (!Cesium.defined(cartesian)) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  function limitReached() {
    if (readDailyLoads(storage, sessionLoads, now()) < dailyLimit) return false;
    showToast(
      `Daily Street View limit reached (${dailyLimit}) — resets at midnight Pacific`,
    );
    return true;
  }

  function arm() {
    if (!String(getApiKey() || '').trim()) {
      showToast('Street View needs a Google Maps key');
      return false;
    }
    if (limitReached()) return false;
    lease = claimPointer(STREET_VIEW_POINTER_OWNER);
    if (!lease) {
      showToast(`Finish ${pointerOwner() || 'the active tool'} first`);
      return false;
    }
    canvas.classList.add('street-view-armed');
    showToast('Click a street to open Street View — Esc to cancel');
    return true;
  }

  function disarm({ afterDispatch = false } = {}) {
    canvas.classList.remove('street-view-armed');
    if (!lease) return;
    const held = lease;
    lease = null;
    if (!afterDispatch) {
      releasePointer(held);
      return;
    }
    pendingRelease = held;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(flushRelease, 0);
  }

  function flushRelease() {
    clearTimeout(releaseTimer);
    releaseTimer = null;
    if (pendingRelease) releasePointer(pendingRelease);
    pendingRelease = null;
  }

  function buildPanel() {
    const root = documentRef.createElement('section');
    root.className = 'street-view-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Street View');
    root.innerHTML = `
      <header class="street-view-header">
        <span class="street-view-kicker">STREET VIEW</span>
        <span class="street-view-place" aria-live="polite"></span>
        <button type="button" class="street-view-btn" data-action="expand"
          aria-label="Expand Street View" title="Expand">⤢</button>
        <button type="button" class="street-view-btn" data-action="close"
          aria-label="Close Street View" title="Close (Esc)">✕</button>
      </header>
      <div class="street-view-pano"></div>`;
    root.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') close();
      if (action === 'expand') {
        root.classList.toggle('expanded');
        // The panorama sizes itself on window resize only.
        if (panorama)
          documentRef.defaultView.google?.maps?.event?.trigger(
            panorama,
            'resize',
          );
      }
    });
    documentRef.body.appendChild(root);
    return root;
  }

  function setPlace(text) {
    const place = panel?.querySelector('.street-view-place');
    if (place) place.textContent = text;
  }

  function updateMarker(lat, lon) {
    const position = Cesium.Cartesian3.fromDegrees(lon, lat);
    let marker = viewer.entities.getById(MARKER_ID);
    if (!marker) {
      marker = viewer.entities.add({
        id: MARKER_ID,
        position,
        point: {
          pixelSize: 14,
          color: Cesium.Color.fromCssColorString('#ffc400'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } else {
      marker.position = position;
    }
    viewer.scene.requestRender();
  }

  function removeMarker() {
    if (viewer.isDestroyed?.()) return;
    viewer.entities.removeById(MARKER_ID);
    viewer.scene.requestRender();
  }

  async function findPanorama(lib, point) {
    const service = new lib.StreetViewService();
    for (const radius of SEARCH_RADII_M) {
      try {
        const { data } = await service.getPanorama({
          location: { lat: point.lat, lng: point.lon },
          radius,
          preference: lib.StreetViewPreference.NEAREST,
          sources: [lib.StreetViewSource.OUTDOOR],
        });
        if (data?.location?.pano) return data.location;
      } catch {
        // ZERO_RESULTS rejects; widen the search.
      }
    }
    return null;
  }

  /**
   * Open (or move) the panel to the panorama nearest a ground point.
   * @param {{lat: number, lon: number}} point Degrees.
   * @returns {Promise<boolean>} Whether a panorama is showing.
   */
  async function openAt(point) {
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon))
      return false;
    // Reusing an open panorama (setPano) is not a new load; creating one is.
    if (!panorama && limitReached()) return false;
    const seq = ++openSeq;
    const win = documentRef.defaultView;
    // Google reports a rejected key through this global, not the promise.
    win.gm_authFailure = () => {
      showToast('Google rejected the key for Street View — see console');
      close();
    };
    let lib;
    try {
      lib = await loadStreetViewLibrary(documentRef, getApiKey());
    } catch (error) {
      if (seq === openSeq) showToast(error.message);
      return false;
    }
    if (destroyed || seq !== openSeq) return false;
    const location = await findPanorama(lib, point);
    if (destroyed || seq !== openSeq) return false;
    if (!location) {
      showToast('No Street View imagery near there');
      return false;
    }

    if (!panel) panel = buildPanel();
    const heading = viewer.camera.heading;
    const pov = {
      heading: Number.isFinite(heading) ? Cesium.Math.toDegrees(heading) : 0,
      pitch: 0,
    };
    if (!panorama) {
      if (limitReached()) return false;
      recordDailyLoad(storage, sessionLoads, now());
      panorama = new lib.StreetViewPanorama(
        panel.querySelector('.street-view-pano'),
        {
          pano: location.pano,
          pov,
          addressControl: false,
          fullscreenControl: false,
          motionTracking: false,
        },
      );
      listeners.push(
        panorama.addListener('position_changed', () => {
          const pos = panorama.getPosition();
          if (pos) updateMarker(pos.lat(), pos.lng());
        }),
        panorama.addListener('links_changed', () => {
          setPlace(panorama.getLocation()?.description || '');
        }),
      );
    } else {
      panorama.setPano(location.pano);
      panorama.setPov(pov);
    }
    panorama.setVisible(true);
    setPlace(location.description || '');
    updateMarker(location.latLng.lat(), location.latLng.lng());
    return true;
  }

  function close() {
    openSeq++;
    for (const listener of listeners) listener.remove();
    listeners = [];
    panorama = null;
    panel?.remove();
    panel = null;
    removeMarker();
  }

  return {
    /** Shortcut entry point: close if open, cancel if armed, otherwise arm. */
    toggle() {
      if (destroyed) return false;
      if (panel) {
        close();
        return false;
      }
      if (isLeaseCurrent(lease)) {
        disarm();
        return false;
      }
      return arm();
    },
    openAt,
    close,
    isOpen: () => Boolean(panel),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      disarm();
      flushRelease();
      close();
      clickHandler.destroy();
      documentRef.removeEventListener('keydown', onKeyDown);
    },
  };
}
