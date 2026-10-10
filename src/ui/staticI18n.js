/**
 * Declarative translation of the static application markup.
 *
 * Templates tag their static text with `data-i18n="key"` and fixed
 * attributes with `data-i18n-attr="title:ns.key,aria-label:ns.key2"`. The
 * binder resolves both through the shared translator and reapplies on every
 * locale change, so switching language updates the open UI in place — no
 * reload, and no touching of inputs or dynamically managed nodes.
 *
 * Elements whose text is repainted by feature code (status chips, readouts)
 * must NOT carry `data-i18n`; their owners translate at render time and
 * re-render on a locale subscription. This keeps the binder from clobbering
 * live state (e.g. a "LOAD COMPLETE" chip) with template defaults.
 */
import { subscribeLocale, t } from '../i18n/index.js';

function translateElement(element) {
  const key = element.getAttribute('data-i18n');
  if (key) element.textContent = t(key);
  const attrMap = element.getAttribute('data-i18n-attr');
  if (!attrMap) return;
  for (const pair of attrMap.split(',')) {
    const separator = pair.indexOf(':');
    if (separator <= 0) continue;
    const attr = pair.slice(0, separator).trim();
    const key = pair.slice(separator + 1).trim();
    if (attr && key) element.setAttribute(attr, t(key));
  }
}

/** Apply every tagged element once under `root`. */
export function applyStaticTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(translateElement);
  // data-i18n-attr without data-i18n still needs a pass.
  root
    .querySelectorAll('[data-i18n-attr]:not([data-i18n])')
    .forEach(translateElement);
}

/**
 * Apply now and reapply on every locale change.
 * Returns an unsubscribe function for owners that tear down.
 */
export function bindStaticTranslations(root = document) {
  applyStaticTranslations(root);
  return subscribeLocale(() => applyStaticTranslations(root));
}
