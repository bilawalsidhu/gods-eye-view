import { createApp } from 'vue';
import Explorer from './Explorer.vue';

export function mountMzansiExplorer({ viewer, navigation }) {
  const host = document.createElement('div');
  host.id = 'mzansi-explorer';
  document.body.append(host);
  const app = createApp(Explorer, { viewer, navigation });
  app.mount(host);
  return () => {
    app.unmount();
    host.remove();
  };
}
