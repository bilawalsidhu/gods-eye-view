import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VUE_TEMPLATE_OPTIONS } from './vueOptions.js';

const require = createRequire(import.meta.url);

// The compiler loads on the first component that is not cached, so a test
// process that imports no views, or only cached ones, never pays for it.
let compiler = null;
const sfcCompiler = () => (compiler ??= require('vue/compiler-sfc'));

/**
 * Compile a single-file component to an ES module for Node, so unit tests (the
 * application's and a host's) can import components without a bundler.
 * Styles are dropped: tests read the global stylesheet separately.
 */
export function compileVueModule(source, filename) {
  const { compileScript, compileTemplate, parse } = sfcCompiler();
  // The template is parsed with the SFC; parse it as the browser build does.
  const { descriptor, errors } = parse(source, {
    filename,
    templateParseOptions: VUE_TEMPLATE_OPTIONS.compilerOptions,
  });
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

// The loader's own code is part of every key, so a change to how components
// compile never reuses output from before it.
let loaderFingerprint = null;
const fingerprint = () =>
  (loaderFingerprint ??= createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(readFileSync(new URL('./vueOptions.js', import.meta.url)))
    .update(require('vue/package.json').version)
    .digest('hex'));

/**
 * Where compiled components are kept between test processes, never a
 * package's own tree (a host's checks refuse files inside Core): the system
 * temp directory, or on Windows the per-user local app data directory, since
 * a temp directory there may be shared and its ownership is not checked.
 * GEV_VUE_CACHE=0 compiles every time.
 */
export function vueCacheDirectory(
  env = process.env,
  platform = process.platform,
) {
  if (env.GEV_VUE_CACHE === '0') return null;
  if (platform === 'win32') {
    return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'gev-vue-sfc') : null;
  }
  return path.join(tmpdir(), `gev-vue-sfc-${process.getuid()}`);
}

/** The cache entry for one component: its path, its text and the loader. */
export function vueCacheKey(source, filename) {
  return createHash('sha256')
    .update(JSON.stringify([fingerprint(), filename]))
    .update('\0')
    .update(source)
    .digest('hex');
}

/**
 * Compile a component, reusing a previous process's result for the same text.
 * A cache that cannot be read or written only costs the compile.
 */
export function cachedVueModule(
  source,
  filename,
  directory = vueCacheDirectory(),
) {
  if (!directory || !ownCacheDirectory(directory)) {
    return compileVueModule(source, filename);
  }
  const entry = path.join(directory, `${vueCacheKey(source, filename)}.mjs`);
  try {
    return readFileSync(entry, 'utf8');
  } catch {
    // Not compiled yet.
  }
  const compiled = compileVueModule(source, filename);
  // Concurrent test processes and threads may compile the same component;
  // each writes its own new file and the rename makes the entry appear whole.
  const partial = `${entry}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(partial, compiled, { flag: 'wx', mode: 0o600 });
    renameSync(partial, entry);
  } catch {
    // An unwritable directory, or a rename another process holds open,
    // leaves the cache without this entry.
    try {
      rmSync(partial, { force: true });
    } catch {
      // A partial file that cannot be removed is only clutter.
    }
  }
  return compiled;
}

/**
 * Cached modules run as code, so the directory must be this user's own: a
 * real directory (not a link), owned by the current user and writable by no
 * one else. In a shared temp directory another user could otherwise create it
 * first and plant modules. On Windows it sits in the user's own profile.
 */
const checkedDirectories = new Map();
export function ownCacheDirectory(directory) {
  if (!checkedDirectories.has(directory)) {
    checkedDirectories.set(directory, isOwnDirectory(directory));
  }
  return checkedDirectories.get(directory);
}

function isOwnDirectory(directory) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stats = lstatSync(directory);
    if (!stats.isDirectory()) return false;
    if (process.platform === 'win32') return true;
    return stats.uid === process.getuid() && (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Synchronous module hook (module.registerHooks): `.vue` loads compiled. */
export function load(url, context, nextLoad) {
  if (!url.endsWith('.vue')) return nextLoad(url, context);
  const filename = fileURLToPath(url);
  return {
    format: 'module',
    source: cachedVueModule(readFileSync(filename, 'utf8'), filename),
    shortCircuit: true,
  };
}
