/**
 * @file The bundled imaging-sensor pack: swath and resolution for the main
 * Earth-observation platforms, matched to satellites by NORAD number or name.
 *
 * Data: `local_data/imaging_sensors/imaging_sensors.json`; sources, licences
 * and curation in that folder's README. Loaded once, on demand, by the
 * satellites layer; a failed load is retried after a cooldown rather than
 * remembered for the session.
 *
 * @module data/imagingSensors
 */

import { indexImagingSensors } from '../layers/satellites/sensors.js';
import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';

const PACK_URL = new URL(
  './local_data/imaging_sensors/imaging_sensors.json',
  import.meta.url,
);

/** The pack, loaded and indexed once. */
export const loadImagingSensors = createRetryableLoader(async () =>
  indexImagingSensors(await loadBundledJson(PACK_URL)),
);
