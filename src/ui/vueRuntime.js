import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { applicationI18n } from './i18n.js';

let pagePinia = null;

/**
 * The page's Pinia instance, shared by the application views and the shell,
 * so a view and a shell control read the same stores.
 * @returns {import('pinia').Pinia}
 */
export function applicationPinia() {
  pagePinia ??= createPinia();
  return pagePinia;
}

/**
 * Create a Vue runtime: one Pinia instance shared by every view it mounts,
 * the page's vue-i18n instance, and the mounts themselves for teardown.
 * @param {{pinia?: import('pinia').Pinia}} [options]
 * @returns {{pinia: import('pinia').Pinia, mount: Function, destroy: Function}}
 */
export function createUiRuntime({ pinia = createPinia() } = {}) {
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
      app.use(pinia).use(applicationI18n());
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
