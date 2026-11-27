import { t } from '../i18n/index.js';
import { SINCE_STOPS } from './streetLevelPresentation.js';

/**
 * Provider chips, filters, coverage status and OPEN on the Data Layers row.
 * @param {object|null} view The presented layer (`presentStreetLevel`).
 * @param {{toggleProvider: (id: string) => void, openNearest: (() => void)|null}} handlers
 * @returns {object|null} Layer row controls.
 */
export function streetLevelRowControls(view, handlers) {
  if (!view) return null;
  const chips = view.providers.map((provider) => ({
    ...provider,
    id: `sl-provider-${provider.id}`,
    onClick: () => handlers.toggleProvider(provider.id),
  }));
  if (view.nearest.visible && handlers.openNearest)
    chips.push({
      id: 'sl-open-nearest',
      label: view.nearest.label,
      title: view.nearest.title,
      action: true,
      disabled: Boolean(view.nearest.disabled),
      state: 'idle',
      onClick: () => handlers.openNearest(),
    });
  const filtersOff = Boolean(view.controlsDisabled);
  const pano = view.filter.pano || 'all';
  const segmented = view.filterControls.pano
    ? {
        id: 'sl-pano',
        label: t('IMAGERY'),
        ariaLabel: t('Panorama filter'),
        keyboard: 'radio',
        options: [
          ['all', t('ALL')],
          ['pano', '360°'],
          ['flat', t('FLAT')],
        ].map(([value, label]) => ({
          id: `sl-pano-${value}`,
          label,
          active: pano === value,
          disabled: filtersOff,
          params: { pano: value },
        })),
      }
    : null;
  const since = view.since;
  const slider = view.filterControls.since
    ? {
        id: 'sl-since',
        label: t('SINCE'),
        ariaLabel: t('SINCE'),
        min: 0,
        max: SINCE_STOPS.length - 1,
        step: 1,
        value: since.index,
        commitOnChange: true,
        previewText: (stop) => t(SINCE_STOPS[stop]?.label ?? ''),
        valueText: view.sinceNote
          ? `${since.label} ${view.sinceNote}`
          : since.label,
        params: (stop) => ({
          sinceDays: SINCE_STOPS[Number(stop)]?.days ?? 0,
        }),
      }
    : null;
  return {
    chips,
    segmented,
    // A missing key gates the filters only: the chips stay, so their tips
    // can say how to add the key.
    slider: filtersOff ? null : slider,
    info: view.meta === view.error ? '' : view.meta,
    alert: view.error || '',
  };
}
