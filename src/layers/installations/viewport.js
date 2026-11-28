import { findCamera } from '../../render/rendererOf.js';
import { REQUEST_DEBOUNCE_MS } from './policy.js';
import { installationAnchorBox } from './source.js';
import { createUnavailableRetry } from '../../data/unavailableRetry.js';

export function createViewport({ state: layerState, services, parts, source }) {
  /**
   * The area this load describes: the window around a Contacts subject while
   * one is set (a follow or Cockpit camera never settles and often looks at the
   * horizon), otherwise the settled camera viewport.
   * @param {object} viewer Viewer.
   * @returns {{box: object|null, coverage: object}} Query box and its coverage.
   */
  function loadArea(viewer) {
    const anchor = layerState.contextAnchor;
    if (anchor) {
      const box = installationAnchorBox(anchor);
      if (box) {
        const { radiusM, ...bounds } = box;
        return { box: bounds, coverage: { kind: 'subject', radiusM } };
      }
    }
    return { box: viewportBox(viewer), coverage: { kind: 'viewport' } };
  }

  function viewportBox(viewer) {
    const rectangle = findCamera(viewer)?.viewRectangle();
    if (!rectangle) return null;
    const { south, north, west, east } = rectangle;
    // Wide and dateline views use the bundled point index.
    if (
      !Number.isFinite(south + north + west + east) ||
      east === west ||
      north <= south
    )
      return null;
    return { south, west, north, east };
  }

  const retry = createUnavailableRetry(layerState, () =>
    parts.ingestion.loadInstallations(),
  );

  function scheduleLoad() {
    if (!layerState.enabled) return;
    const { box, coverage } = loadArea(layerState.viewer);
    const wide =
      coverage.kind === 'viewport' &&
      box &&
      (box.east < box.west ||
        box.east - box.west > 10 ||
        box.north - box.south > 10);
    const pose = wide ? findCamera(layerState.viewer)?.pose() : null;
    const widePose = pose
      ? [pose.position, pose.direction]
          .map((v) =>
            v ? [v.x, v.y, v.z].map((n) => n.toFixed(4)).join(',') : '',
          )
          .join(':')
      : '';
    const key = `${coverage.kind}:${box ? [box.south, box.west, box.north, box.east].map((v) => v.toFixed(6)).join(',') : 'wide'}:${widePose}`;
    if (layerState.cameraLoadKey === key && !layerState.error) return;
    layerState.cameraLoadKey = key;
    layerState.cameraLoadOwner = {};
    layerState.abort?.abort();
    // A user-driven load supersedes any pending retry; the load reschedules on
    // failure, so the backoff step is kept rather than reset.
    retry.clear({ resetBackoff: false });
    clearTimeout(layerState.timer);
    layerState.timer = setTimeout(() => {
      layerState.timer = null;
      parts.ingestion.loadInstallations();
    }, REQUEST_DEBOUNCE_MS);
  }
  return {
    loadArea,
    viewportBox,
    scheduleUnavailableRetry: (retryAfterMs) =>
      retry.schedule(retryAfterMs ?? 0),
    clearUnavailableRetry: retry.clear,
    scheduleLoad,
  };
}
