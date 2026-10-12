/** Coordinates refer to the complete unchanged PNG, including its source caption. */
export function snapshotSelection(marks, width, height) {
  if (!(width > 0 && height > 0)) return null;
  for (let index = (marks?.length || 0) - 1; index >= 0; index--) {
    const mark = marks[index];
    if (!['marker', 'circle', 'region'].includes(mark?.mode)) continue;
    const points = (mark.points || []).filter(
      (p) =>
        Number.isFinite(p?.x) &&
        Number.isFinite(p?.y) &&
        p.x >= 0 &&
        p.x <= 1 &&
        p.y >= 0 &&
        p.y <= 1,
    );
    if (points.length < 2) continue;
    const x = Math.min(...points.map((p) => p.x)),
      y = Math.min(...points.map((p) => p.y));
    const right = Math.max(...points.map((p) => p.x)),
      bottom = Math.max(...points.map((p) => p.y));
    const sx = Math.min(width - 1, Math.floor(x * width)),
      sy = Math.min(height - 1, Math.floor(y * height));
    const sw = Math.min(width - sx, Math.ceil(right * width) - sx),
      sh = Math.min(height - sy, Math.ceil(bottom * height) - sy);
    if (sw < 3 || sh < 3) continue;
    return {
      markIndex: index,
      mode: mark.mode,
      x,
      y,
      w: right - x,
      h: bottom - y,
      pixelBounds: { x: sx, y: sy, width: sw, height: sh },
    };
  }
  return null;
}
