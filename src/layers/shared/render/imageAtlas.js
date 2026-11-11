// Sprite atlases for the engine's mover sets: images packed into a grid of
// square cells, each `pad` px into its cell, with the [u0, v0, u1, v1]
// rectangle of every image.

/**
 * The atlas layout (pure). Each entry is `{ key, width, height }`, the
 * drawn size of its image.
 * @param {{ key: string, width: number, height: number }[]} entries
 * @param {{ cell: number, pad?: number, columns?: number }} options
 * @returns {{ width: number, height: number,
 *   rects: { key: string, x: number, y: number, width: number, height: number }[],
 *   cells: Record<string, number[]> }}
 */
export function imageAtlasLayout(
  entries,
  { cell, pad = 2, columns = Math.ceil(Math.sqrt(entries.length)) },
) {
  const width = columns * cell;
  const height = Math.ceil(entries.length / columns) * cell;
  const cells = {};
  const rects = entries.map((entry, index) => {
    const x = (index % columns) * cell + pad;
    const y = Math.floor(index / columns) * cell + pad;
    cells[entry.key] = [
      x / width,
      y / height,
      (x + entry.width) / width,
      (y + entry.height) / height,
    ];
    return { key: entry.key, x, y, width: entry.width, height: entry.height };
  });
  return { width, height, rects, cells };
}

/**
 * Draws `{ key, image, width, height }` entries into one canvas at
 * imageAtlasLayout's cells: at the image's own size, or scaled to
 * width × height with `resize`.
 * @returns {{ canvas: object, cells: Record<string, number[]> }}
 */
export function packImageAtlas(
  entries,
  { canvas = document.createElement('canvas'), resize = false, ...options },
) {
  const layout = imageAtlasLayout(entries, options);
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Sprite atlas requires a canvas');
  entries.forEach(({ image }, index) => {
    const { x, y, width, height } = layout.rects[index];
    if (resize) context.drawImage(image, x, y, width, height);
    else context.drawImage(image, x, y);
  });
  return { canvas, cells: layout.cells };
}

/** Decodes image URLs (browser). */
export const decodeImages = (urls) =>
  Promise.all(
    urls.map(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    }),
  );
