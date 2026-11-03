import * as Cesium from 'cesium';
/** Resolve overlapping loaded records, never aggregate representatives. */
export function recordsAtPixel(viewer, entities, pixel, radius = 10) {
  const now = Cesium.JulianDate.now();
  return entities
    .flatMap((entity) => {
      const pos = entity.position?.getValue?.(now);
      const point = pos && viewer.scene.cartesianToCanvasCoordinates?.(pos);
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
    .map((x) => x.entity);
}
/** Portable owner publishes plain choices; the host owns their UI. */
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
        label:
          entity.gevWellRecordLabel ||
          entity.gevLabelModel?.title ||
          entity.name ||
          String(entity.id),
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
