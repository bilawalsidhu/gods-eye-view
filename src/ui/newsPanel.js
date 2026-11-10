import { h, render as renderVue } from 'vue';
import NewsFeed from './news/NewsFeed.vue';

const LAYER_ID = 'news';
const LOAD_MORE_MARGIN_PX = 160;
// Remounting must not reopen a panel the reader already collapsed.
const appearedPanels = new WeakSet();
const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
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

  function render() {
    if (destroyed) return;
    renderVue(h(NewsFeed, { view, onParams }), container);
    const hidden = !view;
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
      container.removeEventListener?.('scroll', onScroll);
      renderVue(null, container);
      if (panel) set(panel, 'hidden', true);
      if (count) set(count, 'textContent', '0');
    },
  };
}
