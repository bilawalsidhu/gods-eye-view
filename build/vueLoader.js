import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { VUE_TEMPLATE_OPTIONS } from './vueOptions.js';

/**
 * Compile a single-file component to an ES module for Node, so unit tests (the
 * application's and a host's) can import components without a bundler.
 * Styles are dropped: tests read the global stylesheet separately.
 */
export function compileVueModule(source, filename) {
  const { descriptor, errors } = parse(source, { filename });
  if (errors.length) throw errors[0];
  const id = filename;
  if (descriptor.scriptSetup) {
    return compileScript(descriptor, {
      id,
      inlineTemplate: true,
      templateOptions: VUE_TEMPLATE_OPTIONS,
    }).content;
  }
  const script = descriptor.script
    ? compileScript(descriptor, { id, genDefaultAs: '__sfc__' }).content
    : 'const __sfc__ = {};';
  let template = '';
  if (descriptor.template) {
    const compiled = compileTemplate({
      source: descriptor.template.content,
      filename,
      id,
      ...VUE_TEMPLATE_OPTIONS,
    });
    if (compiled.errors.length) throw compiled.errors[0];
    template = compiled.code;
  }
  return `${script}\n${template}\nif (typeof render === 'function') __sfc__.render = render;\nexport default __sfc__;\n`;
}

/** Node module hook: load `.vue` files as compiled modules. */
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.vue')) return nextLoad(url, context);
  const filename = fileURLToPath(url);
  const source = await readFile(filename, 'utf8');
  return {
    format: 'module',
    source: compileVueModule(source, filename),
    shortCircuit: true,
  };
}
