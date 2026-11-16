/**
 * Groups of controls added to the Display panel, under
 * Effects: toggles, sliders and notes, each answered by whoever added it.
 */
import { applicationPinia } from './vueRuntime.js';
import { useDisplayStore } from './stores/display.js';

/**
 * Show the group `id` on the page's Display panel as `group` describes it,
 * in place where it is shown already; null takes it away. A row is a
 * `toggle` (`{kind, id, label, icon?, title?, checked, onChange(checked)}`),
 * a `slider` (`{kind, id, label, min, max, value, onChange(value)}`, its
 * value shown in percent) or a `note` (`{kind, id, text}`). Publish it again
 * whenever what it shows changes.
 * @param {string} id
 * @param {?{rows: object[]}} group
 */
export function publishDisplayGroup(id, group) {
  useDisplayStore(applicationPinia()).publishGroup(id, group);
}
