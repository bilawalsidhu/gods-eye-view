import { createPortsLayer } from '../../layers/ports/index.js';
import { applicationPinia } from '../../ui/vueRuntime.js';
import { usePortsStore } from '../../ui/stores/ports.js';

/** Connect the standalone port reference layer to its Vue panel. */
export function createApplicationPorts({ source } = {}) {
  let store, owner;
  const layer = createPortsLayer({
    source,
    publish: (view) => store?.publish(view),
  });
  const init = layer.init;
  layer.init = (viewer) => {
    init(viewer);
    store = usePortsStore(applicationPinia());
    owner = store.connect({
      filter: (params) => layer.setParams(params),
      select: (id) => layer.select(id, true),
    });
  };
  const destroy = layer.destroy;
  layer.destroy = () => {
    destroy();
    store?.detach(owner);
    store = null;
  };
  return layer;
}
