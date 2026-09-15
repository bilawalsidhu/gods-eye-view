import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeModule } from './module-analysis.mjs';

const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);
const code = /\.[mc]?js$/;
const entry = (file) =>
  file === 'src/main.js' || file.startsWith('src/standalone/');
const tests = (file) =>
  file.endsWith('.test.mjs') ||
  file.startsWith('src/testSupport/') ||
  file.startsWith('src/tooling/') ||
  file === 'src/overlays/worldOverlayAllocation.worker.mjs';
const source = (file) =>
  file.startsWith('src/sources/') ||
  /^src\/layers\/[^/]+\/(?:source|bundledSource|flowSource)\.js$/.test(file);
const renderer = (file) =>
  /^src\/(?:ui|app|standalone|overlays)\//.test(file) ||
  /^src\/layers\/[^/]+\/(?:index|rendering|snapshotRenderer|overlay|presentation|cards|controls)\.js$/.test(
    file,
  );
// Two compatibility composition entries intentionally select standalone defaults.
const compatibilityEdge = (from, to) =>
  (from === 'server/providers/local.js' &&
    to === 'server/standalone/key-setup.js') ||
  (from === 'src/ui.js' && to === 'src/standalone/catalog.js');
const portableExport = (key) =>
  key.startsWith('./sources/') ||
  /\/source$/.test(key) ||
  /^\.\/layers\/(?:flights|military|vessels)\/(?:records|ingestion)$/.test(
    key,
  ) ||
  ['./voice/action-schemas', './voice/session', './data/lifecycle'].includes(
    key,
  );

