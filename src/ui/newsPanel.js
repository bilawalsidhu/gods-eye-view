import { h, render as renderVue } from 'vue';
import NewsFeed from './news/NewsFeed.vue';
import { setContextListPresence } from './contextLists.js';
import { renderKey, watchContextListBody } from './contextListBody.js';

const LAYER_ID = 'news';
const LOAD_MORE_MARGIN_PX = 160;

/**
 * News's list in Context: it renders the `feed` view the news layer
 * publishes through its row controls, reports through `onPresence` while the
 * layer is on (so Context shows the list's tab only then), and acts only
 * through setLayerParams. Near the bottom of its scroller it asks for the
 * next older page, once per page; other filters or a failed read let it ask
 * again.
 */
export function createNewsPanel({
  container,
  setLayerParams = () => {},
  onPresence = (state) => setContextListPresence(LAYER_ID, state),
} = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement) return null;
  let pendingOrder = null;
  const onParams = (params) => {
    if (!params.listOrder)
      return setLayerParams(LAYER_ID, params, { origin: 'user' });
    // Reporting order during a Vue patch can synchronously refresh this panel.
    pendingOrder = params;
    queueMicrotask(() => {
      if (pendingOrder !== params) return;
      pendingOrder = null;
      setLayerParams(LAYER_ID, params, { origin: 'user' });
    });
  };
  let view = null;
  let destroyed = false;
  let requestedAt = -1;
  let shownFilters = '';
  // Painted only while displayed (contextListBody.js), and at once when the
  // list is shown or hidden (`data-news-hidden`).
  const body = watchContextListBody(container, LAYER_ID, (options) =>
    render(options),
  );
  // The view the feed shows: an equal one is not rendered again.
  let shownKey;

  function render({ force = false } = {}) {
    if (destroyed) return;
    if (!body.defer(force)) {
      const visible = !container.hasAttribute('data-news-hidden');
      const key = renderKey({ view, visible });
      if (force || key === null || key !== shownKey)
        renderVue(h(NewsFeed, { view, onParams, visible }), container);
      shownKey = key;
    }
    // The count is the reports the map shows (the layer's `mapCount`, which
    // is its getStats().count), so the tab and Context's News tile agree.
    // The feed's loaded pages would not: it holds as many as were scrolled.
    onPresence(view ? { count: view.mapCount ?? null } : null);
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
  const visibility = new document.defaultView.MutationObserver(() =>
    render({ force: true }),
  );
  visibility.observe(container, {
    attributes: true,
    attributeFilter: ['data-news-hidden'],
  });
  container.addEventListener?.('scroll', onScroll, { passive: true });

  return {
    /** Show the layer's feed view, or report the list gone with null. */
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
      if (!next) pendingOrder = null;
      view = next || null;
      render();
    },
    destroy() {
      pendingOrder = null;
      destroyed = true;
      visibility.disconnect();
      body.disconnect();
      container.removeEventListener?.('scroll', onScroll);
      renderVue(null, container);
      onPresence(null);
    },
  };
}
