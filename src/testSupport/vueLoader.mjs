import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

/**
 * Compile a single-file component to an ES module for Node's test runner.
 * Styles are dropped: tests read the global stylesheet separately.
 */
export function compileVueModule(source, filename) {
  const { descriptor, errors } = parse(source, { filename });
  if (errors.length) throw errors[0];
  const id = filename;
  if (descriptor.scriptSetup) {
    return compileScript(descriptor, { id, inlineTemplate: true }).content;
  }
  const script = descriptor.script
    ? compileScript(descriptor, { id }).content.replace(
        'export default',
        'const __sfc__ =',
      )
    : 'const __sfc__ = {};';
  const template = descriptor.template
    ? compileTemplate({ source: descriptor.template.content, filename, id })
        .code
    : '';
  return `${script}\n${template}\n__sfc__.render = typeof render === 'function' ? render : __sfc__.render;\nexport default __sfc__;\n`;
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
