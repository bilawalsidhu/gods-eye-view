import { readFileSync } from 'node:fs';
import { APPLICATION_VIEW_NAMES } from './applicationViews.js';

export const APPLICATION_TEMPLATES = Object.freeze([
  'scene-chrome',
  'cockpit',
  'display-controls',
  'command-dock',
  'layer-panels',
  'context',
  'welcome',
  'provider-settings',
  'hud-loading',
]);
const allowed = new Set(APPLICATION_TEMPLATES);
const views = new Set(APPLICATION_VIEW_NAMES);

/**
 * The element a Vue view renders into. `display: contents` keeps the view's
 * own elements laid out as children of the page.
 * @param {string} name Application template name.
 */
export function applicationViewHost(name) {
  return `<div class="gev-view" data-gev-view="${name}"></div>\n`;
}

/** Expand only known component templates; markers cannot name filesystem paths. */
export function expandApplicationHtml(html) {
  return html.replace(
    /^[ \t]*<!-- gev:template ([^\s]+) -->\r?\n?/gm,
    (_, name) => {
      if (!allowed.has(name))
        throw new Error(`Unknown application template: ${name}`);
      if (views.has(name)) return applicationViewHost(name);
      return readFileSync(
        new URL(`../src/ui/templates/${name}.html`, import.meta.url),
        'utf8',
      );
    },
  );
}

/** Assemble static application markup before Vite processes scripts and assets. */
export function applicationHtmlPlugin() {
  return {
    name: 'application-component-templates',
    transformIndexHtml: {
      order: 'pre',
      handler: expandApplicationHtml,
    },
  };
}
