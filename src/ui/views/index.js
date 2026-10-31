import { createApp } from 'vue';
import { applicationPinia } from '../vueRuntime.js';
import WelcomeView from './WelcomeView.vue';
import ContextView from './ContextView.vue';
import LayerPanelsView from './LayerPanelsView.vue';
import CommandDockView from './CommandDockView.vue';
import DisplayControlsView from './DisplayControlsView.vue';
import CockpitView from './CockpitView.vue';
import SceneChromeView from './SceneChromeView.vue';
import ProviderSettingsView from './ProviderSettingsView.vue';

/**
 * Application views by template name (build/applicationViews.js lists the
 * same names). Each renders the markup its static template held.
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
});

const mounted = new WeakSet();

/**
 * Render every application view into its host. Views belong to the page, as
 * their static markup did, so they are never unmounted. Call before anything
 * reads or translates the page; repeated calls are harmless.
 * @param {Document} [doc] Page document.
 */
export function mountApplicationViews(doc = globalThis.document) {
  for (const host of doc?.querySelectorAll?.('[data-gev-view]') ?? []) {
    if (mounted.has(host)) continue;
    const name = host.getAttribute('data-gev-view');
    const view = APPLICATION_VIEWS[name];
    if (!view) throw new Error(`Unknown application view: ${name}`);
    createApp(view).use(applicationPinia()).mount(host);
    mounted.add(host);
  }
}
