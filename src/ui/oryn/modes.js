// Visualization modes: presets that configure the real engine layers.
// A mode only names layers the catalog actually registers; applying it
// enables those and turns off the other mode-managed layers. Base imagery
// and user-only utilities are never touched.
import { t, msg } from '../../i18n/index.js';

export const MODES = Object.freeze([
  Object.freeze({
    id: 'globe',
    label: msg('Globe Overview'),
    description: msg('Full globe with whichever public layers you enable.'),
    enable: [],
    manage: false,
  }),
  Object.freeze({
    id: 'live-ops',
    label: msg('Live Operations'),
    description: msg(
      'Current hazards and traffic: earthquakes, fires, cyclones and aircraft.',
    ),
    enable: [
      'earthquakes',
      'local-firms',
      'fire-perimeters',
      'weather-cyclones',
      'flights',
    ],
    manage: true,
  }),
  Object.freeze({
    id: 'transportation',
    label: msg('Transportation'),
    description: msg(
      'Aircraft and maritime traffic with transit where available.',
    ),
    enable: ['flights', 'ais-live-vessels', 'transit'],
    manage: true,
  }),
  Object.freeze({
    id: 'environment',
    label: msg('Environment'),
    description: msg(
      'Earthquakes, fires, cyclones, air quality and weather radar.',
    ),
    enable: [
      'earthquakes',
      'local-firms',
      'fire-perimeters',
      'weather-cyclones',
      'air-quality',
      'weather-radar',
    ],
    manage: true,
  }),
  Object.freeze({
    id: 'municipal',
    label: msg('Municipal Operations'),
    description: msg(
      'Public camera poses, traffic and local infrastructure records.',
    ),
    enable: ['cctv', 'traffic', 'transit', 'bikeshare', 'local-dams'],
    manage: true,
  }),
  Object.freeze({
    id: 'agriculture',
    label: msg('Agriculture'),
    description: msg(
      'Recent satellite imagery and weather for field review. Vegetation indices need a configured source.',
    ),
    enable: ['recent-imagery', 'weather-satellite', 'wind'],
    manage: true,
  }),
  Object.freeze({
    id: 'investigation',
    label: msg('Investigation'),
    description: msg('Restores the layers of the active investigation scene.'),
    enable: [],
    manage: false,
  }),
  Object.freeze({
    id: 'custom',
    label: msg('Custom Workspace'),
    description: msg('Your own combination of layers, left unchanged.'),
    enable: [],
    manage: false,
  }),
]);

const MANAGED = new Set(MODES.flatMap((mode) => mode.enable));

export function modeById(id) {
  return MODES.find((mode) => mode.id === id) ?? MODES[0];
}

/**
 * Apply a mode to the engine. Returns the layers that could not be enabled
 * (unregistered or unavailable) so the UI can say so.
 */
export async function applyMode(engine, modeId) {
  const mode = modeById(modeId);
  const rows = engine.dataManager.getAll();
  const known = new Map(rows.map((row) => [row.id, row]));
  const skipped = [];
  const work = [];
  if (!mode.manage) return { mode, skipped };
  const wanted = new Set(mode.enable.filter((id) => known.has(id)));
  for (const id of mode.enable)
    if (!known.has(id)) skipped.push({ id, reason: t('not registered') });
  for (const id of MANAGED) {
    const row = known.get(id);
    if (!row) continue;
    const shouldEnable = wanted.has(id);
    if (shouldEnable === row.enabled) continue;
    if (shouldEnable && row.stats?.sourceUnavailable) {
      skipped.push({ id, reason: row.stats.error || t('source unavailable') });
      continue;
    }
    work.push(
      engine.setLayerEnabled(id, shouldEnable).catch((error) => {
        skipped.push({ id, reason: error?.message || String(error) });
      }),
    );
  }
  await Promise.all(work);
  return { mode, skipped };
}
