/** Test doubles for the AlphaEarth Change layer: Cesium, hosts and a source. */

export function fakeCesium() {
  const providers = [];
  return {
    providers,
    SingleTileImageryProvider: class {
      constructor(options) {
        this.options = options;
        providers.push(this);
      }
    },
    Rectangle: {
      fromDegrees: (west, south, east, north) => ({ west, south, east, north }),
    },
  };
}

export function fakeCollection() {
  const layers = [];
  return {
    layers,
    addImageryProvider(provider) {
      const layer = { provider, alpha: 1 };
      layers.push(layer);
      return layer;
    },
    remove(layer, destroy) {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      layer.destroyed = destroy;
      return index >= 0;
    },
  };
}

/** A renderer that records calls; `paintImpl` never needs a canvas. */
export function fakeRendererDeps() {
  const cesium = fakeCesium();
  const renders = [];
  return {
    cesium,
    renders,
    requestRender: (reason) => renders.push(reason),
    paintImpl: (_doc, grid, width, height, threshold) =>
      `data:fake/${width}x${height}@${threshold}`,
  };
}

/** A change payload as the server sends it: west half changed, east not. */
export function changePayload({
  from = 2018,
  to = 2024,
  width = 4,
  height = 2,
  box = { west: -97.64, south: 30.21, east: -97.6, north: 30.24 },
} = {}) {
  const grid = new Uint8Array(width * height);
  for (let j = 0; j < height; j += 1)
    for (let i = 0; i < width; i += 1)
      grid[j * width + i] = i < width / 2 ? 254 : 20;
  grid[grid.length - 1] = 255;
  return {
    from,
    to,
    ...box,
    width,
    height,
    level: 4,
    pixelMeters: 160,
    threshold: 0.35,
    detail: 'standard',
    encoding: 'u8-change-254-nodata-255-north-up',
    stats: { validFraction: 0.875, meanChange: 0.5, changedFraction: 0.571 },
    grid: Buffer.from(grid).toString('base64'),
  };
}

/** A source whose change requests wait until the test resolves them. */
export function fakeSource({ years = [2017, 2018, 2024] } = {}) {
  const requests = [];
  return {
    requests,
    listYears: async () => years,
    fetchChange(query) {
      return new Promise((resolve, reject) => {
        requests.push({ query, resolve, reject });
        query.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    },
  };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
