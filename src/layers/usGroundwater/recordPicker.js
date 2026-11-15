import * as Cesium from 'cesium';

const screenPoint = (viewer, entity) => {
  const position = entity.position?.getValue?.(Cesium.JulianDate.now());
  return position && viewer.scene.cartesianToCanvasCoordinates?.(position);
};

/** Well markers within `radius` pixels of a click, nearest first. */
export function recordsAtPixel(viewer, entities, pixel, radius = 10) {
  return entities
    .flatMap((entity) => {
      const point = screenPoint(viewer, entity);
      const distance = point
        ? Math.hypot(point.x - pixel.x, point.y - pixel.y)
        : Infinity;
      return distance <= radius ? [{ entity, distance }] : [];
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        String(a.entity.id).localeCompare(String(b.entity.id)),
    )
    .map((hit) => hit.entity);
}

/** Up to `limit` well markers on the canvas, nearest its centre first. */
export function recordsOnScreen(viewer, entities, limit = 50) {
  const canvas = viewer.scene.canvas;
  const width = canvas?.clientWidth;
  const height = canvas?.clientHeight;
  if (!(width > 0 && height > 0)) return [];
  return entities
    .flatMap((entity) => {
      const point = screenPoint(viewer, entity);
      return point &&
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= width &&
        point.y <= height
        ? [
            {
              entity,
              distance: Math.hypot(point.x - width / 2, point.y - height / 2),
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        String(a.entity.id).localeCompare(String(b.entity.id)),
    )
    .slice(0, limit)
    .map((hit) => hit.entity);
}

/** Several records under one click: publish the choices; the host draws them. */
export function createRecordPicker(onSelect, publishChoices = () => {}) {
  let generation = 0;
  function close() {
    generation++;
    publishChoices(null);
  }
  function choose(entities) {
    close();
    if (entities.length === 1) return onSelect(entities[0]);
    if (!entities.length) return false;
    const current = generation;
    publishChoices({
      records: entities.map((entity) => ({
        id: String(entity.id),
        label: entity.name || String(entity.id),
      })),
      select(id) {
        if (current !== generation) return;
        const entity = entities.find((e) => String(e.id) === id);
        close();
        if (entity) onSelect(entity);
      },
      cancel: close,
    });
    return true;
  }
  return { choose, close };
}
