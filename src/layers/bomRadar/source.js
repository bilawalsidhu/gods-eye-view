import { msg } from '../../i18n/marker.js';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from '../../sources/httpBody.js';
import {
  BOM_LOOP_FRAMES,
  isBomFrameFile,
  isBomProduct,
  parseBomFrameName,
} from './records.js';

const API = '/api/bom-radar';
/** Shown while the operator has not opted in. */
export const BOM_RADAR_OFF_MESSAGE = msg(
  'BoM radar is off: set BOM_RADAR_ENABLED=1 (personal use only)',
);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const finiteIn = (value, limit) =>
  Number.isFinite(value) && Math.abs(value) <= limit;
const validPoint = (point) =>
  finiteIn(point?.lat, 90) && finiteIn(point?.lon, 180);

/** The local server reports BoM radar as not enabled. */
export class BomRadarDisabledError extends Error {
  constructor() {
    super(BOM_RADAR_OFF_MESSAGE);
    this.name = 'BomRadarDisabledError';
    this.code = 'disabled';
  }
}

/** Radars the proxy lists; centres arrive as the proxy learns them. */
export function validateBomProducts(value) {
  if (!value || !Array.isArray(value.radars) || value.radars.length > 400)
    throw new Error('Malformed BoM radar products');
  const radars = value.radars.map((radar) => {
    if (
      !radar ||
      typeof radar.id !== 'string' ||
      !/^\d{2,3}$/.test(radar.id) ||
      !Array.isArray(radar.products) ||
      !radar.products.length ||
      radar.products.length > 4 ||
      !radar.products.every(isBomProduct) ||
      (radar.center !== undefined && !validPoint(radar.center))
    )
      throw new Error('Malformed BoM radar products');
    return {
      id: radar.id,
      products: radar.products,
      ...(radar.center
        ? { center: { lat: radar.center.lat, lon: radar.center.lon } }
        : {}),
      ...(typeof radar.name === 'string' ? { name: radar.name } : {}),
    };
  });
  return {
    radars,
    complete: value.complete === true,
    stale: value.stale === true,
  };
}

/** Frame list for one product; every URL is rebuilt locally from its file name. */
export function validateBomFrames(value, product) {
  const bounds = value?.bounds;
  if (
    !value ||
    value.product !== product ||
    !isBomProduct(product) ||
    !bounds ||
    !finiteIn(bounds.west, 180) ||
    !finiteIn(bounds.east, 180) ||
    !finiteIn(bounds.south, 90) ||
    !finiteIn(bounds.north, 90) ||
    !(bounds.west < bounds.east) ||
    !(bounds.south < bounds.north) ||
    !Array.isArray(value.frames) ||
    value.frames.length > BOM_LOOP_FRAMES
  )
    throw new Error('Malformed BoM radar frames');
  let previous = -Infinity;
  const frames = value.frames.map((frame) => {
    const file = String(frame?.url ?? '').slice(`${API}/frame/`.length);
    const parsed = parseBomFrameName(file);
    const time = Date.parse(frame?.time);
    if (
      !parsed ||
      parsed.product !== product ||
      frame.url !== `${API}/frame/${file}` ||
      !Number.isFinite(time) ||
      time !== parsed.timeMs ||
      time <= previous
    )
      throw new Error('Malformed BoM radar frames');
    previous = time;
    return { file, timeMs: time, url: frameUrl(file) };
  });
  return {
    product,
    name: typeof value.name === 'string' ? value.name : null,
    rangeKm: Number.isFinite(value.rangeKm) ? value.rangeKm : null,
    center: validPoint(value.center) ? value.center : null,
    bounds: {
      west: bounds.west,
      south: bounds.south,
      east: bounds.east,
      north: bounds.north,
    },
    frames,
    stale: value.stale === true,
    listedAt: Number.isFinite(value.listedAt) ? value.listedAt : null,
  };
}

/** Same-origin URL of one frame, built only from a validated file name. */
export function frameUrl(file) {
  if (!isBomFrameFile(file)) throw new Error('Invalid BoM radar frame');
  return `${API}/frame/${file}`;
}

/** Same-origin, bounded client for the opt-in BoM radar proxy. */
export function createBomRadarSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function json(path, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${API}${path}`, {
      signal,
      cache: 'no-store',
      redirect: 'error',
    });
    if (response.status === 503) {
      await response.body?.cancel?.();
      throw new BomRadarDisabledError();
    }
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new Error(`BoM radar HTTP ${response.status}`);
    }
    return readResponseJsonCapped(response, MAX_JSON_BYTES, signal);
  }
  return {
    /** Whether the operator enabled the feature on this server. */
    async getStatus({ signal } = {}) {
      const body = await json('/status', signal);
      return { enabled: body?.enabled === true };
    },
    async getProducts({ signal } = {}) {
      return validateBomProducts(await json('/products', signal));
    },
    async getFrames({ product, signal } = {}) {
      if (!isBomProduct(product)) throw new Error('Invalid BoM radar product');
      return validateBomFrames(
        await json(`/frames?product=${product}`, signal),
        product,
      );
    },
    /** One frame's PNG bytes through the capped, signature-checked route. */
    async getFrameImage({ file, signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(frameUrl(file), {
        signal,
        redirect: 'error',
      });
      if (response.status === 503) throw new BomRadarDisabledError();
      if (!response.ok)
        throw new Error(`BoM radar frame HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (type.split(';')[0].trim().toLowerCase() !== 'image/png')
        throw new Error('BoM radar frame was not a PNG');
      const bytes = await readResponseBytesCapped(
        response,
        MAX_FRAME_BYTES,
        signal,
      );
      if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte))
        throw new Error('BoM radar frame was not a PNG');
      return bytes;
    },
  };
}
