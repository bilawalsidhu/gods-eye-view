import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function browserSources(directory = path.join(ROOT, 'src')) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...browserSources(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}

test('retired aircraft-view UI has no browser code, markup, or styles', () => {
  const files = [
    ...browserSources(),
    path.join(ROOT, 'index.html'),
    path.join(ROOT, 'style.css'),
  ];
  const retiredName = ['cock', 'pit'].join('');
  const references = files.flatMap((file) => (
    new RegExp(retiredName, 'i').test(readFileSync(file, 'utf8')) ? [path.relative(ROOT, file)] : []
  ));
  assert.deepEqual(references, []);
});

test('immersive camera ownership is driven by Drone View state', () => {
  const mission = readFileSync(path.join(ROOT, 'src', 'droneMission.js'), 'utf8');
  const navigation = readFileSync(path.join(ROOT, 'src', 'navigationPolicy.js'), 'utf8');
  const voice = readFileSync(path.join(ROOT, 'src', 'voice', 'gevActions.js'), 'utf8');

  assert.match(mission, /gev:drone-view-changed/);
  assert.match(navigation, /immersiveViewActive/);
  assert.equal(voice.includes(`control_${['cock', 'pit'].join('')}`), false);
});
