import { createApp } from 'vue';
import { applicationPinia } from '../vueRuntime.js';
import { applicationI18n } from '../i18n.js';
import WelcomeView from './WelcomeView.vue';
import ContextView from './ContextView.vue';
import LayerPanelsView from './LayerPanelsView.vue';
import CommandDockView from './CommandDockView.vue';
import DisplayControlsView from './DisplayControlsView.vue';
import CockpitView from './CockpitView.vue';
import SceneChromeView from './SceneChromeView.vue';
import ProviderSettingsView from './ProviderSettingsView.vue';
import IntelHudView from './IntelHudView.vue';

/**
 * Application views by name. A page places each one with a host element,
 * `<div class="gev-view" data-gev-view="NAME"></div>` (`display: contents`),
 * where the view's markup belongs.
 */
export const APPLICATION_VIEWS = Object.freeze({
  'provider-settings': ProviderSettingsView,
  'scene-chrome': SceneChromeView,
  cockpit: CockpitView,
  'display-controls': DisplayControlsView,
  'command-dock': CommandDockView,
  'layer-panels': LayerPanelsView,
  context: ContextView,
  welcome: WelcomeView,
  'intel-hud': IntelHudView,
});

const mounted = new WeakMap();

/**
 * Render every application view into its host. Views belong to the page, as
 * their static markup did, so they are unmounted only when a later call omits
 * them; omit views before any control code is wired to them. Call before anything
 * reads or translates the page; repeated calls are harmless.
 * @param {Document} [doc] Page document.
 * @param {{omit?: string[]}} [options] Views this page leaves out; their
 *   hosts are removed, unmounting a view an earlier call rendered.
 */
export function mountApplicationViews(
  doc = globalThis.document,
  { omit = [] } = {},
) {
  for (const name of omit) {
    if (!Object.hasOwn(APPLICATION_VIEWS, name))
      throw new Error(`Unknown application view: ${name}`);
  }
  for (const host of doc?.querySelectorAll?.('[data-gev-view]') ?? []) {
    const name = host.getAttribute('data-gev-view');
    if (omit.includes(name)) {
      mounted.get(host)?.unmount();
      mounted.delete(host);
      host.remove();
      continue;
    }
    if (mounted.has(host)) continue;
    if (!Object.hasOwn(APPLICATION_VIEWS, name))
      throw new Error(`Unknown application view: ${name}`);
    const app = createApp(APPLICATION_VIEWS[name])
      .use(applicationPinia())
      .use(applicationI18n());
    app.mount(host);
    mounted.set(host, app);
  }
}
