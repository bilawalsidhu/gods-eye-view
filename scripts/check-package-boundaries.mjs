import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, normalizePath } from 'vite';

/** Build each browser or Node export group and reject imports outside its declared ownership. */
export async function checkPackageBoundaries(root) {
  root = await realpath(root);
  const readJson = async (name) =>
    JSON.parse(await readFile(path.join(root, name), 'utf8'));
  const pkg = await readJson('package.json');
  const groups = await readJson('scripts/package-boundaries.json');
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
      !group.modules.length ||
      !Array.isArray(group.external)
    ) {
      throw new Error(`Invalid package boundary: ${name}`);
    }
    const allowed = new Set();
    for (const module of group.modules) {
      if (
        typeof module !== 'string' ||
        path.isAbsolute(module) ||
        module.includes('\\') ||
        module.split('/').includes('..')
      ) {
        throw new Error(`Boundary modules must be repository paths: ${name}`);
      }
      const resolved = await realpath(path.join(root, module));
      const relative = path.relative(root, resolved);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`Boundary module escapes repository: ${name}`);
      }
      allowed.add(normalizePath(resolved));
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
        !allowed.has(normalizePath(path.resolve(root, target)))
      ) {
        throw new Error(`Export must point to an owned module: ${key}`);
      }
      return path.resolve(root, target);
    });
    const seen = new Set();
    await build({
      root,
      configFile: false,
      envFile: false,
      publicDir: false,
      ssr: node ? { noExternal: true } : undefined,
      logLevel: 'silent',
      plugins: [
        {
          name: 'check-package-ownership',
          moduleParsed(info) {
            if (!allowed.has(info.id)) {
              throw new Error(
                `Package boundary ${name} imports an unowned module: ${path.relative(root, info.id)}`,
              );
            }
            seen.add(info.id);
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
          external: group.external,
          // Unused imports must still obey ownership; tree shaking is not a boundary.
          treeshake: false,
          preserveEntrySignatures: 'strict',
        },
      },
    });
    reports.push({ name, exports: input.length, modules: seen.size });
  }
  return reports;
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    const reports = await checkPackageBoundaries(
      fileURLToPath(new URL('../', import.meta.url)),
    );
    for (const report of reports)
      console.log(
        `Checked ${report.name}: ${report.exports} exports, ${report.modules} owned modules.`,
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
