import { shallowRef } from 'vue';

/** Search reads the same layer presentation and toggle owner as the panel. */
export const layerSearchCatalog = shallowRef([]);
let owner = null;
export function publishLayerSearch(nextOwner, layers, toggle) {
  owner = nextOwner;
  layerSearchCatalog.value = layers.map((layer) =>
    Object.freeze({
      id: layer.id,
      name: layer.name,
      enabled: Boolean(layer.enabled),
      toggle: () => toggle(layer.id),
    }),
  );
}
export function clearLayerSearch(previousOwner) {
  if (owner !== previousOwner) return;
  owner = null;
  layerSearchCatalog.value = [];
}
