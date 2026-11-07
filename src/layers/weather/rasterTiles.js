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
