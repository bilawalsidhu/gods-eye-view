import { h, render as renderVue } from 'vue';
import NewsFeed from './news/NewsFeed.vue';
import { watchDisplayed } from './displayWatch.js';
import { onPanelOpening } from './rail/panelContent.js';
import { getLocale } from '../i18n/index.js';

const LAYER_ID = 'news';
const LOAD_MORE_MARGIN_PX = 160;
// Remounting must not reopen a panel the reader already collapsed.
const appearedPanels = new WeakSet();
const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};
// What a render shows: its template translates labels too, so the locale is
// part of it. Null for a view that cannot be compared.
const viewKey = (view) => {
  try {
    return `${getLocale()}\u0000${JSON.stringify(view)}`;
  } catch {
    return null;
  }
};

/**
 * The News rail panel (`#news-panel`): it renders the `feed` view the news
 * layer publishes through its row controls, shows itself only while the
 * layer is on, and acts only through setLayerParams. Near the bottom of its
 * scroller it asks for the next older page, once per page; other filters or a
 * failed read let it ask again.
 */
export function createNewsPanel({ container, setLayerParams = () => {} } = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement) return null;
  const panel = container.closest?.('#news-panel');
  const count = panel?.querySelector('#news-panel-count');
  const onParams = (params) =>
    setLayerParams(LAYER_ID, params, { origin: 'user' });
  let view = null;
  let destroyed = false;
  let requestedAt = -1;
  let shownFilters = '';
  // The feed is not repainted while its body is not displayed (the panel
  // collapsed or hidden); it repaints once when the body is displayed again:
  // at once when the panel is presented open or shown open, otherwise when a
  // ResizeObserver reports the body displayed.
  let owed = false;
  // The view the feed shows: an equal one is not rendered again.
  let shownKey;
  const body = watchDisplayed(container, () => {
    if (owed) render();
  });
  const offOpening = onPanelOpening(panel, ({ displayedOnly = false } = {}) => {
    if (!owed) return;
    if (displayedOnly && !(container.getClientRects?.().length > 0)) return;
    // The body is being shown: a later render paints it rather than owing it.
    body.assumeShown();
    render({ force: true });
  });

  function render({ force = false } = {}) {
    if (destroyed) return;
    const hidden = !view;
    // A panel this render shows open displays its body before a size report.
    const showsOpen =
      Boolean(panel?.hidden) &&
      !hidden &&
      !panel.classList?.contains('collapsed');
    owed = !force && !showsOpen && !body.shown();
    if (!owed) {
      const key = viewKey(view);
      if (force || key === null || key !== shownKey)
        renderVue(h(NewsFeed, { view, onParams }), container);
      shownKey = key;
    }
    if (panel) set(panel, 'hidden', hidden);
    // The count is the shown section's: Local's list, else the feed.
    const shown =
      view?.filters?.section === 'local' ? view.inView?.items : view?.items;
    if (count) set(count, 'textContent', String(shown?.length ?? 0));
    if (!hidden && panel && !appearedPanels.has(panel)) {
      appearedPanels.add(panel);
      // First appearance opens the panel unless a stored or shared collapse
      // choice exists (marked by the panel chrome when it restored the state).
      const preference = panel.dataset?.collapsedPreference;
      if (
        panel.classList?.contains('collapsed') &&
        (preference === undefined || preference === 'default')
      )
        panel.querySelector('[data-collapse-target="news-panel"]')?.click();
    }
  }

  const onScroll = () => {
    if (!view?.hasMore || view.loading) return;
    const remaining =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining > LOAD_MORE_MARGIN_PX) return;
    if (requestedAt === view.items.length) return;
    requestedAt = view.items.length;
    onParams({ loadMore: true });
  };
  container.addEventListener?.('scroll', onScroll, { passive: true });

  return {
    /** Show the layer's feed view, or hide the panel with null. */
    update(next) {
      const filters = JSON.stringify(next?.filters ?? null);
      // A new list (other filters or hotspot), or a read that failed, may stop
      // at the same length as the last request: let the next scroll ask.
      // A list started over is shorter than the one the last request saw.
      if (
        filters !== shownFilters ||
        (next?.error && !view?.error) ||
        (next?.items?.length ?? 0) < requestedAt
      )
        requestedAt = -1;
      shownFilters = filters;
      view = next || null;
      render();
    },
    destroy() {
      destroyed = true;
      body.disconnect();
      offOpening();
      container.removeEventListener?.('scroll', onScroll);
      renderVue(null, container);
      if (panel) set(panel, 'hidden', true);
      if (count) set(count, 'textContent', '0');
    },
  };
}
