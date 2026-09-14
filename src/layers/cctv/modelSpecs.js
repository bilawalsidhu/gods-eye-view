/**
 * @module cctvModelSpecs
 *
 * Hardware-model spec enrichment for the CCTV layer.
 *
 * When a catalog camera names its hardware model (source packs may set
 * `model`; hand-authored seeds may too), the model resolves to a datasheet
 * record: the camera's frustum then uses the manufacturer's horizontal FOV
 * instead of an estimate, and the HUD meta line gains the model's real specs.
 * Cameras without an identified model are untouched — unknown never implies
 * anything.
 *
 * Spec records are vendored verbatim from the CCTV Camera Database
 * (https://github.com/ch-bas/cctv-camera-database, CC0-1.0) — an open dataset
 * of 12,000+ camera models transcribed from manufacturer datasheets (84% with
 * FOV). This module ships a small starter table; city packs that publish
 * their hardware models can grow it, or vendor the full extract.
 *
 * Scope guardrail: records describe camera PRODUCTS (optics, resolution,
 * night vision) — never endpoints, stream paths, or access/config data.
 */

/** Verbatim records from the dataset's model-enrichment extract (v2.19.0). */
const RECORDS = [
  {
    id: 'axis-q6135-le',
    brand: 'Axis',
    model: 'Q6135-LE',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/axis-q6135-le/',
    aliases: ['01959-004'],
    fov_deg: '58.3-2.4 horizontal',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p' },
    ptz: true,
    autotracking: true,
    varifocal: true,
    night_vision: { type: 'ir', range_m: 250 },
    environment: ['outdoor'],
    ndaa_compliant: true,
  },
  {
    id: 'hanwha-xnp-6400rw',
    brand: 'Hanwha',
    model: 'XNP-6400RW',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/hanwha-xnp-6400rw/',
    aliases: ['Wisenet PTZ Plus 2MP 40x IR PTZ'],
    fov_deg: '65.66-1.88 horizontal / 39.4-1.09 vertical',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p' },
    ptz: true,
    autotracking: true,
    varifocal: true,
    night_vision: { type: 'ir', range_m: 200 },
    environment: ['outdoor'],
    ndaa_compliant: true,
  },
  {
    id: 'hikvision-ds-2cd2087g3-li2uy',
    brand: 'Hikvision',
    model: 'DS-2CD2087G3-LI2UY',
    type: 'bullet',
    url: 'https://www.cctv-database.com/camera/hikvision-ds-2cd2087g3-li2uy/',
    fov_deg: '108.8 horizontal (2.8mm) / 93.3 horizontal (4mm)',
    resolution: { mp: 8, w: 3840, h: 2160, label: '8MP (4K)' },
    night_vision: { type: 'color', range_m: 40 },
    environment: ['outdoor'],
    ndaa_compliant: false,
  },
  {
    id: 'axis-f4105-lre',
    brand: 'Axis',
    model: 'F4105-LRE',
    type: 'dome',
    url: 'https://www.cctv-database.com/camera/axis-f4105-lre/',
    fov_deg: '110 horizontal, 60 vertical',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p HD' },
    night_vision: { type: 'ir', range_m: 10 },
    environment: ['outdoor'],
    ndaa_compliant: true,
  },
];

const BY_MODEL = new Map();
for (const record of RECORDS) {
  BY_MODEL.set(record.model.toLowerCase(), record);
  for (const alias of record.aliases || [])
    BY_MODEL.set(alias.toLowerCase(), record);
}

/**
 * Looks up a spec record by model string (case-insensitive; aliases match too).
 * @param {string} model - Hardware model as named by a source pack or seed.
 * @returns {Object|null} The verbatim spec record, or null when unknown.
 */
export function lookupModelSpec(model) {
  if (!model) return null;
  return BY_MODEL.get(String(model).trim().toLowerCase()) || null;
}

/**
 * Datasheet horizontal FOV in degrees: the FIRST number in the `fov_deg`
 * string, which for varifocal/PTZ ranges ('58.3-2.4 horizontal') is the wide
 * end — the honest default for a coverage cone.
 * @param {Object} spec - A record from this module.
 * @returns {number|null} Wide-end horizontal FOV, or null when unstated.
 */
export function horizontalFovDeg(spec) {
  const match = String(spec?.fov_deg || '').match(/\d+(?:\.\d+)?/);
  const value = match ? Number(match[0]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * One-line spec summary for HUD meta text.
 * @param {Object} spec - A record from this module.
 * @returns {string} e.g. 'Axis Q6135-LE · 1080p · IR 250m · PTZ' ('' for null).
 */
export function specSummary(spec) {
  if (!spec) return '';
  const parts = [`${spec.brand} ${spec.model}`];
  if (spec.resolution?.label) parts.push(spec.resolution.label);
  if (spec.night_vision) {
    parts.push(
      `${spec.night_vision.type.toUpperCase()}${spec.night_vision.range_m ? ` ${spec.night_vision.range_m}m` : ''}`,
    );
  }
  if (spec.ptz) parts.push('PTZ');
  return parts.join(' · ');
}
