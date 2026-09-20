import { readFileSync } from 'node:fs';

export const APPLICATION_TEMPLATES = Object.freeze([
  'scene-chrome',
  'cockpit',
  'display-controls',
  'command-dock',
  'layer-panels',
  'context',
  'welcome',
  'provider-settings',
  'console',
  'hud-loading',
]);
const allowed = new Set(APPLICATION_TEMPLATES);

/** Expand only known component templates; markers cannot name filesystem paths. */
export function expandApplicationHtml(html) {
  return html.replace(
    /^[ \t]*<!-- gev:template ([^\s]+) -->\r?\n?/gm,
    (_, name) => {
      if (!allowed.has(name))
        throw new Error(`Unknown application template: ${name}`);
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
