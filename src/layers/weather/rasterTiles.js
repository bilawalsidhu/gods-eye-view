/** Tile a bounded decoded canvas without network requests or scene state. */
export function createRasterTileProvider({
  cesium,
  texture,
  credit,
  createCanvas,
  rectangle = cesium.Rectangle.MAX_VALUE,
  tilingScheme = new cesium.GeographicTilingScheme({ rectangle }),
  maximumLevel = 2,
  tileSize = 256,
}) {
  return {
    tilingScheme,
    rectangle,
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    tileDiscardPolicy: undefined,
    credit,
    errorEvent: new cesium.Event(),
    hasAlphaChannel: true,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    requestImage(x, y, level) {
      const tile = createCanvas();
      tile.width = tile.height = tileSize;
      const ctx = tile.getContext('2d');
      const width =
        texture.width / tilingScheme.getNumberOfXTilesAtLevel(level);
      const height =
        texture.height / tilingScheme.getNumberOfYTilesAtLevel(level);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        texture,
        x * width,
        y * height,
        width,
        height,
        0,
        0,
        tileSize,
        tileSize,
      );
      // ImageryLayer consumes requestImage results as promises.
      return Promise.resolve(tile);
    },
  };
}
