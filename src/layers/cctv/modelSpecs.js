/**
 * @module cctvModelSpecs
 *
 * Hardware-model spec enrichment for the CCTV layer.
 *
 * When a catalog camera names its hardware model (source packs may set
 * `model`; hand-authored seeds may too), the model resolves to a datasheet
 * record and the HUD meta line gains the model's real specs. A fixed-lens
 * model's horizontal FOV replaces the frustum's estimate; a PTZ/varifocal or
 * multi-sensor range is carried as capability metadata beside the estimate,
 * because the lens's current zoom is unknown.
 * Cameras without an identified model are untouched — unknown never implies
 * anything.
 *
 * Spec records are vendored verbatim from the CCTV Camera Database
 * (https://github.com/ch-bas/cctv-camera-database, CC0-1.0) — an open dataset
 * of 28,000+ camera models transcribed from manufacturer datasheets (84% with
 * FOV, as of v2.26.0). This module vendors the records that the currently integrated public
 * catalogs publish hardware for — King County WA (Cohu, Bosch AUTODOME, Axis
 * Q6135-LE), plus the Bosch AUTODOME and Axis PTZ/multisensor models that
 * appear in Sarasota County FL and Sioux Falls SD open data; packs that
 * publish other hardware models can grow it, or vendor the full extract.
 *
 * Scope guardrail: records describe camera PRODUCTS (optics, resolution,
 * night vision) — never endpoints, stream paths, or access/config data.
 */

/** Verbatim records from the dataset's model-enrichment extract (v2.26.0). */
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

/** Lowercase + collapse whitespace, the shared normal form for matching. */
function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Whitespace words of a name, lowercased, with surrounding punctuation trimmed
 * so "(NDP-7512-Z30)" reads as "ndp-7512-z30". Inner hyphens and dots stay:
 * "f4105-lre-unknown" is one word, never "f4105-lre" plus noise.
 * @param {string} value
 * @returns {string[]}
 */
