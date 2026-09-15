import * as Cesium from 'cesium';

/**
 * @module selfLocate
 * @description Self-locate ("find my position") — purely client-side,
 * ephemeral, permission-gated. Never logged, stored, or transmitted.
 */

/**
 * Create self-locate control.
 * @param {object} options
 * @param {HTMLButtonElement} options.button Button with location-crosshair icon
 * @param {Cesium.Viewer} options.viewer Viewer to center
 * @param {Function} [options.showToast] Non-blocking feedback
 * @param {Function} [options.requestRender] Optional render request
 * @returns {{destroy: Function}}
 */
export function createSelfLocateControl({ button, viewer, showToast }) {
  if (!button || !viewer) {
    return { destroy() {} };
  }

  let destroyed = false;

  const onSuccess = (position) => {
    if (destroyed) return;
    const { latitude, longitude } = position.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      showToast?.('Location unavailable');
      button.removeAttribute('aria-busy');
      return;
    }
    try {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, 2000),
        duration: 1.6,
        orientation: {
          heading: viewer.camera.heading,
          pitch: Cesium.Math.toRadians(-45),
          roll: 0,
        },
      });
      showToast?.('Centered on your location');
    } catch {
      showToast?.('Could not center on your location');
    }
    button.removeAttribute('aria-busy');
  };

  const onError = (error) => {
    if (destroyed) return;
    button.removeAttribute('aria-busy');
    const code = error?.code;
    // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
    if (code === 1) {
      showToast?.(
        'Location permission denied — enable it in your browser settings',
      );
    } else if (code === 2) {
      showToast?.('Location unavailable — check your device location settings');
    } else if (code === 3) {
      showToast?.('Location request timed out — try again');
    } else {
      showToast?.('Could not get your location');
    }
  };

  const onClick = () => {
    if (destroyed) return;
    if (!('geolocation' in navigator)) {
      showToast?.('Geolocation is not supported in this browser');
      return;
    }
    button.setAttribute('aria-busy', 'true');
    // Do not pre-request permission: browser native prompt is triggered here only
    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
  };

  button.addEventListener('click', onClick);

  return {
    destroy() {
      destroyed = true;
      button.removeEventListener('click', onClick);
      button.removeAttribute('aria-busy');
    },
  };
}
