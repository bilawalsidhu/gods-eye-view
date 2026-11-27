/**
 * Sent on the document when someone picks a camera (a click on the globe,
 * next/previous on the Data Layers row, voice or Context's own lists):
 * Context opens that camera's card. `detail: {cameraId, explicitReselection?: boolean}`.
 * Voice explicitly announces a re-selection when the active camera stays the same.
 */
export const CCTV_SELECTED_EVENT = 'gev:cctv-selected';

export function announceCameraReselection(cameraId, previousId) {
  if (!cameraId || cameraId !== previousId) return false;
  globalThis.document?.dispatchEvent?.(
    new CustomEvent(CCTV_SELECTED_EVENT, {
      detail: { cameraId, explicitReselection: true },
    }),
  );
  return true;
}

/**
 * Sent on the document when a camera card moves the live video canvas into
 * its top image or back to its hidden home, so the video starts or stops.
 */
export const CCTV_VIDEO_HOST_EVENT = 'gev:cctv-video-host';

/** The visible Québec camera card mounted, changed camera, or closed. */
export const QUEBEC_CAMERA_HOST_EVENT = 'gev:quebec-camera-host';
