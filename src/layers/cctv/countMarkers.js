import { createIconBook } from '../../render/motion/iconBook.js';
import {
  cellCenter,
  formatCameraCount,
  mergeCountCells,
} from '../../data/cctvCellCounts.js';
import { getLocale } from '../../i18n/index.js';
import {
  COUNT_MARKER_PX,
  COUNT_MERGE_DISTANCE_PX,
  COUNT_MERGE_PASSES,
} from './policy.js';

/** A pool of static count billboards sharing one canvas for each label. */
export function createCountMarkers(set) {
  const book = createIconBook(set);
  const images = new Map();
  const groups = [];
  let locale;

  /** Rasterise at twice the CSS size to keep small digits sharp. */
  function imageFor(text) {
    if (images.has(text)) return images.get(text);
    const canvas = document.createElement('canvas');
    const size = COUNT_MARKER_PX * 2;
    const ctx = canvas.getContext('2d');
    const font = 'bold 24px sans-serif';
    ctx.font = font;
    // A two-pixel ring survives the halving to screen size, and the clear
    // margin leaves its outer edge room to antialias inside the sprite.
    const ring = 4;
    const margin = 4;
    const inset = margin + ring / 2;
    // Up to three digits sit inside the circle; a longer label gets a pill
    // with room for its rounded ends.
    const textWidth = Math.ceil(ctx.measureText(text).width);
    const fitsCircle = textWidth <= size - 2 * (margin + ring) - 4;
    canvas.width = fitsCircle ? size : textWidth + 2 * (margin + ring + 12);
    canvas.height = size;
    ctx.beginPath();
    ctx.roundRect(
      inset,
      inset,
      canvas.width - 2 * inset,
      size - 2 * inset,
      size / 2 - inset,
    );
    // A dark rim outside the ring keeps it off bright ground.
    ctx.lineWidth = ring + 4;
    ctx.strokeStyle = 'rgba(8, 14, 20, 0.85)';
    ctx.stroke();
    ctx.fillStyle = '#0e1720';
    ctx.fill();
    ctx.lineWidth = ring;
    ctx.strokeStyle = '#75e7ff';
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, size / 2);
    const image = { canvas, key: `cctv-count:${text}` };
    images.set(text, image);
    return image;
  }

  /** Reuse the first slots for visible cells and hide the unused tail. */
  function update(cells, project) {
    const writes = [];
    const nextLocale = getLocale();
    let slot = 0;
    // Ground-key order keeps the pooled slots stable across pans and health changes.
    let visible = cells
      .filter((cell) => cell.count > 1)
      .sort((a, b) => a.key.localeCompare(b.key));
    const widthFor = (count) =>
      imageFor(formatCameraCount(count)).canvas.width / 2;
    for (
      let pass = 0;
      pass < COUNT_MERGE_PASSES && visible.length > 1;
      pass++
    ) {
      const merged = mergeCountCells(
        visible,
        project,
        widthFor,
        COUNT_MARKER_PX,
        COUNT_MERGE_DISTANCE_PX,
      );
      if (merged.length === visible.length) break;
      visible = merged;
    }
    for (const cell of visible) {
      const index = slot++;
      const last = groups[index];
      groups[index] = cell;
      // Bounds are live for picking even when the drawn label and mean stay put.
      if (
        nextLocale === locale &&
        last?.count === cell.count &&
        last.lonSum === cell.lonSum &&
        last.latSum === cell.latSum &&
        last.heightSum === cell.heightSum
      )
        continue;
      const id = `cctv-count:${index}`;
      const previous = book.item(id);
      const pos = cellCenter(cell);
      const image = imageFor(formatCameraCount(cell.count));
      const meta = previous?.meta ?? { aggregate: true, slot: index };
      meta.count = cell.count;
      writes.push({
        id,
        pos,
        image,
        meta,
        size: [image.canvas.width / 2, COUNT_MARKER_PX],
        disableDepthTest: Infinity,
        show: true,
        focus: previous?.focus,
      });
    }
    locale = nextLocale;
    groups.length = slot;
    for (let i = slot; i < book.size; i++) {
      const item = book.item(`cctv-count:${i}`);
      if (item.show) writes.push({ ...item, show: false });
    }
    book.putMany(writes);
    if (!book.show) book.show = true;
  }
  /** Resolve only a visible pooled billboard belonging to this layer. */
  function pickedCell(hit) {
    if (!book.show || !hit || hit.set !== book.setId) return null;
    const item = book.item(hit.id);
    return item?.show ? groups[item.meta.slot] : null;
  }
  return { book, update, pickedCell };
}
