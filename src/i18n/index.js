import en from './en.js';
import zhTW from './zh-TW.js';

export const LOCALE_STORAGE_KEY = 'gev:locale';
export const SUPPORTED_LOCALES = Object.freeze(['en', 'zh-TW']);
export const DEFAULT_LOCALE = 'en';

const DICTIONARIES = Object.freeze({
  en,
  'zh-TW': zhTW,
});

let currentLocale = DEFAULT_LOCALE;
const listeners = new Set();

/**
 * Detect initial locale based on stored preference or browser language.
 *
 * @returns {string} Detected locale ('en' or 'zh-TW').
 */
export function detectInitialLocale() {
  try {
    const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored)) {
      return stored;
    }
  } catch {
    // Ignore localStorage errors (e.g. sandboxed iframe or private browsing)
  }

  const navLang =
    (typeof navigator !== 'undefined' && navigator.language) || '';
  if (
    navLang.toLowerCase().startsWith('zh') ||
    navLang.toLowerCase().includes('tw') ||
    navLang.toLowerCase().includes('hk')
  ) {
    return 'zh-TW';
  }

  return DEFAULT_LOCALE;
}

/**
 * Get the currently active locale.
 *
 * @returns {string}
 */
export function getLocale() {
  return currentLocale;
}

/**
 * Translate a key for the current locale.
 *
 * @param {string} key - Translation key.
 * @param {string} [fallback] - Optional fallback string if key is not found.
 * @returns {string}
 */
export function t(key, fallback = '') {
  const dict = DICTIONARIES[currentLocale] || DICTIONARIES[DEFAULT_LOCALE];
  if (dict && Object.hasOwn(dict, key)) {
    return dict[key];
  }
  const defaultDict = DICTIONARIES[DEFAULT_LOCALE];
  if (defaultDict && Object.hasOwn(defaultDict, key)) {
    return defaultDict[key];
  }
  return fallback || key;
}

/**
 * Set the active locale and apply translations to DOM.
 *
 * @param {string} locale
 * @returns {boolean} True if locale changed.
 */
export function setLocale(locale) {
  const target = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  if (target === currentLocale) return false;

  currentLocale = target;
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, target);
  } catch {
    // Ignore storage failures
  }

  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = target;
    applyTranslations(document);
  }

  for (const listener of listeners) {
    try {
      listener(target);
    } catch (err) {
      console.warn('[i18n] listener error:', err);
    }
  }
  return true;
}

/**
 * Toggle between 'en' and 'zh-TW'.
 *
 * @returns {string} New locale.
 */
export function toggleLocale() {
  const next = currentLocale === 'zh-TW' ? 'en' : 'zh-TW';
  setLocale(next);
  return next;
}

/**
 * Subscribe to locale changes.
 *
 * @param {Function} callback - Called with (newLocale).
 * @returns {Function} Unsubscribe function.
 */
export function subscribeLocale(callback) {
  if (typeof callback === 'function') {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }
  return () => {};
}

/**
 * Scan DOM tree and apply data-i18n attributes.
 *
 * Supported attributes:
 * - data-i18n: Replaces element.textContent
 * - data-i18n-title: Replaces element.title
 * - data-i18n-aria-label: Replaces element.ariaLabel
 * - data-i18n-placeholder: Replaces element.placeholder
 *
 * @param {HTMLElement|Document} [root=document]
 */
export function applyTranslations(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  const textNodes = root.querySelectorAll('[data-i18n]');
  for (const el of textNodes) {
    const key = el.dataset.i18n;
    if (key) {
      el.textContent = t(key, el.textContent);
    }
  }

  const titleNodes = root.querySelectorAll('[data-i18n-title]');
  for (const el of titleNodes) {
    const key = el.dataset.i18nTitle;
    if (key) {
      el.title = t(key, el.title);
    }
  }

  const ariaNodes = root.querySelectorAll('[data-i18n-aria-label]');
  for (const el of ariaNodes) {
    const key = el.dataset.i18nAriaLabel;
    if (key) {
      el.setAttribute(
        'aria-label',
        t(key, el.getAttribute('aria-label') || ''),
      );
    }
  }

  const placeholderNodes = root.querySelectorAll('[data-i18n-placeholder]');
  for (const el of placeholderNodes) {
    const key = el.dataset.i18nPlaceholder;
    if (key) {
      el.placeholder = t(key, el.placeholder);
    }
  }

  // Handle pinned first-run modal elements whose raw HTML templates cannot carry extra attributes
  const envTitle = root.querySelector('[data-first-run-environmental-title]');
  if (envTitle) {
    envTitle.textContent = t('welcome.environmental', envTitle.textContent);
  }
  const desc = root.querySelector('#first-run-description');
  if (desc) {
    desc.textContent = t('welcome.desc', desc.textContent);
  }
  const envSmall = root.querySelector(
    '[data-first-run-choice="environmental"] small',
  );
  if (envSmall) {
    envSmall.textContent = t('welcome.environmentalDesc', envSmall.textContent);
  }
  const suppressSpan = root.querySelector('.first-run-suppress span');
  if (suppressSpan && !suppressSpan.dataset?.i18n) {
    suppressSpan.textContent = t('welcome.dontShow', suppressSpan.textContent);
  }

  // Update language switch button label if present
  const langSwitchLabel = root.querySelector('#lang-switch-label');
  if (langSwitchLabel) {
    langSwitchLabel.textContent = currentLocale === 'zh-TW' ? 'EN' : '繁中';
  }
}

/**
 * Initialize i18n system on startup.
 */
export function initI18n() {
  currentLocale = detectInitialLocale();
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = currentLocale;
    applyTranslations(document);

    const switchBtn = document.getElementById('lang-switch-btn');
    if (switchBtn && !switchBtn.dataset.i18nBound) {
      switchBtn.dataset.i18nBound = 'true';
      switchBtn.addEventListener('click', () => {
        toggleLocale();
      });
    }
  }
}
