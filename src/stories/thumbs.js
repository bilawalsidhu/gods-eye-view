/**
 * Story card images, drawn from the imagery GEV is already showing: the Esri
 * World Imagery tiles around a story's place, cropped to the card. They are
 * the same tiles, from the same host, that GEV's Esri map draws (and credits
 * on screen); no other host is asked.
 */
import { ESRI_TILES } from '../maps/attribution.js';

const WIDTH = 320;
const HEIGHT = 180;
const TILE_SIZE = 256;
const TILE_TRIES = 3;

/** Esri World Imagery's tiles: Web Mercator, the ones GEV's Esri map draws. */
export const ESRI_TILE_URL = ESRI_TILES;
const ESRI_MAX_LEVEL = 19;

/** A zoom level that frames `range` metres of view, within the imagery's. */
export function thumbLevel(
  range,
  { minLevel = 0, maxLevel = ESRI_MAX_LEVEL } = {},
) {
  const level = Math.round(Math.log2(4e7 / Math.max(range || 1.6e7, 1)));
  return Math.max(minLevel, Math.min(maxLevel, Math.max(1, level)));
}

/**
 * Where a place sits in the Web Mercator tile grid at `level`, in tiles from
 * the top left (the whole part names the tile, the rest is inside it).
 * @returns {{x: number, y: number}}
 */
export function tilePosition(lon, lat, level) {
  const n = 2 ** level;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const phi = (clamped * Math.PI) / 180;
  const x = ((((lon + 180) / 360) % 1) + 1) % 1;
  const y = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  return { x: x * n, y: Math.min(Math.max(y, 0), 1 - 1e-12) * n };
}

const tileUrl = (x, y, level) =>
  ESRI_TILE_URL.replace('{z}', String(level))
    .replace('{y}', String(y))
    .replace('{x}', String(x));

/** One tile as an image the canvas may read back, or null. */
function loadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function tile(loadTile, x, y, level) {
  for (let i = 0; i < TILE_TRIES; i++) {
    const image = await loadTile(tileUrl(x, y, level), { x, y, level });
    if (image) return image;
    await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
  }
  return null;
}

/**
 * A card image for a place, or '' when the imagery cannot be read (a failed
 * request, imagery the browser will not let a page copy).
 * @param {{lat: number, lon: number, range?: number}} cover
 * @param {{loadTile?: (url: string, tile: {x: number, y: number, level: number}) =>
 *   Promise<CanvasImageSource | null>}} [options] `loadTile` fetches one tile
 *   (tests replace it).
 * @returns {Promise<string>}
 */
export async function drawThumb(cover, { loadTile = loadImage } = {}) {
  try {
    if (!Number.isFinite(cover?.lat) || !Number.isFinite(cover?.lon)) return '';
    const level = thumbLevel(cover.range);
    const at = tilePosition(cover.lon, cover.lat, level);
    const tx = Math.floor(at.x);
    const ty = Math.floor(at.y);
    // Where the place sits inside its tile, 0..1 from the top left.
    const u = at.x - tx;
    const v = at.y - ty;
    // A 2 × 2 block of tiles with the place in its middle tile quarter.
    const x0 = u < 0.5 ? tx - 1 : tx;
    const y0 = v < 0.5 ? ty - 1 : ty;
    const n = 2 ** level;
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#0b1620';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    // The place's pixel in the block, kept at the card's centre.
    const ox = WIDTH / 2 - (tx - x0 + u) * TILE_SIZE;
    const oy = HEIGHT / 2 - (ty - y0 + v) * TILE_SIZE;
    let drawn = 0;
    await Promise.all(
      [0, 1].flatMap((dy) =>
        [0, 1].map(async (dx) => {
          const y = y0 + dy;
          if (y < 0 || y >= n) return;
          const x = (((x0 + dx) % n) + n) % n;
          const image = await tile(loadTile, x, y, level);
          if (!image) return;
          try {
            ctx.drawImage(
              image,
              ox + dx * TILE_SIZE,
              oy + dy * TILE_SIZE,
              TILE_SIZE + 1,
              TILE_SIZE + 1,
            );
            drawn += 1;
          } finally {
            image.close?.();
          }
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
