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
 * scroller it asks for the next older page, once per page.
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

  function render() {
    if (destroyed) return;
    renderVue(h(NewsFeed, { view, onParams }), container);
    const hidden = !view;
    if (panel) set(panel, 'hidden', hidden);
    if (count) set(count, 'textContent', String(view?.items.length ?? 0));
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
