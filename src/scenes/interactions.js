import * as Cesium from 'cesium';
import { nextTick } from 'vue';
import { isPointerFree } from '../data/inputOwnership.js';
import { createInteractionSession } from '../director/interactions/session.js';
import { t } from '../i18n/index.js';
import { useSceneInteractionsStore } from '../ui/stores/sceneInteractions.js';
import { applicationPinia } from '../ui/vueRuntime.js';

/**
 * Own the active shot's pick handler, accessible actions and plain-text
 * feedback. The Scene actions panel is presented to the scene interactions
 * store, which its view renders inside the viewer's container.
 */
// Keys each activation's panel, so a new one never reuses an old one's DOM.
let activations = 0;

export function createSceneInteractions(
  viewer,
  {
    execute,
    available = () => true,
    store = useSceneInteractionsStore(applicationPinia()),
  },
) {
  let panel = null,
    handler,
    items = [],
    targets = new Map();
  // Only the owner whose panel the store shows may change or remove it.
  const shown = () => panel && store.panel?.owner === panel.owner;
  const update = (patch) => {
    if (!shown()) return;
    panel = { ...panel, ...patch };
    store.publish(panel);
  };
  const session = createInteractionSession({
    execute: (item, signal) => {
      if (!isPointerFree() || !available()) return false;
      if (item.action.type === 'card') {
        update({
          card: { text: item.action.text, url: item.action.url || null },
        });
        return true;
      }
      update({ card: null });
      return execute(item.action, signal);
    },
    changed(state) {
      update({
        busy: state.busy,
        selected: state.selected,
        outlined: state.selected ? [state.selected] : [],
      });
    },
  });
  function clear() {
    session.clear();
    handler?.destroy();
    handler = null;
    if (shown()) {
      store.connect(null);
      store.publish(null);
    }
    panel = null;
    items = [];
    targets.clear();
  }
  async function dispatch(id) {
    const current = panel;
    const ok = await session.dispatch(id);
    if (current && panel?.owner === current.owner)
      update({
        status: ok
          ? t('Action complete')
          : t('Action unavailable or cancelled'),
      });
    return ok;
  }
  return {
    clear,
    destroy: clear,
    getState: session.getState,
    activate(shot, registered) {
      clear();
      items = shot.interactions || [];
      if (!items.length) return;
      targets = registered;
      if (
        items.some(
          (item) =>
            !targets.has(
              JSON.stringify([item.target.packId, item.target.featureId]),
            ),
        )
      ) {
        items = [];
        targets.clear();
        throw new Error('Interaction feature is missing from the loaded pack');
      }
      // Each activation owns its panel; a click on an older one is ignored.
      const owner = {};
      panel = {
        id: ++activations,
        owner,
        container: viewer.container,
        items: items.map(({ id, label }) => ({ id, label })),
        status: t('Select a feature or use Tab and Enter to choose an action.'),
        busy: false,
        selected: null,
        outlined: [],
        card: null,
      };
      store.publish(panel);
      store.connect({
        dispatch(id, from) {
          if (from === owner && panel?.owner === owner) void dispatch(id);
        },
      });
      session.activate(items);
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((event) => {
        if (
          panel?.owner !== owner ||
          !shown() ||
          !isPointerFree() ||
          !available()
        )
          return;
        const picked = viewer.scene.pick(event.position)?.id;
        const matches = items.filter(
          (item) =>
            targets.get(
              JSON.stringify([item.target.packId, item.target.featureId]),
            ) === picked,
        );
        if (!matches.length) return;
        update({
          outlined: matches.map((item) => item.id),
          status: t('Selected feature: {feature}. Choose an action.', {
            feature: matches[0].target.featureId,
          }),
        });
        // Focus the first match once the panel shows the selection.
        void nextTick(() => {
          if (panel?.owner !== owner || !shown()) return;
          const id = globalThis.CSS?.escape?.(matches[0].id) ?? matches[0].id;
          viewer.container
            ?.querySelector?.(
              `[data-director-interactions] [data-director-action="${id}"]`,
            )
            ?.focus({ preventScroll: true });
        });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
  };
}
