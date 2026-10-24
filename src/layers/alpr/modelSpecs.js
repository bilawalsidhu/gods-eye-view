/**
 * @module alprModelSpecs
 *
 * Datasheet specs for the ALPR hardware that OpenStreetMap mappers name.
 *
 * 1,567 mapped ALPR cameras carry a `model` tag (October 2026). This module
 * vendors the records for the models among them that the CCTV Camera Database
 * (https://github.com/ch-bas/cctv-camera-database, CC0-1.0) covers —
 * Motorola Solutions Vigilant, Genetec AutoVu, Axis, Verkada and Bosch MIC,
 * which resolve 459 of those cameras — and resolves a camera's `model` (with
 * its `manufacturer`) through the CCTV layer's matcher. The hourly extract the
 * layer reads by default does not publish `model` yet, so today only an
 * Overpass-backed source shows these specs. Flock Safety publishes no
 * datasheet resolution, so Flock models stay unresolved; an unknown model
 * never implies anything.
 *
 * Scope guardrail: records describe camera PRODUCTS (optics, resolution,
 * night vision) — never endpoints, operators or what a camera records.
 */

import { createModelSpecLookup } from '../cctv/modelSpecs.js';

/**
 * Verbatim records from the dataset's model-enrichment extract (v2.29.0).
 * Mappers tag the bare product code ("L6Q", "MIC-7522-Z30B") where the
 * datasheet names the product line too ("Vigilant L6Q"), so each record also
 * lists its bare code as an alias.
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
    model: 'AutoVu SharpV',
    type: 'box',
    url: 'https://www.cctv-database.com/camera/genetec-autovu-sharpv/',
    aliases: [
      'AutoVu SharpV G3',
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
    model: 'AutoVu SharpX',
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
  {
    id: 'bosch-mic-7522-z30b',
    brand: 'Bosch',
    model: 'MIC IP starlight 7100i (MIC-7522-Z30B)',
    type: 'ptz',
    url: 'https://www.cctv-database.com/camera/bosch-mic-7522-z30b/',
    aliases: ['MIC-7522-Z30B'],
    fov_deg: '2.1-58.3',
    // i18n-ignore: datasheet label
    resolution: { mp: 2, w: 1920, h: 1080, label: '1080p HD' },
    ptz: true,
    varifocal: true,
    night_vision: { type: 'color' },
    environment: ['outdoor'],
    ndaa_compliant: true,
  },
];

/**
 * Datasheet record for a mapped ALPR camera's `model` tag. A `manufacturer`
 * naming another maker rejects the match, so a "Flock Safety" camera tagged
 * "L6Q" stays unresolved rather than borrowing Motorola's specs.
 * @param {string|null} model - The OSM `model` tag.
 * @param {string|null} [manufacturer] - The OSM `manufacturer` tag.
 * @returns {Object|null} The verbatim spec record, or null when unknown.
 */
export const lookupAlprModelSpec = createModelSpecLookup(RECORDS);
