import { LOCAL_ADSB_DISPLAY_DISTANCE_M } from './render/display.js';

// On-demand QA snapshots of the cached local renderer state.
export function localAdsbQaDrawn(
  markers,
  models,
  { enabled, cameraPosition, isVisible },
) {
  const rows = [];
  for (const marker of markers.values()) {
    const position = marker.position;
    const distance =
      position && cameraPosition
        ? Math.hypot(
            position.x - cameraPosition.x,
            position.y - cameraPosition.y,
            position.z - cameraPosition.z,
          )
        : Infinity;
    const show = Boolean(
      enabled &&
      !marker.modelOwnsVisual &&
      isVisible(marker) &&
      distance <= LOCAL_ADSB_DISPLAY_DISTANCE_M,
    );
    const model = models?.get(marker.id);
    const matrix = model?.modelMatrix;
    rows.push({
      id: marker.record.icao,
      show,
      rotation: marker.lastRotation,
      alpha: show ? 1 : 0,
      position: position
        ? { x: position.x, y: position.y, z: position.z }
        : null,
      model: model
        ? {
            show: model.show,
            ready: model.ready,
            computedScale: model.computedScale,
            position: matrix
              ? { x: matrix[12], y: matrix[13], z: matrix[14] }
              : null,
            matrix: matrix ? Array.from(matrix) : null,
          }
        : null,
    });
  }
  return rows;
}
