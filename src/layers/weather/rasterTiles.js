import {
  weatherPixelSize,
  drawWeatherPixels,
  closeWeatherPixels,
} from './source.js';

/**
 * Draw one tile of the geographic scheme (two level-zero tiles) from a
 * decoded mosaic covering `bounds` (degrees), without network requests or
 * scene state. The part of a tile outside the mosaic stays transparent.
 * @param {CanvasImageSource & {width: number, height: number}} texture
 * @param {{west: number, south: number, east: number, north: number}} bounds
 * @param {{x: number, y: number, level: number}} tile
 * @param {HTMLCanvasElement} canvas Sized to the tile.
 */
export function drawMosaicTile(texture, bounds, { x, y, level }, canvas) {
  const size = 180 / 2 ** level;
  const west = -180 + x * size;
  const north = 90 - y * size;
  const perLon = texture.width / (bounds.east - bounds.west);
  const perLat = texture.height / (bounds.north - bounds.south);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    texture,
    (west - bounds.west) * perLon,
    (bounds.north - north) * perLat,
    size * perLon,
    size * perLat,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

/** A canvas's pixels as PNG bytes. */
async function canvasBytes(canvas) {
  const blob =
    typeof canvas.convertToBlob === 'function'
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve, reject) =>
          canvas.toBlob(
            (made) =>
              made ? resolve(made) : reject(new Error('Tile not encoded')),
            'image/png',
          ),
        );
  return blob.arrayBuffer();
}

/**
 * An imagery layer's `fetchTile` for one product time of a host frame source.
 * Supplied pixels are drawn into a new canvas and released, and handed to the
 * renderer as PNG bytes; a null tile is one shared transparent tile, drawn,
 * not missing, so no coarser tile shows through it. Aborting `signal` (or the
 * renderer's own) cancels the tile at the source, and a failed tile rejects,
 * which the renderer reports as its `tileError`.
 */
export function createFrameTileFetch({
  frameSource,
  product,
  time,
  createCanvas,
  tileSize = 256,
  signal,
}) {
  let empty = null;
  const canvas = () => {
    const tile = createCanvas();
    tile.width = tile.height = tileSize;
    return tile;
  };
  return async ({ tile: { x, y, level }, signal: tileSignal }) => {
    const signals = [signal, tileSignal].filter(Boolean);
    const both = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    both?.throwIfAborted();
    const pixels = await frameSource.getTile({
      product,
      time,
      z: level,
      x,
      y,
      size: tileSize,
      signal: both ?? new AbortController().signal,
    });
    if (pixels === null) {
      both?.throwIfAborted();
      // A failed encode is not kept: the next empty tile tries again.
      empty ??= canvasBytes(canvas()).catch((error) => {
        empty = null;
        throw error;
      });
      return { bytes: (await empty).slice(0), contentType: 'image/png' };
    }
    let tileCanvas;
    try {
      both?.throwIfAborted();
      const { width, height } = weatherPixelSize(pixels);
      if (width !== tileSize || height !== tileSize)
        throw new Error('Invalid weather tile dimensions');
      tileCanvas = canvas();
      drawWeatherPixels(tileCanvas.getContext('2d'), pixels);
    } finally {
      closeWeatherPixels(pixels);
    }
    return { bytes: await canvasBytes(tileCanvas), contentType: 'image/png' };
  };
}
