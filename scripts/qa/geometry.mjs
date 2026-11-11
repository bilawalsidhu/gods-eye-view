import { build } from 'vite';
import { fileURLToPath } from 'node:url';

let bundle;

/** Supply geometry to page callbacks without requiring a dev server's /src routes. */
export async function evaluateWithGeo(page, callback, ...args) {
  const evaluate = new Function(
    '...args',
    `${await geometryBundle()}\nreturn (${callback})(qaGeo, ...args);`,
  );
  return page.evaluate(evaluate, ...args);
}

/** A self-contained predicate for page-side polling as well as evaluation. */
export async function withGeo(callback, ...args) {
  return `(() => { ${await geometryBundle()}\nreturn (${callback})(qaGeo, ...${JSON.stringify(args)}); })()`;
}

function geometryBundle() {
  bundle ??= build({
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(
          new URL('../../src/geo/index.js', import.meta.url),
        ),
        name: 'qaGeo',
        formats: ['iife'],
      },
    },
  }).then((result) => result[0].output[0].code);
  return bundle;
}
