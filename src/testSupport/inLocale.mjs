import { setLocale } from '../i18n/index.js';

/** Run `run` with the UI in `locale`, then back in English. */
export function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}
