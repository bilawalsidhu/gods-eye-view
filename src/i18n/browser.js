/**
 * Browser-side locale selection and persistence.
 *
 * Entry-only: this module touches `navigator`, `localStorage` and
 * `document`, so reusable/portable modules must not import it. The browser
 * application bootstrap calls these before any controls render, and the
 * language control calls `persistLocale` on manual switches.
 *
 * Storage is resolved INSIDE the guards on purpose: privacy modes can define
 * `localStorage` as a getter that throws, so evaluating it in a default
 * parameter would throw outside any try/catch and block startup. Every entry
 * point must survive a throwing getter, a throwing `getItem` and a throwing
 * `setItem` (covered by src/i18n/browser.test.mjs).
 */
import { detectLocaleFromTags, isSupportedLocale } from './core.js';

/** Namespaced storage key so co-hosted apps never collide. */
export const LOCALE_STORAGE_KEY = 'gods-eye-view.locale';

/** Read the saved locale; returns null when unset, invalid, or storage is unavailable. */
export function readStoredLocale(storage) {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    const value = store?.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persist a manual choice; storage failures (privacy mode) are non-fatal. */
export function persistLocale(locale, storage) {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    store?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* Session-only switch; the app keeps running. */
  }
}

/**
 * Locale from browser preferences: the ordered `navigator.languages` list
 * first, then the legacy `navigator.language`. The lists MERGE instead of
 * short-circuiting — a preference list with no supported entry (e.g.
 * `['fr-FR']`) must still let `navigator.language` (`zh-CN`) speak.
 */
export function detectBrowserLocale(navigatorRef = globalThis.navigator) {
  const candidates = [];
  if (Array.isArray(navigatorRef?.languages)) {
    candidates.push(...navigatorRef.languages);
  }
  if (navigatorRef?.language) candidates.push(navigatorRef.language);
  return detectLocaleFromTags(candidates);
}

/**
 * Resolve the startup locale: saved choice first, then browser preference,
 * then English. Returns the resolved tag without touching any state.
 */
export function resolveStartupLocale(storage) {
  return readStoredLocale(storage) ?? detectBrowserLocale() ?? 'en';
}

/** Keep `<html lang>` in sync with the active locale. */
export function applyDocumentLanguage(
  locale,
  documentRef = globalThis.document,
) {
  if (documentRef?.documentElement) {
    documentRef.documentElement.lang = locale;
  }
}

/**
 * Keep the document title on its locale contract. The brand text is
 * identical in every shipped locale today; the hook exists so the title
 * always re-resolves through the pack when that stops being true.
 */
export function applyDocumentTitle(title, documentRef = globalThis.document) {
  if (documentRef && typeof title === 'string' && title) {
    documentRef.title = title;
  }
}
