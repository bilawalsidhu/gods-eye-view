import { createPinia } from 'pinia';
import { createApp, h } from 'vue';
import { useEntityCardStore } from '../ui/stores/entityCard.js';

export function connectCreditLayer(cards, layer) {
  cards.connect({
    dataManager: () => ({
      layers: new Map([[layer.id, layer]]),
      isEnabled: (id) => id === layer.id && layer.enabled,
      getAll: () => [layer],
      subscribe: () => () => {},
    }),
    regionalBrief: async () => null,
    previews: () => null,
    canFollow: () => false,
    follow() {},
    flyTo() {},
    ask() {},
  });
  return layer;
}

export function mountCreditView(t, component) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  const app = createApp({ render: () => h(component) }).use(pinia);
  t.after(() => {
    app.unmount();
    cards.connect(null);
  });
  return { host, pinia, cards, mount: () => app.mount(host) };
}
