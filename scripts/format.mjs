import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prettier from 'prettier';

/** Check or format the explicitly adopted files, without scanning other source. */
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

  // Validate the whole scope before any write, including resolved symlink paths.
  const files = [];
  for (const name of scope) {
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
        `${mode === '--write' ? 'Formatted' : 'Checked'} ${result.count} adopted files.`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
