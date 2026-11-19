// Shared by browser viewport queries and the provider's cache-key validation.
export const WILDLIFE_MAX_VIEW_DEGREES = 40;

const cleanDegree = (value) => Math.round(value * 1e8) / 1e8;
const spanOf = (box) => Math.max(box.north - box.south, box.east - box.west);

/** Snap non-crossing boxes outward to one canonical grid. Validate the final
 * span too: a legal raw box may expand past the supported query size. */
export function snapWildlifeBox(box) {
  if (
    !box ||
    !['south', 'west', 'north', 'east'].every((key) =>
      Number.isFinite(box[key]),
    ) ||
    box.south < -90 ||
    box.north > 90 ||
    box.west < -180 ||
    box.east > 180 ||
    box.north <= box.south ||
    box.east <= box.west ||
    spanOf(box) > WILDLIFE_MAX_VIEW_DEGREES + 1e-8
  )
    return null;
  let grid = spanOf(box) > 5 ? 1 : 0.1;
  const snap = () => ({
    south: Math.max(
      -90,
      cleanDegree(Math.floor((box.south + 1e-10) / grid) * grid),
    ),
    west: Math.max(
      -180,
      cleanDegree(Math.floor((box.west + 1e-10) / grid) * grid),
    ),
    north: Math.min(
      90,
      cleanDegree(Math.ceil((box.north - 1e-10) / grid) * grid),
    ),
    east: Math.min(
      180,
      cleanDegree(Math.ceil((box.east - 1e-10) / grid) * grid),
    ),
  });
  let snapped = snap();
  // Crossing the five-degree boundary while snapping must pick the same grid
  // on the browser and proxy, and on every subsequent snap of this box.
  if (grid === 0.1 && spanOf(snapped) > 5 + 1e-8) {
    grid = 1;
    snapped = snap();
  }
  return spanOf(snapped) <= WILDLIFE_MAX_VIEW_DEGREES ? snapped : null;
}
