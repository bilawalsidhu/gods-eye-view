import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEnvInit } from '../scripts/env-init.mjs';
import {
  SECRETS_FILE,
  SETTINGS_FILE,
  envAssignmentNames,
  envFilesFromTemplate,
  isSecretEnvName,
} from './secretEnv.mjs';

const TEMPLATE = fileURLToPath(new URL('../.env.example', import.meta.url));
const posix = process.platform !== 'win32';

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-env-init-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(TEMPLATE, path.join(root, '.env.example'));
  const lines = [];
  const run = (...argv) =>
    runEnvInit({ root, argv, log: (line) => lines.push(String(line)) });
  const read = (name) => readFileSync(path.join(root, name), 'utf8');
  const write = (name, text) => writeFileSync(path.join(root, name), text);
  return { root, run, read, write, lines, at: (name) => path.join(root, name) };
}

/** Active assignments of `name`, in file order (the last one is what dotenv loads). */
function activeValues(text, name) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
  return text
    .split('\n')
    .map((line) => line.match(pattern))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

test('init creates both files once, secrets owner-only, and never replaces them', (t) => {
  const box = sandbox(t);
  assert.equal(box.run(), 0);
  assert.deepEqual(
    envAssignmentNames(box.read(SETTINGS_FILE)).filter(isSecretEnvName),
    [],
  );
  assert.ok(envAssignmentNames(box.read(SECRETS_FILE)).every(isSecretEnvName));
  if (posix) assert.equal(statSync(box.at(SECRETS_FILE)).mode & 0o777, 0o600);
  box.write(SECRETS_FILE, 'OPENAI_API_KEY=mine\n');
  assert.equal(box.run(), 0);
  assert.equal(box.read(SECRETS_FILE), 'OPENAI_API_KEY=mine\n');
  assert.ok(
    box.lines.some((l) => l.startsWith('kept') && l.includes(SECRETS_FILE)),
  );
});

test('init --dry-run writes nothing', (t) => {
  const box = sandbox(t);
  assert.equal(box.run('--dry-run'), 0);
  assert.equal(existsSync(box.at(SECRETS_FILE)), false);
  assert.equal(existsSync(box.at(SETTINGS_FILE)), false);
});

