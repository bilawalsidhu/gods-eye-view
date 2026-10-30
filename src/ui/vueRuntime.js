import { createApp } from 'vue';
import { createPinia } from 'pinia';

/**
 * Create the application's Vue runtime: one Pinia instance shared by every
 * view the shell mounts, and the mounts themselves for teardown.
 * @returns {{pinia: import('pinia').Pinia, mount: Function, destroy: Function}}
 */
export function createUiRuntime() {
  const pinia = createPinia();
  const apps = new Set();
  return {
    pinia,
    /**
     * Mount a root component into a host element.
     * @param {object} component Root component.
     * @param {Element} host Element the view renders into.
     * @param {object} [props] Root props.
     * @returns {Function} Unmount this view.
     */
    mount(component, host, props = {}) {
      const app = createApp(component, props);
      app.use(pinia);
      app.mount(host);
      apps.add(app);
      return () => {
        if (!apps.delete(app)) return;
        app.unmount();
      };
    },
    destroy() {
      for (const app of apps) app.unmount();
      apps.clear();
    },
  };
}
