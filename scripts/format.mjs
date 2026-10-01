import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';

/** Discover owned runtime code; tests and other files retain explicit adoption. */
export async function discoverRuntimeFormatFiles(root) {
  const configFile = path.join(root, 'scripts/format-runtime.json');
  if (!existsSync(configFile)) return [];
  const { roots } = JSON.parse(await readFile(configFile, 'utf8'));
  if (
    !Array.isArray(roots) ||
    !roots.length ||
    new Set(roots).size !== roots.length ||
    roots.some(
      (name) =>
        typeof name !== 'string' ||
        !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(name),
    )
  )
    throw new Error(
      'Runtime formatting roots must be unique repository directory paths',
    );
  const candidates = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...roots,
    ],
    { cwd: root, encoding: 'utf8' },
  ).split('\0');
  const files = [];
  for (const name of new Set(candidates)) {
    if (
      !/\.[cm]?js$/.test(name) ||
      /\.test\.[cm]?js$/.test(name) ||
      !existsSync(path.join(root, name))
    )
      continue;
    const info = await prettier.getFileInfo(path.join(root, name), {
      ignorePath: path.join(root, '.prettierignore'),
    });
    if (!info.ignored) files.push(name);
  }
  return files.sort();
}

/** Check or format explicit adoption plus automatically discovered runtime code. */
export async function formatAdoptedFiles(root, mode) {
  if (!['--check', '--write'].includes(mode)) {
    throw new Error('Usage: node scripts/format.mjs --check|--write');
  }
  root = await realpath(root);
  const scope = JSON.parse(
    await readFile(path.join(root, 'scripts/format-scope.json'), 'utf8'),
  );
  if (
    !Array.isArray(scope) ||
    !scope.length ||
    new Set(scope).size !== scope.length
  ) {
    throw new Error(
      'Formatting scope must be a nonempty list of unique file paths',
    );
  }

  const names = [
    ...new Set([...scope, ...(await discoverRuntimeFormatFiles(root))]),
  ];

  // Validate the whole scope before any write, including resolved symlink paths.
  const files = [];
  for (const name of names) {
    if (
      typeof name !== 'string' ||
      !name ||
      name.includes('\\') ||
      path.isAbsolute(name) ||
      name.split('/').includes('..')
    ) {
      throw new Error(
        'Formatting scope entries must be paths inside the repository',
      );
    }
    const file = path.join(root, name);
    const relative = path.relative(root, await realpath(file));
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !(await stat(file)).isFile()
    ) {
      throw new Error(
        `Formatting scope must contain repository files: ${name}`,
      );
    }
    const info = await prettier.getFileInfo(file, {
      ignorePath: path.join(root, '.prettierignore'),
    });
    if (info.ignored || !info.inferredParser) {
      throw new Error(
        `Formatting scope contains an ignored or unsupported file: ${name}`,
      );
    }
    const options = { ...(await prettier.resolveConfig(file)), filepath: file };
    const source = await readFile(file, 'utf8');
    files.push({
      name,
      file,
      source,
      formatted: await prettier.format(source, options),
    });
  }

  const changed = files.filter(({ source, formatted }) => source !== formatted);
  if (mode === '--write') {
    for (const { file, formatted } of changed) await writeFile(file, formatted);
  }
  return { count: files.length, changed: changed.map(({ name }) => name) };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: node scripts/format.mjs --check|--write');
    const mode = process.argv[2];
    const result = await formatAdoptedFiles(
      fileURLToPath(new URL('../', import.meta.url)),
      mode,
    );
    if (mode === '--check' && result.changed.length) {
      for (const name of result.changed)
        console.error(`Needs formatting: ${name}`);
      process.exitCode = 1;
    } else {
      console.log(
        `${mode === '--write' ? 'Formatted' : 'Checked'} ${result.count} source files.`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
