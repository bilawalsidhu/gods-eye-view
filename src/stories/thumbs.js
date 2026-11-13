import * as Cesium from 'cesium';

/**
 * Story card images, drawn from the imagery GEV is already showing: the
 * base layer's tiles around a story's place, cropped to the card. No other
 * host is asked, and the imagery is the one GEV credits on screen.
 */
const WIDTH = 320;
const HEIGHT = 180;
const TILE_TRIES = 4;

/** A zoom level that frames `range` metres of view, within the provider's. */
export function thumbLevel(range, provider) {
  const level = Math.round(Math.log2(4e7 / Math.max(range || 1.6e7, 1)));
  const max = Number.isFinite(provider?.maximumLevel)
    ? provider.maximumLevel
    : 18;
  const min = Number.isFinite(provider?.minimumLevel)
    ? provider.minimumLevel
    : 0;
  return Math.max(min, Math.min(max, Math.max(1, level)));
}

async function tile(provider, x, y, level) {
  for (let i = 0; i < TILE_TRIES; i++) {
    // undefined: the request was throttled; ask again shortly.
    const image = await provider.requestImage(x, y, level);
    if (image) return image;
    await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
  }
  return null;
}

/**
 * A card image for a place, or '' when the imagery cannot be read (a provider
 * without tiles, a failed request, imagery the browser will not let a page
 * copy).
 * @param {object} provider A Cesium ImageryProvider.
 * @param {{lat: number, lon: number, range?: number}} cover
 * @returns {Promise<string>}
 */
export async function drawThumb(provider, cover) {
  try {
    const scheme = provider?.tilingScheme;
    if (!scheme || typeof provider.requestImage !== 'function') return '';
    const level = thumbLevel(cover.range, provider);
    const where = Cesium.Cartographic.fromDegrees(cover.lon, cover.lat);
    const at = scheme.positionToTileXY(where, level);
    if (!at) return '';
    const rect = scheme.tileXYToRectangle(at.x, at.y, level);
    // Where the place sits inside its tile, 0..1 from the top left.
    const u = (where.longitude - rect.west) / rect.width;
    const v = (rect.north - where.latitude) / rect.height;
    // A 2 × 2 block of tiles with the place in its middle tile quarter.
    const x0 = u < 0.5 ? at.x - 1 : at.x;
    const y0 = v < 0.5 ? at.y - 1 : at.y;
    const nx = scheme.getNumberOfXTilesAtLevel(level);
    const ny = scheme.getNumberOfYTilesAtLevel(level);
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#0b1620';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    // The place's pixel in the block, kept at the card's centre.
    const px = (at.x - x0 + u) * size;
    const py = (at.y - y0 + v) * size;
    const ox = WIDTH / 2 - px;
    const oy = HEIGHT / 2 - py;
    let drawn = 0;
    await Promise.all(
      [0, 1].flatMap((dy) =>
        [0, 1].map(async (dx) => {
          const ty = y0 + dy;
          if (ty < 0 || ty >= ny) return;
          const tx = (((x0 + dx) % nx) + nx) % nx;
          const image = await tile(provider, tx, ty, level);
          if (!image) return;
          // Cesium hands bitmaps over flipped for the GPU; turn them back.
          const flipped =
            typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
          const top = oy + dy * size;
          if (flipped) {
            ctx.save();
            ctx.translate(0, top + size);
            ctx.scale(1, -1);
            ctx.drawImage(image, ox + dx * size, 0, size + 1, size + 1);
            ctx.restore();
          } else ctx.drawImage(image, ox + dx * size, top, size + 1, size + 1);
          drawn += 1;
        }),
      ),
    );
    if (!drawn) return '';
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (error) {
    console.warn('Stories: no card image for this story', error);
    return '';
  }
}
