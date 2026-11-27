import { h, render as renderVue } from 'vue';
import NewsFeed from './news/NewsFeed.vue';
import { contextListShown, setContextListPresence } from './contextLists.js';
import { watchDisplayed } from './displayWatch.js';
import { onPanelOpening } from './rail/panelContent.js';
import { getLocale } from '../i18n/index.js';

const LAYER_ID = 'news';
const LOAD_MORE_MARGIN_PX = 160;
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
  // The feed is not repainted while its body is not displayed (Context
  // folded, another tab or another list shown); it repaints once when the
  // body is displayed again: at once when Context is presented open on the
  // News list or the list is shown or hidden (`data-news-hidden`), otherwise
  // when a ResizeObserver reports the body displayed.
  let owed = false;
  // The view the feed shows: an equal one is not rendered again.
  let shownKey;
  const body = watchDisplayed(container, () => {
    if (owed) render();
  });
  const offOpening = onPanelOpening(
    container.closest?.('[data-panel-id]'),
    ({ displayedOnly = false } = {}) => {
      if (!owed) return;
      if (
        displayedOnly
          ? !(container.getClientRects?.().length > 0)
          : !contextListShown(LAYER_ID)
      )
        return;
      // The body is being shown: a later render paints it rather than owing it.
      body.assumeShown();
      render({ force: true });
    },
  );

  function render({ force = false } = {}) {
    if (destroyed) return;
    owed = !force && !body.shown();
    if (!owed) {
      const visible = !container.hasAttribute('data-news-hidden');
      const key = viewKey({ view, visible });
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
      offOpening();
      container.removeEventListener?.('scroll', onScroll);
      renderVue(null, container);
      onPresence(null);
    },
  };
}
