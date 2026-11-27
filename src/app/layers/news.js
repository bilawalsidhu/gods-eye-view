import { CONTEXT_SHOW_VIEW_EVENT } from '../../ui/contextEvents.js';
import { createNewsLayer } from '../../layers/news/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the news layer to the application overlay host. */
export function createApplicationNews(options) {
  return createNewsLayer({
    overlayHost,
    showReportList: () =>
      globalThis.dispatchEvent?.(
        new CustomEvent(CONTEXT_SHOW_VIEW_EVENT, { detail: { list: 'news' } }),
      ),
    ...options,
  });
}
