import { readFileSync } from 'node:fs';
import { createPinia } from 'pinia';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { APPLICATION_VIEWS } from '../ui/views/index.js';

const HOST = /<div class="gev-view" data-gev-view="([^"]+)"><\/div>/g;

/**
 * Application markup as the browser shows it once views are mounted: each
 * view rendered into its host. Markup tests read this instead of the page
 * source.
 * @param {string} html Document with `.gev-view` hosts.
 * @returns {Promise<string>}
 */
export async function renderApplicationHtml(html) {
  let output = html;
  for (const [host, name] of [...output.matchAll(HOST)]) {
    const view = APPLICATION_VIEWS[name];
    if (!view) throw new Error(`Unknown application view: ${name}`);
    const markup = (await renderToString(createSSRApp(view).use(createPinia())))
      // Hydration markers, empty-attribute values and escaped apostrophes
      // are SSR detail; the DOM is the same as the template's.
      .replace(/<!--\[-->|<!--\]-->|<!---->/g, '')
      .replace(/ ([\w:.-]+)=""/g, ' $1')
      .replaceAll('&#39;', "'");
    output = output.replace(
      host,
      () => `<div class="gev-view" data-gev-view="${name}">${markup}</div>`,
    );
  }
  return output;
}

/** The standalone page's markup with every view rendered. */
export function readApplicationHtml() {
  return renderApplicationHtml(
    readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
  );
}
