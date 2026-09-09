/**
 * Browser Geolocation helpers for one-shot fly-to and optional live follow.
 * Uses navigator.geolocation only — no Google / Cesium ion keys required.
 */

export const GEOLOCATION_UNAVAILABLE = 'unavailable';
export const GEOLOCATION_DENIED = 'denied';
export const GEOLOCATION_TIMEOUT = 'timeout';
export const GEOLOCATION_POSITION_UNAVAILABLE = 'position-unavailable';
export const GEOLOCATION_UNKNOWN = 'unknown';

const DEFAULT_POSITION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 10000,
});

/**
 * @returns {boolean}
 */
export function isGeolocationAvailable(geo = globalThis.navigator?.geolocation) {
  return Boolean(geo && typeof geo.getCurrentPosition === 'function');
}

/**
 * Map a GeolocationPositionError (or synthetic) to a stable code.
 * @param {GeolocationPositionError|{code?:number,message?:string}|null} err
 * @returns {string}
 */
export function classifyGeolocationError(err) {
  if (!err) return GEOLOCATION_UNKNOWN;
  const code = Number(err.code);
  if (code === 1) return GEOLOCATION_DENIED;
  if (code === 2) return GEOLOCATION_POSITION_UNAVAILABLE;
  if (code === 3) return GEOLOCATION_TIMEOUT;
  const message = String(err.message || '').toLowerCase();
  if (message.includes('denied') || message.includes('permission')) return GEOLOCATION_DENIED;
  if (message.includes('timeout')) return GEOLOCATION_TIMEOUT;
  if (message.includes('unavailable')) return GEOLOCATION_POSITION_UNAVAILABLE;
  return GEOLOCATION_UNKNOWN;
}

/**
 * User-facing toast text for a classified error.
 * @param {string} code
 * @returns {string}
 */
export function geolocationErrorMessage(code) {
  switch (code) {
    case GEOLOCATION_UNAVAILABLE:
      return 'Location not supported in this browser';
    case GEOLOCATION_DENIED:
      return 'Location permission denied';
    case GEOLOCATION_TIMEOUT:
      return 'Location request timed out';
    case GEOLOCATION_POSITION_UNAVAILABLE:
      return 'Location unavailable';
    default:
      return 'Could not get your location';
  }
}

/**
 * Normalize a GeolocationPosition into { lat, lon, accuracy, heading, speed, timestamp }.
 * @param {GeolocationPosition} position
 * @returns {{lat:number,lon:number,accuracy:number|null,heading:number|null,speed:number|null,timestamp:number}}
 */
export function normalizeGeolocationPosition(position) {
  const coords = position?.coords;
  if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
    throw new Error('Invalid geolocation position');
  }
  return {
    lat: coords.latitude,
    lon: coords.longitude,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
    heading: Number.isFinite(coords.heading) ? coords.heading : null,
    speed: Number.isFinite(coords.speed) ? coords.speed : null,
    timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
  };
}

/**
 * One-shot current position.
 * @param {object} [options]
 * @param {Geolocation} [options.geo]
 * @param {PositionOptions} [options.positionOptions]
 * @returns {Promise<{lat:number,lon:number,accuracy:number|null,heading:number|null,speed:number|null,timestamp:number}>}
 */
export function getCurrentBrowserPosition({
  geo = globalThis.navigator?.geolocation,
  positionOptions = DEFAULT_POSITION_OPTIONS,
} = {}) {
  if (!isGeolocationAvailable(geo)) {
    const err = new Error(geolocationErrorMessage(GEOLOCATION_UNAVAILABLE));
    err.code = GEOLOCATION_UNAVAILABLE;
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    geo.getCurrentPosition(
      (position) => {
        try {
          resolve(normalizeGeolocationPosition(position));
        } catch (err) {
          const wrapped = new Error(geolocationErrorMessage(GEOLOCATION_UNKNOWN));
          wrapped.code = GEOLOCATION_UNKNOWN;
          wrapped.cause = err;
          reject(wrapped);
        }
      },
      (error) => {
        const code = classifyGeolocationError(error);
        const err = new Error(geolocationErrorMessage(code));
        err.code = code;
        err.cause = error;
        reject(err);
      },
      positionOptions,
    );
  });
}

