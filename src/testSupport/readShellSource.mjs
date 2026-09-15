import { readFileSync } from 'node:fs';
import { StyleManager } from '../ui/applicationShell.js';
import { NavigationController } from '../ui/navigationController.js';
import { ShareRestoration } from '../ui/shareRestoration.js';
import { VisualSettings } from '../ui/visualSettings.js';
import { PanelChrome } from '../ui/panelChrome.js';

/** Read the state owners as well as the compatibility/composition facade. */
export function readShellSource() {
  return [
    'navigationController',
    'shareRestoration',
    'visualSettings',
    'panelChrome',
    'applicationShell',
  ]
    .map((name) =>
      readFileSync(new URL(`../ui/${name}.js`, import.meta.url), 'utf8'),
    )
    .join('\n');
}

/** Select the implementation owner instead of testing a forwarding facade. */
export function shellMethod(name) {
  for (const owner of [
    NavigationController,
    ShareRestoration,
    VisualSettings,
    PanelChrome,
    StyleManager,
  ]) {
    const method = Object.getOwnPropertyDescriptor(
      owner.prototype,
      name,
    )?.value;
    if (typeof method === 'function') return method;
  }
  return null;
}
