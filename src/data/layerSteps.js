/**
 * Cycle through an ordered list. With no selection, start at the first item
 * going forward or the last going back, unless the layer specifies a start.
 */
export function cycleIndex(currentIdx, step, count, missingIndex) {
  const total = Number.isFinite(count) ? Math.floor(count) : 0;
  if (total <= 0) return -1;
  const delta = Number.isFinite(step) ? Math.trunc(step) : 1;
  if (!Number.isFinite(currentIdx) || currentIdx < 0) {
    return missingIndex ?? (delta < 0 ? total - 1 : 0);
  }
  return (((Math.floor(currentIdx) + delta) % total) + total) % total;
}

/** Previous and Next actions for a Data Layers row, with localized labels. */
export function stepChips(noun, previousLabel, nextLabel, step, title) {
  const chip = (direction, label) => ({
    id: `${direction < 0 ? 'previous' : 'next'}-${noun}`,
    label,
    ...(title && { title }),
    icon: direction < 0 ? 'chevron_left' : 'chevron_right',
    action: true,
    onClick: () => step(direction),
  });
  return [chip(-1, previousLabel), chip(1, nextLabel)];
}