/**
 * Live watch. Caller must stop() when done.
 * @param {object} options
 * @param {(fix:{lat:number,lon:number,accuracy:number|null,heading:number|null,speed:number|null,timestamp:number}) => void} options.onUpdate
 * @param {(err:Error) => void} [options.onError]
 * @param {Geolocation} [options.geo]
 * @param {PositionOptions} [options.positionOptions]
 * @returns {{stop:() => void, watchId:number|null}}
 */
export function watchBrowserPosition({
  onUpdate,
  onError = null,
  geo = globalThis.navigator?.geolocation,
  positionOptions = DEFAULT_POSITION_OPTIONS,
} = {}) {
  if (typeof onUpdate !== 'function') {
    throw new Error('watchBrowserPosition requires onUpdate');
  }
  if (!isGeolocationAvailable(geo) || typeof geo.watchPosition !== 'function') {
    const err = new Error(geolocationErrorMessage(GEOLOCATION_UNAVAILABLE));
    err.code = GEOLOCATION_UNAVAILABLE;
    onError?.(err);
    return { stop() {}, watchId: null };
  }

  let stopped = false;
  const watchId = geo.watchPosition(
    (position) => {
      if (stopped) return;
      try {
        onUpdate(normalizeGeolocationPosition(position));
      } catch (err) {
        const wrapped = new Error(geolocationErrorMessage(GEOLOCATION_UNKNOWN));
        wrapped.code = GEOLOCATION_UNKNOWN;
        wrapped.cause = err;
        onError?.(wrapped);
      }
    },
    (error) => {
      if (stopped) return;
      const code = classifyGeolocationError(error);
      const err = new Error(geolocationErrorMessage(code));
      err.code = code;
      err.cause = error;
      onError?.(err);
    },
    positionOptions,
  );

  return {
    watchId,
    stop() {
      if (stopped) return;
      stopped = true;
      try { geo.clearWatch?.(watchId); } catch { /* no-op */ }
    },
  };
}

/**
 * Detect click vs long-press for the My Location control.
 * Short release (< holdMs) → 'click'. Held ≥ holdMs → 'hold' (fires once while pressed).
 * @param {object} options
 * @param {number} [options.holdMs=550]
 * @param {() => void} options.onClick
 * @param {() => void} options.onHold
 * @returns {{attach:(el:HTMLElement)=>() => void}}
 */
export function createPressGesture({ holdMs = 550, onClick, onHold } = {}) {
  if (typeof onClick !== 'function' || typeof onHold !== 'function') {
    throw new Error('createPressGesture requires onClick and onHold');
  }
  return {
    attach(el) {
      if (!el?.addEventListener) return () => {};
      let timer = null;
      let holdFired = false;
      let pointerId = null;

      const clear = () => {
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const onDown = (event) => {
        if (event.button != null && event.button !== 0) return;
        holdFired = false;
        pointerId = event.pointerId ?? 'mouse';
        clear();
        timer = setTimeout(() => {
          timer = null;
          holdFired = true;
          onHold();
        }, holdMs);
      };

      const onUp = (event) => {
        if (pointerId != null && event.pointerId != null && event.pointerId !== pointerId) return;
        const wasHold = holdFired;
        clear();
        pointerId = null;
        if (!wasHold) onClick();
        holdFired = false;
      };

      const onCancel = () => {
        clear();
        pointerId = null;
        holdFired = false;
      };

      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointerleave', onCancel);
      el.addEventListener('pointercancel', onCancel);
      el.addEventListener('contextmenu', (e) => e.preventDefault());

      return () => {
        clear();
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointerleave', onCancel);
        el.removeEventListener('pointercancel', onCancel);
      };
    },
  };
}
