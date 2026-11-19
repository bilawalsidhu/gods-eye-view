/**
 * @module ui/creditsView
 * @description The attribution line, in the application's own DOM, for a
 * renderer that does not draw its own credit display: what the renderer's
 * credits port lists (its own credits, each base layer's, the layers' data
 * credits). Inline credits are shown on the line at the bottom left; the
 * rest are in the "Data attribution" list it opens. A credit is plain data
 * (`src/render/contract/credits.d.ts`): its text is set as text, and a link
 * or logo is kept only for a safe scheme. `CreditsView` renders the line and
 * the list; this owner keeps the credits shown, the list's open state and
 * its focus.
 */
import { h, render as renderVue } from 'vue';
import { findCredits } from '../render/rendererOf.js';
import { getLocale, onLocaleChange } from '../i18n/index.js';
import CreditsView from './credits/CreditsView.vue';

const PANEL_ID = 'gev-credits-panel';

/** The credits once each, in order: the same text and link are one. */
function distinct(list) {
  const seen = new Set();
  return list.filter((credit) => {
    const key = `${credit?.text ?? ''}\u0000${credit?.href ?? ''}`;
    if (!credit?.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Show `viewer`'s renderer credits at the bottom left of `root`'s page.
 * @param {object} viewer The scene object, bound to its renderer.
 * @param {{root?: HTMLElement}} [options] Where the line goes (the body).
 * @returns {() => void} Removes it.
 */
export function mountCreditsView(viewer, { root = document.body } = {}) {
  const credits = findCredits(viewer);
  if (!credits || !root) return () => {};
  const doc = root.ownerDocument;
  // The view teleports the line and the list to the end of `root`; this
  // host, never in the page, holds only its place.
  const host = doc.createElement('div');
  const elements = {};
  let inline = [];
  let listed = [];
  let open = false;

  // The view patches synchronously, so focus can move once it returns.
  const paint = () =>
    renderVue(
      h(CreditsView, {
        to: root,
        panelId: PANEL_ID,
        inline,
        listed,
        open,
        locale: getLocale(),
        elements,
        onExpand,
        onClose,
        onKeydown,
      }),
      host,
    );

  const setOpen = (next, { focus = false } = {}) => {
    open = next;
    paint();
    if (open) elements.close.focus();
    else if (focus) elements.expand.focus();
  };

  const render = (all) => {
    const { bar, line, panel } = elements;
    const focused = panel.contains(doc.activeElement);
    const shown = distinct(Array.isArray(all) ? all : []);
    inline = shown.filter((credit) => credit.inline);
    listed = shown.filter((credit) => !credit.inline);
    paint();
    if (listed.length === 0 && open) {
      // Focus in the list goes back to the line, not to the page.
      setOpen(false);
      if (focused) (line.querySelector('a') ?? bar).focus();
    } else if (focused && !panel.contains(doc.activeElement)) {
      // A link that focus was on was redrawn: focus stays in the list.
      elements.close.focus();
    }
  };

  function onExpand() {
    setOpen(!open);
  }
  function onClose() {
    setOpen(false, { focus: true });
  }
  // Escape in the open list closes it (it takes focus as it opens).
  function onKeydown(event) {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    setOpen(false, { focus: true });
  }

  paint();
  render(credits.list());
  const offChange = credits.on('change', render);
  // The view words its text again in the new locale, as it renders.
  const offLocale = onLocaleChange(paint);
  return () => {
    offChange();
    offLocale();
    renderVue(null, host);
  };
}
