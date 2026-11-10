import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { VUE_PLUGIN_OPTIONS } from '../build/vueOptions.js';
import { build, normalizePath } from 'vite';
import * as prettier from 'prettier';

/** Build each browser or Node export group and reject imports outside its declared ownership. */
export async function checkPackageBoundaries(root) {
  return buildPackageBoundaries(root, false);
}

/** Regenerate module ownership from each export group's complete build graph. */
export async function writePackageBoundaries(root) {
  return buildPackageBoundaries(root, true);
}

async function buildPackageBoundaries(root, write) {
  root = await realpath(root);
  const readJson = async (name) =>
    JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const pkg = await readJson('package.json');
  const manifest = await readJson('scripts/package-boundaries.json');
  const { engineImportExceptions, ...groups } = manifest;
  const declaredExports = Object.keys(pkg.exports || {}).sort();
  const classifiedExports = Object.values(groups)
    .flatMap((group) => group.exports)
    .sort();
  if (
    !declaredExports.length ||
    JSON.stringify(declaredExports) !== JSON.stringify(classifiedExports)
  ) {
    throw new Error(
      'Every package export must belong to exactly one boundary group',
    );
  }
  const reports = [];
  for (const [name, group] of Object.entries(groups)) {
    const node = group.runtime === 'node';
    if (group.runtime && !['browser', 'node'].includes(group.runtime)) {
      throw new Error(`Invalid boundary runtime: ${name}`);
    }
    if (
      !Array.isArray(group.modules) ||
      (!write && !group.modules.length) ||
      !Array.isArray(group.external)
    ) {
      throw new Error(`Invalid package boundary: ${name}`);
    }
    // A module entry ending in "/" owns every file under that directory.
    const allowed = new Set();
    const allowedDirectories = [];
    const modulePaths = new Map();
    const owns = (id) =>
      allowed.has(id) || allowedDirectories.some((dir) => id.startsWith(dir));
    for (const module of group.modules) {
      if (
        typeof module !== 'string' ||
        path.isAbsolute(module) ||
        module.includes('\\') ||
        module.split('/').includes('..')
      ) {
        throw new Error(`Boundary modules must be repository paths: ${name}`);
      }
      let resolved;
      try {
        resolved = await realpath(path.join(root, module));
      } catch (error) {
        if (write && error.code === 'ENOENT') continue;
        throw error;
      }
      const relative = path.relative(root, resolved);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`Boundary module escapes repository: ${name}`);
      }
      if (module.endsWith('/')) {
        allowedDirectories.push(`${normalizePath(resolved)}/`);
      } else {
        allowed.add(normalizePath(resolved));
      }
      modulePaths.set(module, normalizePath(resolved));
    }
    for (const external of group.external) {
      if (
        !Object.hasOwn(pkg.dependencies || {}, external) &&
        !Object.hasOwn(pkg.peerDependencies || {}, external) &&
        !(node && Object.hasOwn(pkg.devDependencies || {}, external))
      ) {
        throw new Error(
          `Boundary external must be a declared dependency for its runtime: ${external}`,
        );
      }
    }
    const input = group.exports.map((key) => {
      const declaration = pkg.exports[key];
      const target = node ? declaration?.node : declaration;
      if (
        node &&
        (typeof declaration !== 'object' ||
          Object.keys(declaration).join() !== 'node')
      ) {
        throw new Error(`Node export must have only a node condition: ${key}`);
      }
      if (
        typeof target !== 'string' ||
        !target.startsWith('./') ||
        (!write && !owns(normalizePath(path.resolve(root, target))))
      ) {
        throw new Error(`Export must point to an owned module: ${key}`);
      }
      return path.resolve(root, target);
    });
    const seen = new Set();
    await build({
      root,
      // Keep this gate out of a running dev server's dependency cache
      // (node_modules/.vite): a build there re-optimizes dependencies and the
      // dev server's workers then fail with 504 "Outdated Optimize Dep".
      cacheDir: path.join(root, 'node_modules/.vite-boundaries'),
      configFile: false,
      envFile: false,
      publicDir: false,
      ssr: node ? { noExternal: true } : undefined,
      logLevel: 'silent',
      plugins: [
        vue(VUE_PLUGIN_OPTIONS),
        {
          name: 'check-package-ownership',
          moduleParsed(info) {
            // Plugin helpers are virtual; a single-file component's style and
            // template blocks belong to the component file itself.
            if (info.id.startsWith('\0')) return;
            const id = info.id.split('?')[0];
            if (!write && !owns(id)) {
              throw new Error(
                `Package boundary ${name} imports an unowned module: ${path.relative(root, id)}`,
              );
            }
            seen.add(id);
          },
        },
      ],
      build: {
        ssr: node,
        lib: { entry: input, formats: ['es'] },
        write: false,
        minify: false,
        assetsInlineLimit: 0,
        rollupOptions: {
          input,
          // A declared dependency also owns its package subpath exports
          // (for example `@jtarrio/webrtlsdr/rtlsdr.js`).
          external: (id) =>
            group.external.some(
              (name) => id === name || id.startsWith(`${name}/`),
            ),
          // Unused imports must still obey ownership; tree shaking is not a boundary.
          treeshake: false,
          preserveEntrySignatures: 'strict',
        },
      },
    });
    if (write) {
      const reached = [...seen];
      const kept = group.modules.filter((module) => {
        const resolved = modulePaths.get(module);
        return module.endsWith('/')
          ? reached.some((id) => id.startsWith(`${resolved}/`))
          : seen.has(resolved);
      });
      const removed = group.modules.filter((module) => !kept.includes(module));
      const added = reached
        .filter((id) => !owns(id))
        .map((id) => {
          const relative = path.relative(root, id);
          if (
            !path.isAbsolute(id) ||
            relative === '..' ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            throw new Error(`Boundary module escapes repository: ${name}`);
          }
          return normalizePath(relative);
        })
        .sort();
      group.modules = [...kept, ...added];
      if (added.length || removed.length)
        reports.push({ name, added, removed });
    } else {
      reports.push({ name, exports: input.length, modules: seen.size });
    }
  }
  if (write && reports.length) {
    const file = path.join(root, 'scripts/package-boundaries.json');
    const formatted = await prettier.format(JSON.stringify(manifest), {
      ...(await prettier.resolveConfig(file)),
      filepath: file,
    });
    await writeFile(file, formatted);
  }
  return reports;
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    if (process.argv.includes('--write')) {
      const reports = await writePackageBoundaries(root);
      for (const { name, added, removed } of reports) {
        console.log(
          `Updated ${name}: ${added.length} added, ${removed.length} removed.`,
        );
        if (added.length + removed.length <= 20) {
          for (const module of added) console.log(`  + ${module}`);
          for (const module of removed) console.log(`  - ${module}`);
        }
      }
    } else {
      const reports = await checkPackageBoundaries(root);
      for (const report of reports)
        console.log(
          `Checked ${report.name}: ${report.exports} exports, ${report.modules} owned modules.`,
        );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
