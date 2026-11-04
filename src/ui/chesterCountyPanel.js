import { onLocaleChange } from '../i18n/index.js';
const ID = 'chester-county-ems';

/** Connect the dedicated county app to its existing layer, without polling or fetching. */
export function createChesterCountyPanel({ store }) {
  let manager = null,
    layer = null,
    unsubscribe = null,
    unsubscribeLayer = null,
    stopped = false;
  let token;
  function refresh() {
    if (stopped || !store.owns(token, 'select')) return;
    const nextLayer = manager?.layers?.get?.(ID)?.module;
    if (nextLayer !== layer) {
      unsubscribeLayer?.();
      layer = nextLayer;
      unsubscribeLayer = layer?.subscribeIncidentPanel?.(refresh);
    }
    const model = manager?.isEnabled?.(ID)
      ? layer?.getIncidentPanelState?.()
      : null;
    store.publish(
      model?.enabled
        ? {
            enabled: true,
            categories: model.categories || ['fire', 'ems', 'traffic'],
            counties: model.counties || [],
            total: model.total ?? model.list.items.length,
            info: model.info,
            feedInfo: model.feedInfo || [],
            chips: model.chips.map(({ id, label, disabled }) => ({
              id,
              label,
              disabled,
            })),
            list: model.list,
            selection: model.selection || null,
          }
        : null,
    );
  }
  token = store.connect({
    category(category) {
      if (
        !manager?.isEnabled?.(ID) ||
        !['fire', 'ems', 'traffic'].includes(category)
      )
        return false;
      const current = layer.getIncidentPanelState().categories;
      const categories = current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category];
      return manager.setLayerParams(ID, { categories }, { origin: 'user' });
    },
    county(id) {
      if (!manager?.isEnabled?.(ID)) return false;
      const options = layer.getIncidentPanelState().counties || [];
      if (!options.some((county) => county.id === id)) return false;
      const current = options
        .filter((county) => county.active)
        .map((county) => county.id);
      return manager.setLayerParams(
        ID,
        {
          counties: current.includes(id)
            ? current.filter((value) => value !== id)
            : [...current, id],
        },
        { origin: 'user' },
      );
    },
    select(id) {
      if (!manager?.isEnabled?.(ID)) return false;
      return manager.setLayerParams(
        ID,
        { selectedIncident: id },
        { origin: 'user' },
      );
    },
    chip(id) {
      if (!manager?.isEnabled?.(ID)) return false;
      return layer
        ?.getIncidentPanelState?.()
        .chips.find((chip) => chip.id === id)
        ?.onClick?.();
    },
  });
  const removeLocale = onLocaleChange(refresh);
  refresh();
  return {
    connect(next) {
      if (stopped) return;
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeLayer?.();
      unsubscribeLayer = null;
      layer = null;
      manager =
        next?.layers?.has(ID) && typeof next.isEnabled === 'function'
          ? next
          : null;
      unsubscribe = manager?.subscribe?.((change) => {
        if (!change?.layerId || change.layerId === ID) refresh();
      });
      refresh();
    },
    refresh,
    destroy() {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      unsubscribeLayer?.();
      removeLocale();
      if (store.owns(token, 'select')) store.publish(null);
      store.detach(token);
      manager = layer = null;
    },
  };
}
