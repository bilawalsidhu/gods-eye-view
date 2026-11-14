import * as Cesium from 'cesium';
import { validateCountView } from './countGrids.js';

export const circleDiameter = () => 10;
export const circleLabel = () => '';
export const WELL_DETAIL_HEIGHT = 50000;
const SOURCE = 'us-groundwater-counts';
export function padGroupBounds(bounds) {
  const b = [...bounds];
  const minSpan = 0.01;
  const longitudeSpan = b[2] - b[0] === 360 ? 360 : (b[2] - b[0] + 360) % 360;
  if (longitudeSpan < minSpan) {
    const mid = ((b[0] + longitudeSpan / 2 + 540) % 360) - 180;
    b[0] = ((mid - minSpan / 2 + 540) % 360) - 180;
    b[2] = ((mid + minSpan / 2 + 540) % 360) - 180;
  }
  if (b[3] - b[1] < minSpan) {
    const mid = (b[1] + b[3]) / 2;
    b[1] = Math.max(-90, Math.min(90 - minSpan, mid - minSpan / 2));
    b[3] = b[1] + minSpan;
  }
  return b;
}
export function wellMarkerImage(hasReadings, uncertain = false) {
  const fill = uncertain ? 'none' : hasReadings ? '#56b4e9' : '#c6d0d4';
  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="${fill}" stroke="${uncertain ? '#f5b942' : '#071b25'}" stroke-width="2"/></svg>`,
    )
  );
}
/** Counts remain transport evidence; only admitted source positions are rendered. */
export function createCountRenderer(
  viewer,
  { overlays, onSelectRecord = () => {}, publishRecords = () => {} } = {},
) {
  let source,
    removeFrame,
    removeEnd,
    signature = '',
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
  function publish() {
    if (!source) return;
    const near =
      (viewer.camera.positionCartographic?.height ?? Infinity) <=
      WELL_DETAIL_HEIGHT;
    source.show = near;
    const visible = near
      ? source.entities.values.filter((e) => {
          if (String(e.id).startsWith('well-cell:')) return false;
          const pos = e.position?.getValue?.(Cesium.JulianDate.now());
          const point = pos && viewer.scene.cartesianToCanvasCoordinates?.(pos);
          const canvas = viewer.scene.canvas;
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
  function clear(retain = false) {
    removeFrame?.();
    removeEnd?.();
    removeFrame = removeEnd = undefined;
    if (source) source.clustering.enabled = false;
    source = undefined;
    signature = null;
    if (!retain) {
      presentation = null;
      publishRecords(null);
    } else if (presentation)
      publishRecords({ ...presentation, disabled: true });
    overlays?.clearOverlaySource('us-groundwater-counts');
    overlays?.setOverlaySourceVisible?.('us-groundwater-counts', false);
  }
  function draw(view, owned, retainDetails = false) {
    validateCountView(view);
    clear(true);
    source = owned;
    if (!retainDetails) owned.entities.removeAll();
    owned.clustering.enabled = false;
    publish();
    removeFrame = viewer.scene.postRender?.addEventListener(publish);
    removeEnd = viewer.camera.moveEnd?.addEventListener(publish);
  }
  return {
    draw,
    clear,
    zoom: () => false,
    describeDetails: () => {},
    getStats: () => ({
      groups: 0,
      aggregateInputs: 0,
      recordCount: source?.entities.values.length ?? 0,
    }),
  };
}