function words(value) {
  return normalize(value)
    .split(' ')
    .map((raw) => raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(Boolean);
}

/**
 * Descriptor words that never identify hardware: product-type nouns, codec
 * and resolution/zoom/frequency tokens ("h.264", "2mp", "40x", "1080p").
 */
const GENERIC_WORDS = new Set([
  'network',
  'camera',
  'cam',
  'ip',
  'ptz',
  'dome',
  'bullet',
  'box',
  'hd',
  'ir',
  'outdoor',
  'indoor',
  'series',
]);

function isGeneric(word) {
  return (
    GENERIC_WORDS.has(word) ||
    /^h\.?\d+$/.test(word) ||
    /^\d+(?:\.\d+)?(?:mp|p|k|x|mm|hz|tvl)$/.test(word)
  );
}

/** A model code: letters AND digits, and not a generic descriptor. */
function isModelCode(word) {
  return /[a-z]/.test(word) && /\d/.test(word) && !isGeneric(word);
}

/** Hyphenated variant suffixes that do not change the hardware. */
const VARIANT_SUFFIXES = new Set(['50hz', '60hz', 'ntsc', 'pal']);

/** "q6155-e-60hz" → "q6155-e"; "f4105-lre-unknown" is left as is. */
function stripVariantSuffix(word) {
  let out = word;
  for (;;) {
    const cut = out.lastIndexOf('-');
    if (cut <= 0 || !VARIANT_SUFFIXES.has(out.slice(cut + 1))) return out;
    out = out.slice(0, cut);
  }
}

/** Manufacturer names (lowercased words) accepted for each record brand. */
const BRAND_ALIASES = {
  Hanwha: ['wisenet', 'samsung'],
  Hikvision: ['hiwatch'],
};

function brandWords(record) {
  return new Set([
    ...words(record.brand),
    ...(BRAND_ALIASES[record.brand] || []),
  ]);
}

/**
 * One entry per record name (model + aliases). `required` is every
 * non-generic word of the name — all must appear in a query, so a generation
 * or suffix ("Mk II", "7000i" vs "7000") is never dropped. `hasCode` marks
 * names carrying a letter+digit model code; names without one ("3950",
 * "01959-004", "AUTODOME 800 Series") match only when the brand does.
 */
const NAME_INDEX = RECORDS.flatMap((record) => {
  const brand = brandWords(record);
  return [record.model, ...(record.aliases || [])].map((name) => {
    const nameWords = words(name);
    return {
      record,
      brand,
      allowed: new Set(nameWords),
      required: nameWords.filter((word) => !isGeneric(word)),
      hasCode: nameWords.some(isModelCode),
    };
  });
});

/**
 * Looks up a spec record for a hardware-model string.
 *
 * A record name matches when every non-generic word of that name appears in
 * the query (case-insensitive, punctuation-trimmed) and every other query word
 * is generic or the record's brand. That lets a VERBOSE registry string
 * resolve — "AXIS Q6155-E PTZ Dome Network Camera" finds the Q6155-E — while
 * an unrelated code ("Q1615"), a generation suffix ("Mk II") or a longer part
 * number ("F4105-LRE-UNKNOWN") rejects the match. Codec, resolution and
 * product-type words never identify hardware on their own. A name with no
 * letter+digit model code ("3950") needs the brand, from `manufacturer` or the
 * query itself. A `manufacturer` that is not the record's brand always
 * rejects. Matches on two different records are ambiguous → null (never
 * guesses).
 * @param {string} model - Hardware model as named by a source pack or seed.
 * @param {string} [manufacturer] - The source's manufacturer, when published.
 * @returns {Object|null} The verbatim spec record, or null when unknown.
 */
export function lookupModelSpec(model, manufacturer) {
  const query = words(model).map(stripVariantSuffix);
  if (!query.length) return null;
  const maker = words(manufacturer);
  const found = new Set();
  for (const entry of NAME_INDEX) {
    const makerMatches = maker.some((word) => entry.brand.has(word));
    if (maker.length && !makerMatches) continue;
    if (
      !entry.hasCode &&
      !makerMatches &&
      !query.some((word) => entry.brand.has(word))
    )
      continue;
    if (!entry.required.length) continue;
    if (!entry.required.every((word) => query.includes(word))) continue;
    if (
      !query.every(
        (word) =>
          entry.allowed.has(word) || entry.brand.has(word) || isGeneric(word),
      )
    )
      continue;
    found.add(entry.record);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Datasheet horizontal FOV as the range the hardware can cover. Only
 * segments stating a horizontal figure count — vertical and "combined"
 * panoramic figures never do — and parenthesized lens/sensor notes are
 * ignored. A zoom ('58.3-2.4 horizontal') and a lens-option list
 * ('108.8 horizontal (2.8mm) / 93.3 horizontal (4mm)') both yield a range.
 * @param {Object} spec - A record from this module.
 * @returns {{minDeg:number, maxDeg:number}|null} Null when unstated.
 */
export function horizontalFovRangeDeg(spec) {
  const values = [];
  for (const segment of String(spec?.fov_deg || '').split(/[/;,]/)) {
    if (!/horizontal/i.test(segment)) continue;
    const figures = segment.replace(/\([^)]*\)/g, '').split(/horizontal/i)[0];
    for (const match of figures.matchAll(/\d+(?:\.\d+)?/g)) {
      const value = Number(match[0]);
      if (Number.isFinite(value) && value > 0) values.push(value);
    }
  }
  if (!values.length) return null;
  return { minDeg: Math.min(...values), maxDeg: Math.max(...values) };
}

/**
 * The datasheet horizontal FOV as the camera's CURRENT optical state, which
 * holds only for fixed single-lens hardware stating one figure. PTZ,
 * varifocal and multi-sensor models publish a capability range whose in-use
 * value is unknown — known hardware capability is not known pose state — so
 * they return null and keep their estimated FOV.
 * @param {Object} spec - A record from this module.
 * @returns {number|null} Fixed horizontal FOV in degrees, or null.
 */
export function fixedHorizontalFovDeg(spec) {
  if (!spec || spec.ptz || spec.varifocal || (spec.lens_count || 1) > 1)
    return null;
  const range = horizontalFovRangeDeg(spec);
  return range && range.minDeg === range.maxDeg ? range.minDeg : null;
}

/**
 * True when the camera's CURRENT FOV is the datasheet figure: it was filled
 * from a fixed-lens datasheet and no manual calibration offset has moved it.
 * @param {Object} camera - Catalog camera (see applyModelEnrichment).
 * @returns {boolean}
 */
export function isDatasheetFov(camera) {
  return camera?.fovSource === 'datasheet' && !camera.calibration?.fovDeg;
}

/**
 * HUD token for a datasheet FOV that describes capability rather than the
 * camera's current state, e.g. 'SPEC FOV 2.4–58° (CAPABILITY)'.
 * @param {Object} camera - Catalog camera (see applyModelEnrichment).
 * @returns {string|null} Null when the datasheet FOV already IS the camera's
 *   FOV (fixed lens) or no datasheet range is known.
 */
export function specFovCapabilityToken(camera) {
  if (!camera || camera.fovSource === 'datasheet') return null;
  const { specFovMinDeg: min, specFovMaxDeg: max } = camera;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const fmt = (deg) => (deg < 10 ? deg.toFixed(1) : String(Math.round(deg)));
  const span = min === max ? fmt(max) : `${fmt(min)}–${fmt(max)}`;
  return `SPEC FOV ${span}° (CAPABILITY)`;
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
