import { t } from '../i18n/index.js';
import { contextAgeText } from './contextTime.js';
import { inspectorFeedLabel } from './layerRowState.js';

// Field layers have no item kind of their own, so no icon of their own.
export const FIELD_ICONS = Object.freeze({
  wind: 'air',
  'gnss-integrity': 'my_location',
  'recent-imagery': 'satellite_alt',
  'air-quality': 'eco',
});

// Readings that are observations, whose age is worth showing.
const OBSERVED = new Set(['air-quality', 'gnss-integrity']);

// A layer's own band colour (its legend's), as a plain hex colour.
export const LEGEND_COLOR = /^#[0-9a-f]{3,8}$/i;

/**
 * A field layer's reading at a point (`store.valueAt`), worded as the
 * Context panel shows it: `{value, detail, age}`, plus `{level, color}` for a
 * value in one of the layer's legend bands, `{short, measure}` when the layer
 * words it in short too, and `empty` for no value, or null
 * for a layer that is not a field. A read that failed shows the layer's feed
 * state, never a value. With `omitOutsideCoverage`, a point the layer says is
 * outside its coverage (`outsideCoverage`) has no reading either.
 * @param {object|null|undefined} found What `valueAt` returned.
 * @param {{id: string, tone: string, toneText: string}} layer
 * @param {{emptyValue?: string, emptyDetail?: string, now?: number,
 *   omitOutsideCoverage?: boolean}} [words]
 */
export function fieldReading(
  found,
  layer,
  {
    emptyValue = '—',
    emptyDetail = '',
    now = Date.now(),
    omitOutsideCoverage = false,
  } = {},
) {
  if (found === undefined) return null;
  if (omitOutsideCoverage && found?.outsideCoverage === true) return null;
  // Still loading: no reading yet, which is not "no value".
  if (found === null && layer.tone === 'loading')
    return { value: '…', detail: '', age: '', empty: true };
  if (
    found?.readFailed ||
    (found === null && ['unavailable', 'degraded'].includes(layer.tone))
  ) {
    const healthy = layer.tone === 'nominal' || layer.tone === 'loading';
    return {
      value: healthy ? inspectorFeedLabel('unavailable') : layer.toneText,
      detail: '',
      age: '',
      failed: true,
      failedTone: healthy ? 'unavailable' : layer.tone,
    };
  }
  const age =
    OBSERVED.has(layer.id) && Number.isFinite(found?.at)
      ? t('Updated {age}', { age: contextAgeText(Math.max(0, now - found.at)) })
      : '';
  const band =
    found?.value &&
    typeof found.level === 'string' &&
    LEGEND_COLOR.test(found.color)
      ? { level: found.level, color: found.color }
      : {};
  // A band in short (`short`, "< 2%") and the name of what it measures
  // (`measure`), for a place too narrow for the whole value.
  const words = Object.fromEntries(
    ['short', 'measure']
      .filter(
        (key) => found?.value && typeof found[key] === 'string' && found[key],
      )
      .map((key) => [key, found[key]]),
  );
  return {
    value: found?.value || (found?.reason ? '—' : emptyValue),
    detail: found?.reason || found?.detail || (found?.value ? '' : emptyDetail),
    age,
    ...(found?.value && found.stale && layer.tone === 'nominal'
      ? { tone: 'stale', toneText: inspectorFeedLabel('stale') }
      : {}),
    ...words,
    ...(found?.value ? band : { empty: true }),
  };
}
