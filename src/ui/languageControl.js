/**
 * The Language control (a `<select>` in the Display panel).
 *
 * A manual choice wins over the browser preference and persists across
 * reloads; picking the same value is a no-op. The option labels use each
 * language's own name ("English", "简体中文") and are intentionally not
 * translated. Switching only changes locale state and notifies subscribers —
 * the map, layers and open panels re-render through their own subscriptions.
 */
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES } from '../i18n/core.js';
import { currentLocale, setLocale, subscribeLocale } from '../i18n/index.js';
import { persistLocale } from '../i18n/browser.js';

export function createLanguageControl({
  select,
  onPersist = persistLocale,
  documentRef = document,
} = {}) {
  if (!select) return () => {};

  for (const locale of SUPPORTED_LOCALES) {
    const option = documentRef.createElement('option');
    option.value = locale;
    option.textContent = LOCALE_DISPLAY_NAMES[locale];
    select.appendChild(option);
  }
  const sync = () => {
    if (select.value !== currentLocale()) select.value = currentLocale();
  };
  sync();

  const onChange = () => {
    if (!SUPPORTED_LOCALES.includes(select.value)) return;
    setLocale(select.value);
    onPersist(select.value);
  };
  const unsubscribe = subscribeLocale(sync);
  select.addEventListener('change', onChange);

  return () => {
    unsubscribe();
    select.removeEventListener('change', onChange);
  };
}
