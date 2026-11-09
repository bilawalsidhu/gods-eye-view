import { parse } from 'vue/compiler-sfc';

/** JavaScript blocks with their original line numbers; templates are not code. */
export function vueScripts(source, filename) {
  const { descriptor, errors } = parse(source, { filename });
  if (errors.length) throw errors[0];
  return [descriptor.script, descriptor.scriptSetup]
    .filter(Boolean)
    .map((block) => '\n'.repeat(block.loc.start.line - 1) + block.content);
}
