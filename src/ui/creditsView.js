/**
 * @module ui/creditsView
 * @description The attribution line, in the application's own DOM, for a
 * renderer that does not draw its own credit display: what the renderer's
 * credits port lists (its own credits, each base layer's, the layers' data
 * credits). Inline credits are shown on the line at the bottom left; the
 * rest are in the "Data attribution" list it opens. A credit is plain data
 * (`src/render/contract/credits.d.ts`): its text is set as text, and a link
 * or logo is kept only for a safe scheme.
 */
import { findCredits } from '../render/rendererOf.js';
import {
  LINK_SCHEMES,
  LOGO_SCHEMES,
  safeUrl,
  splitLink,
} from '../render/creditMarkup.js';
import { onLocaleChange, t } from '../i18n/index.js';

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

/** One credit as DOM: its logo or its text, linked when it has a link. */
function creditElement(doc, credit) {
  const href = credit.href ? safeUrl(credit.href, LINK_SCHEMES) : null;
  const logoUrl = credit.logoUrl ? safeUrl(credit.logoUrl, LOGO_SCHEMES) : null;
  // Only the credit's linked words are the link, as the source wrote it.
  if (href && !logoUrl && credit.linkText) {
    const [before, words, after] = splitLink(credit);
    const element = doc.createElement('span');
    element.className = 'gev-credit';
    const link = doc.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = words;
    element.append(before, link, after);
    return element;
  }
  const element = doc.createElement(href ? 'a' : 'span');
  element.className = 'gev-credit';
  if (href) {
    element.href = href;
    element.target = '_blank';
    element.rel = 'noopener noreferrer';
  }
  // A logo is drawn in place of the text, which names it (its alt text).
  const logo = credit.logoUrl ? safeUrl(credit.logoUrl, LOGO_SCHEMES) : null;
  if (logo) {
    const image = doc.createElement('img');
    image.className = 'gev-credit-logo';
    image.src = logo;
    image.alt = credit.text;
    element.append(image);
  } else element.textContent = credit.text;
  return element;
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
  const bar = doc.createElement('div');
  bar.id = 'gev-credits';
  bar.className = 'gev-credits';
  // Takes focus back from an emptied list when the line has no link.
  bar.tabIndex = -1;
  const line = doc.createElement('span');
  line.className = 'gev-credits-line';
  const expand = doc.createElement('button');
  expand.type = 'button';
  expand.className = 'gev-credits-expand';
  expand.setAttribute('aria-haspopup', 'dialog');
  expand.setAttribute('aria-controls', PANEL_ID);
  expand.setAttribute('aria-expanded', 'false');

  const panel = doc.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'gev-credits-panel';
  panel.setAttribute('role', 'dialog');
  panel.hidden = true;
  const header = doc.createElement('div');
  header.className = 'gev-credits-header';
  const title = doc.createElement('span');
  title.className = 'gev-credits-title';
  title.id = `${PANEL_ID}-title`;
  panel.setAttribute('aria-labelledby', title.id);
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'gev-credits-close';
  close.textContent = '×';
  header.append(title, close);
  const list = doc.createElement('ul');
  list.className = 'gev-credits-list';
  panel.append(header, list);
  bar.append(line, expand);
  root.append(bar, panel);

  const label = () => {
    expand.textContent = t('Data attribution');
    title.textContent = t('Data provided by:');
    close.setAttribute('aria-label', t('Close data attribution'));
  };

  const setOpen = (open, { focus = false } = {}) => {
    panel.hidden = !open;
    expand.setAttribute('aria-expanded', String(open));
    if (open) close.focus();
    else if (focus) expand.focus();
  };

  const render = (all) => {
    const focused = panel.contains(doc.activeElement);
    const shown = distinct(Array.isArray(all) ? all : []);
    const inline = shown.filter((credit) => credit.inline);
    const listed = shown.filter((credit) => !credit.inline);
    line.replaceChildren();
    inline.forEach((credit, i) => {
      if (i) line.append(doc.createTextNode(' · '));
      line.append(creditElement(doc, credit));
    });
    if (inline.length && listed.length) line.append(doc.createTextNode(' · '));
    list.replaceChildren(
      ...listed.map((credit) => {
        const item = doc.createElement('li');
        item.append(creditElement(doc, credit));
        return item;
      }),
    );
    expand.hidden = listed.length === 0;
    if (expand.hidden && !panel.hidden) {
      // Focus in the list goes back to the line, not to the page.
      setOpen(false);
      if (focused) (line.querySelector('a') ?? bar).focus();
    } else if (focused && !panel.contains(doc.activeElement)) {
      // A link that focus was on was redrawn: focus stays in the list.
      close.focus();
    }
  };

  const onExpand = () => setOpen(panel.hidden);
  const onClose = () => setOpen(false, { focus: true });
  // Escape in the open list closes it (it takes focus as it opens).
  const onKey = (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault();
    setOpen(false, { focus: true });
  };
  expand.addEventListener('click', onExpand);
  close.addEventListener('click', onClose);
  panel.addEventListener('keydown', onKey);
  label();
  render(credits.list());
  const offChange = credits.on('change', render);
  const offLocale = onLocaleChange(label);
  return () => {
    offChange();
    offLocale();
    expand.removeEventListener('click', onExpand);
    close.removeEventListener('click', onClose);
    panel.removeEventListener('keydown', onKey);
    bar.remove();
    panel.remove();
  };
}