test('init moves a key from an existing .env into its own placeholder line', (t) => {
  const box = sandbox(t);
  box.write(SETTINGS_FILE, 'PORT=4173\nTOMTOM_API_KEY=tt-secret\n');
  assert.equal(box.run(), 0);
  assert.equal(box.read(SETTINGS_FILE), 'PORT=4173\n');
  const local = box.read(SECRETS_FILE).split('\n');
  const slot = envFilesFromTemplate(readFileSync(TEMPLATE, 'utf8'))
    .secrets.split('\n')
    .findIndex((line) => /^\s*#?\s*TOMTOM_API_KEY\s*=/.test(line));
  assert.ok(slot >= 0, 'the template has a TOMTOM_API_KEY placeholder');
  assert.equal(
    local[slot],
    'TOMTOM_API_KEY=tt-secret',
    'the value takes the placeholder line',
  );
  assert.equal(
    local.filter((line) => /TOMTOM_API_KEY\s*=/.test(line)).length,
    1,
  );
  assert.ok(
    !local.some((line) => line.startsWith('# Moved from .env')),
    'nothing appended',
  );
  if (posix) assert.equal(statSync(box.at(SECRETS_FILE)).mode & 0o777, 0o600);
  assert.ok(box.lines.every((l) => !l.includes('tt-secret')));
});

test('init moves every key out of .env and prints no value', (t) => {
  const box = sandbox(t);
  box.write(
    SETTINGS_FILE,
    'PORT=4173\nOPENAI_API_KEY=sk-secret\n# GITHUB_TOKEN=gh-old\nHOST=localhost\n',
  );
  assert.equal(box.run(), 0);
  assert.equal(box.read(SETTINGS_FILE), 'PORT=4173\nHOST=localhost\n');
  const local = box.read(SECRETS_FILE);
  assert.match(local, /^OPENAI_API_KEY=sk-secret$/m);
  assert.match(local, /^# GITHUB_TOKEN=gh-old$/m);
  if (posix) assert.equal(statSync(box.at(SECRETS_FILE)).mode & 0o777, 0o600);
  assert.ok(box.lines.every((l) => !/sk-secret|gh-old/.test(l)));
  assert.deepEqual(
    readdirSync(box.root).filter((f) => f.endsWith('env-init-tmp')),
    [],
  );
});

test('init --dry-run with keys in .env changes nothing', (t) => {
  const box = sandbox(t);
  box.write(SETTINGS_FILE, 'OPENAI_API_KEY=sk-secret\n');
  assert.equal(box.run('--dry-run'), 0);
  assert.equal(box.read(SETTINGS_FILE), 'OPENAI_API_KEY=sk-secret\n');
  assert.equal(existsSync(box.at(SECRETS_FILE)), false);
  assert.ok(
    box.lines.some(
      (l) => l.startsWith('would move') && l.includes('OPENAI_API_KEY'),
    ),
  );
});

test('init keeps an existing secrets file mode and appends a key it has no placeholder for', (t) => {
  const box = sandbox(t);
  box.write(SECRETS_FILE, 'CESIUM_ION_TOKEN=ion\n');
  if (posix) chmodSync(box.at(SECRETS_FILE), 0o640);
  box.write(SETTINGS_FILE, 'FIRMS_MAP_KEY=firms\nPORT=1\n');
  assert.equal(box.run(), 0);
  assert.match(
    box.read(SECRETS_FILE),
    /^CESIUM_ION_TOKEN=ion\n[\s\S]*^FIRMS_MAP_KEY=firms$/m,
  );
  if (posix) assert.equal(statSync(box.at(SECRETS_FILE)).mode & 0o777, 0o640);
  assert.equal(box.read(SETTINGS_FILE), 'PORT=1\n');
});

test('init: every key ends up in .env.local, the line with a value is the one kept', (t) => {
  const box = sandbox(t);
  assert.equal(box.run(), 0); // fresh files from the template
  box.write(
    SECRETS_FILE,
    box
      .read(SECRETS_FILE)
      .replace(/^AISSTREAM_API_KEY=.*$/m, 'AISSTREAM_API_KEY=a-local')
      .replace(/^OPENAI_API_KEY=.*$/m, 'OPENAI_API_KEY=sk-same')
      .replace(/^# TOMTOM_API_KEY=.*$/m, 'TOMTOM_API_KEY=tt-local'),
  );
  box.write(
    SETTINGS_FILE,
    [
      'GOOGLE_MAPS_API_KEY=g-env', //  value     | placeholder → takes it
      'CESIUM_ION_TOKEN=', //          blank     | placeholder → stays blank
      'AISSTREAM_API_KEY=', //         blank     | value       → value kept
      'OPENAI_API_KEY=sk-same', //     value     | same value  → just leaves
      'TOMTOM_API_KEY=tt-env', //      value     | other value → .env.local stays live
      '# FIRMS_MAP_KEY=f-old', //      commented | placeholder → moves, still commented
      'PORT=4173',
      '',
    ].join('\n'),
  );
  box.lines.length = 0;
  assert.equal(box.run(), 0);
  assert.equal(box.read(SETTINGS_FILE), 'PORT=4173\n');
  const local = box.read(SECRETS_FILE);
  assert.deepEqual(activeValues(local, 'GOOGLE_MAPS_API_KEY'), ['g-env']);
  assert.deepEqual(activeValues(local, 'CESIUM_ION_TOKEN'), ['']);
  assert.deepEqual(activeValues(local, 'AISSTREAM_API_KEY'), ['a-local']);
  assert.deepEqual(activeValues(local, 'OPENAI_API_KEY'), ['sk-same']);
  assert.deepEqual(activeValues(local, 'TOMTOM_API_KEY'), ['tt-local']);
  assert.match(
    local,
    /^TOMTOM_API_KEY=tt-local\n# env:init: .*\n# TOMTOM_API_KEY=tt-env$/m,
  );
  assert.match(local, /^# FIRMS_MAP_KEY=f-old$/m);
  assert.doesNotMatch(
    local,
    /^# Moved from \.env/m,
    'every key had a placeholder',
  );
  assert.ok(
    box.lines.some(
      (l) => l.startsWith('CHECK') && l.includes('TOMTOM_API_KEY'),
    ),
  );
  assert.ok(
    box.lines.every(
      (l) => !/g-env|a-local|sk-same|tt-local|tt-env|f-old/.test(l),
    ),
  );
  // A second run changes nothing.
  const before = [box.read(SECRETS_FILE), box.read(SETTINGS_FILE)];
  assert.equal(box.run(), 0);
  assert.deepEqual([box.read(SECRETS_FILE), box.read(SETTINGS_FILE)], before);
});

test('an unknown option is refused, including the retired --migrate', (t) => {
  const box = sandbox(t);
  assert.equal(box.run('--force'), 64);
  assert.equal(box.run('--migrate'), 64);
  assert.equal(existsSync(box.at(SECRETS_FILE)), false);
});
