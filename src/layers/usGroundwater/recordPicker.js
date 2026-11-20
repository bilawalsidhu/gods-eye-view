/**
 * Wells whose screen position passes `distanceOf`, nearest first. `project`
 * gives where a well's marker is on the canvas, in pixels, or nothing when
 * it is not on screen.
 */
function nearest(project, wells, distanceOf) {
  const hits = [];
  for (const well of wells) {
    const point = project(well);
    const distance = point ? distanceOf(point) : Infinity;
    if (Number.isFinite(distance)) hits.push({ well, distance });
  }
  return hits
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        String(a.well.id).localeCompare(String(b.well.id)),
    )
    .map((hit) => hit.well);
}

/** Well markers within `radius` pixels of a click, nearest first. */
export function recordsAtPixel(project, wells, pixel, radius = 10) {
  return nearest(project, wells, (point) => {
    const distance = Math.hypot(point.x - pixel.x, point.y - pixel.y);
    return distance <= radius ? distance : Infinity;
  });
}

/** Up to `limit` well markers on the canvas, nearest its centre first. */
export function recordsOnScreen(project, wells, canvas, limit = 50) {
  const width = canvas?.clientWidth;
  const height = canvas?.clientHeight;
  if (!(width > 0 && height > 0)) return [];
  return nearest(project, wells, (point) =>
    point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height
      ? Math.hypot(point.x - width / 2, point.y - height / 2)
      : Infinity,
  ).slice(0, limit);
}

/** Several records under one click: publish the choices; the host draws them. */
export function createRecordPicker(onSelect, publishChoices = () => {}) {
  let generation = 0;
  function close() {
    generation++;
    publishChoices(null);
  }
  function choose(wells) {
    close();
    if (wells.length === 1) return onSelect(wells[0]);
    if (!wells.length) return false;
    const current = generation;
    publishChoices({
      records: wells.map((well) => ({
        id: String(well.id),
        label: well.name || String(well.id),
      })),
      select(id) {
        if (current !== generation) return;
        const well = wells.find((candidate) => String(candidate.id) === id);
        close();
        if (well) onSelect(well);
      },
      cancel: close,
    });
    return true;
  }
  return { choose, close };
}
