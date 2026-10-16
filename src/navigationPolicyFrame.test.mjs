// The Cockpit refusal names its destination in the UI language. The scan
// below collects every noun the callers hand to the navigation policy, so a
// noun without its own sentence fails here instead of reaching the page.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setLocale } from './i18n/index.js';
import {
  COCKPIT_REFUSAL_NOUNS,
  runExplicitNavigation,
} from './navigationPolicy.js';
import { WORLD_FOCUS_FRAMING } from './worldFocus.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));

test.afterEach(() => setLocale('en'));

function cockpitToast(noun) {
  const log = [];
  runExplicitNavigation({
    cockpitActive: true,
    noun,
    showToast: (text) => log.push(text),
    stamp: () => 1,
    release: () => {},
    navigate: () => {},
  });
  assert.equal(log.length, 1);
  return log[0];
}

test('es: the Cockpit refusal for frame_overhead has no English id', () => {
  setLocale('es');
  const shown = cockpitToast('frame');
  assert.doesNotMatch(shown, /\bframe\b/, shown);
  assert.equal(shown, 'Sal de la cabina para encuadrar contactos');
});

test('en: the voice nouns read as English sentences', () => {
  setLocale('en');
  assert.equal(cockpitToast('frame'), 'Exit cockpit to frame contacts');
  assert.equal(cockpitToast('aircraft'), 'Exit cockpit to fly to an aircraft');
  assert.equal(cockpitToast('satellite'), 'Exit cockpit to fly to a satellite');
});

// ── Every noun a caller passes ─────────────────────────────────────────────

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.js$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

// The destination noun: the first argument of a navigation call, or the
// second of runManagedVoiceNavigation(styleManager, noun, …) in gevActions.js.
// `runNavigation(fly)` layer seams take only the flight (group 1).
const NOUN_ARGUMENT =
  /\b(?:(runNavigation)\s*\(|(?:runImmediateNavigation|_runExplicitNavigation|runOrientation|_beginDeferredNavigation|cockpitRefusal|navigation\??\.(?:run|begin))\s*\(|runManagedVoiceNavigation\s*\(\s*[\w.?]+\s*,)\s*([^,)]*)/g;
// Literal nouns elsewhere: a parameter default (`noun = 'location'`) or both
// branches of `const noun = … ? 'cyclone' : 'weather'`.
const NOUN_LITERAL =
  /\bnoun\s*=\s*'([^']+)'|\bconst noun\s*=\s*[^?;]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g;

function trackableKinds() {
  const source = readFileSync(join(SRC, 'voice/gevActions.js'), 'utf8');
  const block = source.match(/const TRACKABLE_FAMILIES = \[([\s\S]*?)\];/);
  assert.ok(block, 'TRACKABLE_FAMILIES is still in gevActions.js');
  return [...block[1].matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1]);
}

// Non-literal arguments: what each one can be. A wrapper's own `noun` (or all
// its arguments) passes on; its default is a NOUN_LITERAL. Anything else is a
// new dynamic noun: list its values here.
const DYNAMIC_NOUNS = new Map([
  ['family.kind', trackableKinds],
  [
    "detail?.kind || 'target'",
    () => [...Object.keys(WORLD_FOCUS_FRAMING), 'target'],
  ],
  ['noun', () => []],
  ['...args', () => []],
  ['...arguments', () => []],
]);

function collectNouns() {
  const nouns = new Set();
  const unknown = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const [, seam, raw] of text.matchAll(NOUN_ARGUMENT)) {
      const arg = raw.trim();
      const literal = arg.match(/^'([^']*)'$/)?.[1];
      if (literal) nouns.add(literal);
      else if (DYNAMIC_NOUNS.has(arg))
        DYNAMIC_NOUNS.get(arg)().forEach((noun) => nouns.add(noun));
      else if (!seam && !/^noun\s*=/.test(arg))
        unknown.push(`${relative(SRC, file)}: ${arg}`);
    }
    for (const m of text.matchAll(NOUN_LITERAL))
      m.slice(1).forEach((noun) => noun && nouns.add(noun));
  }
  return { nouns, unknown };
}

test('every noun the callers pass has its own Cockpit refusal', () => {
  const { nouns, unknown } = collectNouns();
  assert.deepEqual(unknown, [], 'a new dynamic noun: add it to DYNAMIC_NOUNS');
  // The scan still sees the known callers (a guard against a broken regex).
  for (const noun of [
    'location',
    'camera',
    'photo',
    'shared view',
    'file',
    'scene',
    'route',
    'weather',
    'cyclone',
    'vessel',
    'fire',
    'frame',
    'aircraft',
    'satellite',
    'target',
  ])
    assert.ok(nouns.has(noun), `found ${noun}`);
  const missing = [...nouns].filter(
    (noun) => !COCKPIT_REFUSAL_NOUNS.includes(noun),
  );
  assert.deepEqual(missing, [], 'add these nouns to COCKPIT_REFUSALS');
});
