/**
 * @module alprModelSpecs
 *
 * Datasheet specs for the ALPR hardware that OpenStreetMap `model` tags name,
 * vendored from the CCTV Camera Database (CC0-1.0) and matched with the CCTV
 * layer's rules; DATA_SOURCES.md has the provenance. Flock Safety publishes no
 * datasheet resolution, so Flock models stay unresolved; an unknown model
 * never implies anything.
 *
 * Scope guardrail: records describe camera PRODUCTS (optics, resolution,
 * night vision) — never endpoints, operators or what a camera records.
 */

import { createModelSpecLookup, lookupModelSpec } from '../cctv/modelSpecs.js';

/**
 * Records from the dataset's model-enrichment extract (v2.29.0), with the
 * bare product codes mappers tag ("L6Q") added as aliases where the title
 * names the product line ("Vigilant L6Q"). A tag without a generation or
 * variant could name any of them, so the SharpV G3 and SharpX XGA titles
 * carry theirs. Fields the card does not read (type, url, fov_deg, …) stay as
 * in the dataset, like the CCTV records.
 */
const RECORDS = [
  {
    id: 'motorola-solutions-l5f',
    brand: 'Motorola Solutions',
    model: 'Vigilant L5F',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/motorola-solutions-l5f/',
    aliases: ['L5F', 'L5F Fixed LPR Camera System'],
    resolution: { mp: 1.6, w: 1440, h: 1080 },
    lens_count: 2,
    night_vision: { type: 'ir' },
    environment: ['outdoor'],
  },
  {
    id: 'motorola-solutions-l5m',
    brand: 'Motorola Solutions',
    model: 'Vigilant L5M',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/motorola-solutions-l5m/',
    aliases: [
      'L5M',
      'L5M Mobile LPR Camera System',
      'L5M Mobile ANPR Camera System',
    ],
    resolution: { mp: 1.6, w: 1440, h: 1080 },
    lens_count: 2,
    night_vision: { type: 'ir' },
    environment: ['outdoor'],
  },
  {
    id: 'motorola-solutions-l5q',
    brand: 'Motorola Solutions',
    model: 'Vigilant L5Q',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/motorola-solutions-l5q/',
    aliases: ['L5Q', 'L5Q Quick Deploy LPR Camera System'],
    resolution: { mp: 3 },
    environment: ['outdoor'],
  },
  {
    id: 'motorola-solutions-l6d',
    brand: 'Motorola Solutions',
    model: 'Vigilant L6D',
    type: 'bullet',
    url: 'https://www.cctv-database.com/camera/motorola-solutions-l6d/',
    aliases: [
      'L6D',
      'L6D Dual-Purpose LPR Camera',
      'VSM-L6D-8IR',
      'VSM-L6D-7IR',
    ],
    fov_deg: '52-3 horizontal',
    resolution: { mp: 1.6, w: 1440, h: 1080 },
    lens_count: 2,
    varifocal: true,
    night_vision: { type: 'ir' },
    environment: ['outdoor'],
  },
  {
    id: 'motorola-solutions-l6q',
    brand: 'Motorola Solutions',
    model: 'Vigilant L6Q',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/motorola-solutions-l6q/',
    aliases: ['L6Q', 'L6Q Quick-Deploy LPR Camera System'],
    resolution: { mp: 2.1, w: 1920, h: 1080, label: '1080p' },
    night_vision: { type: 'ir' },
    environment: ['outdoor'],
  },
  {
    id: 'genetec-autovu-sharpv',
    brand: 'Genetec',
    model: 'AutoVu SharpV G3',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/genetec-autovu-sharpv/',
    aliases: [
      'AU-V-WS850-LC-G3-000',
      'AU-V-BS850-LC-G3-0M0',
      'AU-V-BS850-LC-G3-0M1',
    ],
    resolution: { mp: 2.3, w: 1920, h: 1200, label: '1920x1200' },
    lens_count: 2,
    night_vision: { type: 'ir' },
    environment: ['outdoor'],
  },
  {
    id: 'genetec-autovu-sharpv-g2',
    brand: 'Genetec',
    model: 'AutoVu SharpV G2',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/genetec-autovu-sharpv-g2/',
    aliases: ['AutoVu SharpV G1', 'AU-V-WS850-LC-G2', 'AU-V-WS850-LC'],
    resolution: { mp: 1.2, w: 1280, h: 960, label: '1280x960' },
    lens_count: 2,
    night_vision: { type: 'ir' },
    environment: ['outdoor'],
  },
  {
    id: 'genetec-autovu-sharpx',
    brand: 'Genetec',
    model: 'AutoVu SharpX XGA',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/genetec-autovu-sharpx/',
    // i18n-ignore: datasheet label
    resolution: { mp: 1, w: 1024, h: 946, label: 'XGA (1024x946)' },
    lens_count: 2,
    night_vision: { type: 'ir' },
    environment: ['outdoor'],
  },
  {
    id: 'genetec-autovu-sharpz3',
    brand: 'Genetec',
    model: 'AutoVu SharpZ3',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/genetec-autovu-sharpz3/',
    resolution: { mp: 1.6, w: 1456, h: 1088, label: '1456x1088' },
    lens_count: 3,
    night_vision: { type: 'ir' },
    environment: ['outdoor'],
  },
  {
    id: 'axis-q1700-le',
    brand: 'Axis',
    model: 'Q1700-LE',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/axis-q1700-le/',
    fov_deg: '16-2.3 horizontal / 9.6-1.3 vertical',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p' },
    varifocal: true,
    night_vision: { type: 'ir', range_m: 50 },
    environment: ['outdoor'],
    ndaa_compliant: true,
  },
  {
    id: 'axis-q1800-le',
    brand: 'Axis',
    model: 'Q1800-LE',
    type: 'bullet',
    url: 'https://www.cctv-database.com/camera/axis-q1800-le/',
    aliases: ['03107-001', 'Q1800-LE-3 (License Plate Verifier kit)'],
    fov_deg: '38-2.3 horizontal',
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p' },
    varifocal: true,
    night_vision: { type: 'ir', range_m: 40 },
    environment: ['indoor', 'outdoor'],
    ndaa_compliant: true,
  },
  {
    id: 'verkada-cb62-te-f',
    brand: 'Verkada',
    model: 'CB62-TE-F',
    type: 'bullet',
    url: 'https://www.cctv-database.com/camera/verkada-cb62-te-f/',
    fov_deg: '42 to 17 H',
    resolution: { mp: 8.3, w: 3840, h: 2160, label: '4K' },
    varifocal: true,
    night_vision: { type: 'ir', range_m: 50 },
    environment: ['outdoor'],
    ndaa_compliant: true,
  },
  {
    id: 'verkada-ch52-e-f',
    brand: 'Verkada',
    model: 'CH52-E-F',
    type: 'panoramic',
    url: 'https://www.cctv-database.com/camera/verkada-ch52-e-f/',
    fov_deg: '89 to 37 H (per sensor); up to 328 combined',
    // i18n-ignore: datasheet label
    resolution: { mp: 5, w: 2688, h: 1944, label: '4 x 5MP (20MP)' },
    lens_count: 4,
    varifocal: true,
    night_vision: { type: 'ir', range_m: 30 },
    environment: ['outdoor'],
    ndaa_compliant: true,
  },
  {
    id: 'verkada-cp63-e',
    brand: 'Verkada',
    model: 'CP63-E',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/verkada-cp63-e/',
    fov_deg: '64 to 2 H',
    resolution: { mp: 8.3, w: 3840, h: 2160, label: '4K' },
    ptz: true,
    varifocal: true,
    night_vision: { type: 'ir', range_m: 100 },
    environment: ['outdoor'],
    ndaa_compliant: true,
  },
  {
    id: 'verkada-cr63-e',
    brand: 'Verkada',
    model: 'CR63-E',
    type: 'bullet',
    url: 'https://www.cctv-database.com/camera/verkada-cr63-e/',
    fov_deg: '109 to 49 H',
    resolution: { mp: 8.3, w: 3840, h: 2160, label: '4K' },
    varifocal: true,
    night_vision: { type: 'ir', range_m: 20 },
    environment: ['indoor', 'outdoor'],
  },
  // The CCTV layer's record: one colour-neutral title for the B/G/W variants.
  lookupModelSpec('MIC-7522-Z30B', 'Bosch'),
];

const lookupDatasheetSpec = createModelSpecLookup(RECORDS);

/**
 * Datasheet record for a mapped ALPR camera's `model` tag. A `manufacturer`
 * naming another maker rejects the match, so a "Flock Safety" camera tagged
 * "L6Q" stays unresolved rather than borrowing Motorola's specs.
 * @param {string|null} model - The OSM `model` tag.
 * @param {string|null} [manufacturer] - The OSM `manufacturer` tag.
 * @returns {Object|null} The spec record, or null when unknown.
 */
export function lookupAlprModelSpec(model, manufacturer) {
  // Adapter records arrive unnormalized and the matcher's word trim is
  // quadratic on long punctuation runs: match only tag-sized strings (the
  // built-in sources keep 180 characters).
  if (typeof model !== 'string' || model.length > 180) return null;
  if (
    manufacturer != null &&
    (typeof manufacturer !== 'string' || manufacturer.length > 180)
  )
    return null;
  return lookupDatasheetSpec(model, manufacturer);
}
