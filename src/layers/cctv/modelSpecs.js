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
 * FOV). This module vendors the records that the currently integrated public
 * catalogs publish hardware for — King County WA (Cohu, Bosch AUTODOME, Axis
 * Q6135-LE), plus the Bosch AUTODOME and Axis PTZ/multisensor models that
 * appear in Sarasota County FL and Sioux Falls SD open data; packs that
 * publish other hardware models can grow it, or vendor the full extract.
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
  {
    id: 'axis-p3707-pe',
    brand: 'Axis',
    model: 'P3707-PE',
    type: 'panoramic',
    url: 'https://www.cctv-database.com/camera/axis-p3707-pe/',
    aliases: ['AXIS P3707-PE', 'P3707-PE'],
    fov_deg: '108-54 horizontal per sensor (4x 1080p)',
    resolution: {
      mp: 8,
      w: 1920,
      h: 1080,
      label: '4x 2MP (8MP total; 4x 1080p)',
    },
    lens_count: 4,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'axis-q6000-e-mk-ii',
    brand: 'Axis',
    model: 'Q6000-E Mk II',
    type: 'panoramic',
    url: 'https://www.cctv-database.com/camera/axis-q6000-e-mk-ii/',
    aliases: [
      'AXIS Q6000-E Mk II',
      'Q6000-E Mk II 50 Hz',
      'Q6000-E Mk II 60 Hz',
    ],
    fov_deg: 'up to 360 combined; 113-152 horizontal per sensor',
    resolution: {
      mp: 8,
      w: 1920,
      h: 1080,
      label: '4x 2MP (8MP total; 4x 1080p)',
    },
    lens_count: 4,
    environment: ['outdoor'],
  },
  {
    id: 'axis-q6054-e',
    brand: 'Axis',
    model: 'Q6054-E',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/axis-q6054-e/',
    aliases: ['AXIS Q6054-E', 'Q6054-E 50 Hz', 'Q6054-E 60 Hz'],
    fov_deg: '62.9-2.2 horizontal',
    resolution: { mp: 1, w: 1280, h: 720, label: '720p HD' },
    ptz: true,
    autotracking: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'axis-q6155-e',
    brand: 'Axis',
    model: 'Q6155-E',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/axis-q6155-e/',
    aliases: ['AXIS Q6155-E', 'Q6155-E 50 Hz', 'Q6155-E 60 Hz'],
    fov_deg: '66.7-2.36 horizontal',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p HD' },
    ptz: true,
    autotracking: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'bosch-autodome-500i',
    brand: 'Bosch',
    model: 'AutoDome 500i Series (VG4)',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/bosch-autodome-500i/',
    aliases: [
      'VG4 AUTODOME',
      'VG4 AUTODOME H.264',
      'AutoDome 500i',
      'AutoDome 500i Series',
      'VG4-500i',
      'VG4-500',
    ],
    fov_deg: '57.8-1.7 horizontal',
    resolution: { mp: 0.4, label: '540 TVL (NTSC/PAL)' },
    ptz: true,
    autotracking: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'bosch-autodome-ip-dynamic-7000-hd',
    brand: 'Bosch',
    model: 'AUTODOME IP dynamic 7000 HD',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/bosch-autodome-ip-dynamic-7000-hd/',
    aliases: ['AUTODOME IP dynamic 7000 HD', 'AUTODOME 7000 dynamic HD'],
    fov_deg: '65-2.3 horizontal',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p HD (2MP)' },
    ptz: true,
    autotracking: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'bosch-autodome-ip-starlight-7000-hd',
    brand: 'Bosch',
    model: 'AUTODOME IP starlight 7000 HD',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/bosch-autodome-ip-starlight-7000-hd/',
    aliases: [
      'AUTODOME IP starlight 7000 HD',
      'Starlight 7000HD',
      'VG5-7130-CPT4',
      'VG5-7130',
    ],
    fov_deg: '59-2.1 horizontal',
    resolution: { mp: 1, w: 1280, h: 720, label: '720p HD (1.3MP sensor)' },
    ptz: true,
    autotracking: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'bosch-ndp-5502-30',
    brand: 'Bosch',
    model: 'AUTODOME IP 5000i (NDP-5502-Z30)',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/bosch-ndp-5502-30/',
    aliases: [
      'AUTODOME IP 5000i',
      'NDP-5502-Z30',
      'NDP-5502-Z30C',
      'NDP-5502-30',
    ],
    fov_deg: '60.9-2.4 horizontal',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p HD (2MP)' },
    ptz: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'bosch-ndp-7512-z30',
    brand: 'Bosch',
    model: 'AUTODOME IP starlight 7000i (NDP-7512-Z30)',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/bosch-ndp-7512-z30/',
    aliases: [
      'AUTODOME IP starlight 7000i',
      'NDP-7512-Z30',
      'NDP-7512-Z30C',
      'NDP-7512-Z30K',
    ],
    fov_deg: '64.7-2.3 horizontal',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p HD (2MP)' },
    ptz: true,
    autotracking: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'bosch-vg5-836-ecev',
    brand: 'Bosch',
    model: 'AUTODOME 800 Series HD PTZ (VG5-836-ECEV)',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/bosch-vg5-836-ecev/',
    aliases: ['VG5-836-ECEV', 'VG5-836', 'AUTODOME 800 Series'],
    resolution: { mp: 2, label: '1080p' },
    ptz: true,
    autotracking: true,
    environment: ['outdoor'],
  },
  {
    id: 'cohu-3920-idome',
    brand: 'Cohu',
    model: '3920 iDome',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/cohu-3920-idome/',
    aliases: [
      '3920',
      '3920 Series',
      '3923',
      '3925',
      '3925 Dome',
      'iDome 3925',
      'Cohu iDome 3920 Series',
    ],
    resolution: { mp: 0.4, label: 'NTSC / 470 TVL' },
    ptz: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'cohu-3950-iview',
    brand: 'Cohu',
    model: '3950 iVIEW',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/cohu-3950-iview/',
    aliases: ['3950', '3950 Series', 'Cohu 3950 Series iVIEW'],
    resolution: { mp: 0.4, label: 'NTSC / 470 TVL' },
    ptz: true,
    varifocal: true,
    environment: ['outdoor'],
  },
  {
    id: 'cohu-3960',
    brand: 'Cohu',
    model: '3960',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/cohu-3960/',
    aliases: ['3960 Series', '3964', '3965', 'Cohu 3960 iView'],
    resolution: { mp: 0.4, label: 'NTSC/PAL / 470 TVL' },
    ptz: true,
    varifocal: true,
    environment: ['outdoor'],
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
