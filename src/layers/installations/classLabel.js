import { t } from '../../i18n/index.js';
import { UNNAMED_PLACE_NAMES } from '../../data/installationNames.js';

const UNNAMED_NAMES = new Set(UNNAMED_PLACE_NAMES);

/**
 * An installation's card title: a mapped name as it is; the English label
 * the data gives an unnamed feature ("Firing range", "Military area") in the
 * UI language. The record keeps the English name.
 * @param {string} name
 * @returns {string} Empty when the record has no name.
 */
export function installationTitle(name) {
  const text = String(name ?? '');
  return UNNAMED_NAMES.has(text.trim()) ? t(text.trim()) : text;
}

/**
 * An installation class as a map card shows it: AIRFIELD, NAVAL BASE…, in
 * the UI language. The class itself stays an English identifier in data.
 * @param {string} klass
 * @returns {string}
 */
export function installationClassLabel(klass) {
  const key = String(klass || 'installation');
  switch (key) {
    case 'airfield':
      return t('AIRFIELD', { context: 'installation class' });
    case 'naval_base':
      return t('NAVAL BASE', { context: 'installation class' });
    case 'range':
      return t('RANGE', { context: 'installation class' });
    case 'military_land':
      return t('MILITARY LAND', { context: 'installation class' });
    case 'base':
      return t('BASE', { context: 'installation class' });
    case 'barracks':
      return t('BARRACKS', { context: 'installation class' });
    case 'training_area':
      return t('TRAINING AREA', { context: 'installation class' });
    case 'places_candidate':
      return t('PLACES CANDIDATE', { context: 'installation class' });
    case 'installation':
      return t('INSTALLATION', { context: 'installation class' });
    default:
      return key.replaceAll('_', ' ').toUpperCase();
  }
}