/** Check every runtime file, plus transitive portable/source graphs, independently of bundler reachability. */
export function checkImportDirections(root) {
  root = realpathSync(root);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = [
    ...new Set(
      execFileSync(
        'git',
        [
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
          '--',
          'src',
          'server',
        ],
        { cwd: root, encoding: 'utf8' },
      ).split('\0'),
    ),
  ].filter(
    (file) =>
      code.test(file) && !tests(file) && existsSync(path.join(root, file)),
  );
  const errors = new Set();
  const modules = new Map();
  const relative = (file) =>
    path.relative(root, file).split(path.sep).join('/');
  const report = (file, message) => errors.add(`${file}: ${message}`);
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const resolved = realpathSync(path.join(root, file));
    if (relative(resolved) !== file) {
      report(
        file,
        'Runtime modules must not alias other owners through symlinks',
      );
      return null;
    }
    let analysis;
    try {
      analysis = analyzeModule(readFileSync(resolved, 'utf8'));
    } catch (error) {
      report(file, error.message);
      return null;
    }
    const record = { ...analysis, edges: [], external: [] };
    modules.set(file, record);
    for (const specifier of analysis.imports) {
      let target;
      if (specifier.startsWith('.'))
        target = path.resolve(path.dirname(resolved), specifier.split('?')[0]);
      else if (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) {
        const key =
          specifier === pkg.name ? '.' : '.' + specifier.slice(pkg.name.length);
        const exported = pkg.exports?.[key];
        if (typeof exported !== 'string') {
          report(file, `Unsupported self import: ${specifier}`);
          continue;
        }
        target = path.resolve(root, exported);
      } else {
        record.external.push(specifier);
        if (
          file.startsWith('src/') &&
          (builtins.has(specifier) || specifier.startsWith('node:'))
        )
          report(file, `Node builtin in browser module: ${specifier}`);
        if (
          specifier.startsWith('/') ||
          (/^[a-z]+:/i.test(specifier) && !specifier.startsWith('node:'))
        )
          report(file, `Use repository or package imports: ${specifier}`);
        continue;
      }
      if (!existsSync(target)) {
        report(file, `Missing import: ${specifier}`);
        continue;
      }
      const to = relative(realpathSync(target));
      if (to.startsWith('../') || path.isAbsolute(to)) {
        report(file, `Import escapes repository: ${specifier}`);
        continue;
      }
      record.edges.push(to);
      if (file.startsWith('src/') && to.startsWith('server/'))
        report(file, `Browser imports server: ${to}`);
      if (
        !compatibilityEdge(file, to) &&
        file.startsWith('server/providers/') &&
        (to.startsWith('server/standalone/') || renderer(to))
      )
        report(file, `Provider imports application/rendering: ${to}`);
      if (
        !compatibilityEdge(file, to) &&
        file.startsWith('src/') &&
        !entry(file) &&
        entry(to)
      )
        report(file, `Reusable module imports standalone setup: ${to}`);
      if (source(file) && renderer(to))
        report(file, `Source imports rendering/application: ${to}`);
      if (file === 'src/voice/gevActions.js' && to === 'src/data/manager.js')
        report(
          file,
          'Actions must consume feed state without the manager facade',
        );
      if (
        file === 'src/app/constructCatalog.js' &&
        to === 'src/data/localGeojson.js'
      )
        report(
          file,
          'Catalog must use the services owner without compatibility layer construction',
        );
    }
    return record;
  }
  for (const file of files) load(file);
  // A helper outside src must not smuggle Node or server code into a browser graph.
  const browserSeen = new Set();
  function browser(file) {
    if (browserSeen.has(file) || !code.test(file)) return;
    browserSeen.add(file);
    const info = load(file);
    if (!info) return;
    for (const specifier of info.external) {
      if (builtins.has(specifier) || specifier.startsWith('node:'))
        report(file, `Browser graph reaches Node builtin: ${specifier}`);
    }
    for (const to of info.edges) {
      if (to.startsWith('server/') || tests(to))
        report(file, `Browser graph reaches non-runtime owner: ${to}`);
      else browser(to);
    }
  }
  for (const file of files.filter((file) => file.startsWith('src/')))
    browser(file);
  const roots = new Map(files.filter(source).map((file) => [file, 'source']));
  for (const [key, value] of Object.entries(pkg.exports || {})) {
    if (portableExport(key) && typeof value === 'string')
      roots.set(value.replace(/^\.\//, ''), key);
  }
  roots.set('src/data/feedState.js', 'feed state');
  for (const [start, label] of roots) {
    if (!existsSync(path.join(root, start))) {
      report(start, `Missing portable entry: ${label}`);
      continue;
    }
    const seen = new Set();
    function visit(file) {
      if (seen.has(file) || !code.test(file)) return;
      seen.add(file);
      const info = load(file);
      if (!info) return;
      if (info.browser.length)
        report(
          file,
          `${label} reaches browser globals: ${info.browser.join(', ')}`,
        );
      for (const specifier of info.external) {
        if (
          builtins.has(specifier) ||
          specifier.startsWith('node:') ||
          /^(?:cesium|vite)(?:\/|$)/.test(specifier)
        )
          report(
            file,
            `${label} reaches platform/rendering dependency: ${specifier}`,
          );
      }
      for (const to of info.edges) {
        if (renderer(to) || to.startsWith('server/'))
          report(file, `${label} reaches application/rendering: ${to}`);
        else visit(to);
      }
    }
    visit(start);
  }
  // Common voice controls may use their DOM view, but never a protocol implementation.
  const voiceSeen = new Set();
  function voice(file) {
    if (voiceSeen.has(file)) return;
    voiceSeen.add(file);
    const info = load(file);
    for (const to of info?.edges || []) {
      if (/^src\/voice\/realtime/.test(to))
        report(file, `Common voice controls import protocol: ${to}`);
      else if (code.test(to)) voice(to);
    }
  }
  if (existsSync(path.join(root, 'src/voice/sessionCommands.js')))
    voice('src/voice/sessionCommands.js');
  if (errors.size) throw new Error([...errors].join('\n'));
  return { modules: files.length, portableEntries: roots.size };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        checkImportDirections(fileURLToPath(new URL('../', import.meta.url))),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
