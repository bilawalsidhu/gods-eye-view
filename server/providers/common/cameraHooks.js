/**
 * Process-wide camera hooks. The CCTV proxy registers its catalog getter
 * and reports each frame/media outcome here; the coverage and camera-health
 * providers read from it. Only status words leave the CCTV proxy: no
 * pixels, URLs or upstream error text.
 */

let catalogGetter = null;
/** @type {Set<(sample: object) => void>} */
const listeners = new Set();

export function registerCameraCatalog(getter) {
  catalogGetter = typeof getter === 'function' ? getter : null;
}

/** @returns {Promise<object[]>} Normalized camera sources (empty if none). */
export async function cameraCatalog() {
  if (!catalogGetter) return [];
  try {
    const list = await catalogGetter();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function onCameraHealth(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * @param {string} camera Camera id.
 * @param {{status?: string, sourceKind?: string}} patch Health patch.
 */
export function reportCameraHealth(camera, patch) {
  if (!listeners.size) return;
  const sample = {
    camera: String(camera),
    t: Date.now(),
    ok: patch?.status === 'ok',
    status:
      typeof patch?.status === 'string' ? patch.status.slice(0, 16) : null,
    source:
      typeof patch?.sourceKind === 'string'
        ? patch.sourceKind.slice(0, 24)
        : null,
  };
  for (const fn of listeners) {
    try {
      fn(sample);
    } catch (error) {
      console.error('[camera-hooks]', error?.message);
    }
  }
}
