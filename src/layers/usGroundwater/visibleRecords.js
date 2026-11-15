import * as Cesium from 'cesium';

/** Above this camera height wells show no records; counts stay in the panel. */
export const WELL_DETAIL_HEIGHT = 50000;

/** Hollow amber ring: a historical record location, not a verified well. */
export const WELL_MARKER_IMAGE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#f5b942" stroke-width="2"/></svg>',
  );

/**
 * Applies the detail-height gate to the wells data source and publishes the
 * on-screen records to the keyboard record list. Work runs after a render only
 * when the camera or canvas changed since the last check.
 */
export function createVisibleRecords(
  viewer,
  { onSelectRecord = () => {}, publishRecords = () => {} } = {},
) {
  let source,
    removeFrame,
    signature = '',
    lastView = '',
    presentation;
  function focusMap() {
    const canvas = viewer.scene.canvas;
    if (typeof canvas?.focus === 'function') {
      canvas.tabIndex = 0;
      canvas.focus();
    }
  }
  function focusRecord(id, focused) {
    const entity = source?.entities.getById(id);
    if (entity?.billboard) entity.billboard.scale = focused ? 1.8 : 1;
    viewer.scene.requestRender?.();
  }
  function cameraKey() {
    const canvas = viewer.scene.canvas;
    const matrix = viewer.camera.viewMatrix;
    return [
      viewer.camera.positionCartographic?.height,
      canvas?.clientWidth,
      canvas?.clientHeight,
      ...(matrix ? Cesium.Matrix4.toArray(matrix) : []),
    ].join(',');
  }
  function publish(force = false) {
    if (!source) return;
    const key = cameraKey();
    if (!force && key === lastView) return;
    lastView = key;
    const near =
      (viewer.camera.positionCartographic?.height ?? Infinity) <=
      WELL_DETAIL_HEIGHT;
    source.show = near;
    const canvas = viewer.scene.canvas;
    const visible = near
      ? source.entities.values.filter((e) => {
          const pos = e.position?.getValue?.(Cesium.JulianDate.now());
          const point = pos && viewer.scene.cartesianToCanvasCoordinates?.(pos);
          return (
            point &&
            canvas &&
            point.x >= 0 &&
            point.y >= 0 &&
            point.x <= canvas.clientWidth &&
            point.y <= canvas.clientHeight
          );
        })
      : [];
    const next = visible
      .map((e) => e.id + ':' + (e.gevWellRecordLabel || e.name))
      .join('|');
    if (next === signature) return;
    signature = next;
    presentation = visible.length
      ? {
          records: visible.map((e) => ({
            id: String(e.id),
            label: e.gevWellRecordLabel || e.name || String(e.id),
          })),
          disabled: false,
          focus: focusRecord,
          focusMap,
          select(id) {
            const entity = source?.entities.getById(id);
            if (entity) onSelectRecord(entity);
          },
        }
      : null;
    publishRecords(presentation);
  }
  /** Stop publishing. `retain` keeps the list on screen, disabled, for a redraw. */
  function clear(retain = false) {
    removeFrame?.();
    removeFrame = undefined;
    source = undefined;
    signature = null;
    lastView = '';
    if (!retain) {
      presentation = null;
      publishRecords(null);
    } else if (presentation)
      publishRecords({ ...presentation, disabled: true });
  }
  /** Publish the records currently in `owned`, then follow the camera. */
  function track(owned) {
    clear(true);
    source = owned;
    publish(true);
    removeFrame = viewer.scene.postRender?.addEventListener(() => publish());
  }
  return { track, clear };
}
