// src/ui/pageRootClasses.test.mjs — the classes on <html> that stylesheets
// select on in place of `body:has(...)` (src/ui/rail/rootClass.js) are on
// exactly while the state each names holds, and every such rule still weighs
// what the `:has()` it replaced did.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, h, nextTick, shallowRef, withDirectives } from 'vue';
import { createPinia } from 'pinia';
import { holdRootClass, vRootClass } from './rail/rootClass.js';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
import { worldClock } from '../time/worldClock.js';
import { useFirstRunStore } from './stores/firstRun.js';
import { useHudStore } from './stores/hud.js';
import { useWorldTimeStore } from './stores/worldTime.js';
import CommandDockView from './views/CommandDockView.vue';
import IntelHudView from './views/IntelHudView.vue';
import LayerPanelsView from './views/LayerPanelsView.vue';
import StoriesView from './views/StoriesView.vue';
import WelcomeView from './views/WelcomeView.vue';
import LocalePicker from './views/panels/LocalePicker.vue';
import Omnibar from './views/panels/Omnibar.vue';
import WorldTimeline from './views/panels/WorldTimeline.vue';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const on = (name) => document.documentElement.classList.contains(name);
const settle = async () => {
  await nextTick();
  await nextTick();
};

/** Mount `component` into a fresh body; unmounted after the test. */
function mount(t, component, props, pinia = createPinia()) {
  document.body.replaceChildren();
  const app = createApp(component, props).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  let mounted = true;
  const unmount = () => {
    if (mounted) app.unmount();
    mounted = false;
  };
  t.after(unmount);
  return { pinia, unmount };
}

test('a held class stays until its last holder lets go', () => {
  const first = holdRootClass(document, 'test-held');
  const second = holdRootClass(document, 'test-held');
  assert.ok(on('test-held'));
  first();
  first();
  assert.ok(on('test-held'), 'a second release of one hold changes nothing');
  second();
  assert.ok(!on('test-held'));
});

test('v-root-class: mounted, updated, swapped and unmounted', async (t) => {
  const shown = shallowRef(true);
  const lit = shallowRef(false);
  const key = shallowRef(1);
  const seen = [];
  mount(t, {
    render: () =>
      shown.value
        ? withDirectives(
            h('div', {
              key: key.value,
              onVnodeMounted: () => seen.push(on('test-present')),
            }),
            [[vRootClass, { 'test-present': true, 'test-lit': lit.value }]],
          )
        : null,
  });
  assert.ok(on('test-present'));
  assert.deepEqual(seen, [true], 'on before the element is mounted');
  assert.ok(!on('test-lit'));
  lit.value = true;
  await settle();
  assert.ok(on('test-lit'));
  key.value = 2;
  await settle();
  assert.ok(on('test-present') && on('test-lit'), 'a keyed swap keeps both');
  lit.value = false;
  await settle();
  assert.ok(!on('test-lit'));
  shown.value = false;
  await settle();
  assert.ok(!on('test-present') && !on('test-lit'));
});

test('the Omnibar holds has-omnibar, its results and focus inside it', async (t) => {
  const { unmount } = mount(t, Omnibar);
  await settle();
  assert.ok(on('has-omnibar'));
  assert.ok(!on('omnibar-focus-within'));
  const root = document.getElementById('gev-omnibar');
  // happy-dom does not track :focus-within; a browser answers it from focus.
  root.matches = (selector) =>
    selector === ':focus-within'
      ? root.contains(document.activeElement)
      : Element.prototype.matches.call(root, selector);
  const input = document.getElementById('gev-omnibar-input');
  input.focus();
  await settle();
  assert.ok(on('omnibar-focus-within'));
  assert.equal(
    on('omnibar-has-results'),
    root.classList.contains('has-results'),
  );
  const outside = document.body.appendChild(document.createElement('button'));
  outside.focus();
  await settle();
  assert.ok(!on('omnibar-focus-within'));
  assert.equal(
    on('omnibar-has-results'),
    root.classList.contains('has-results'),
  );
  unmount();
  assert.ok(!on('has-omnibar') && !on('omnibar-has-results'));
});

test('the dock holds dock-has-voice and assistant-voice-mode with its voice control', async (t) => {
  const { pinia, unmount } = mount(t, CommandDockView);
  await settle();
  assertSameNode(
    document.querySelector('#command-dock > #gev-voice-control'),
    null,
  );
  assert.ok(!on('dock-has-voice'));
  const ui = createTestVoiceUi({ pinia });
  await settle();
  assert.ok(document.querySelector('#command-dock > #gev-voice-control'));
  assert.ok(on('dock-has-voice'));
  assert.ok(!on('assistant-voice-mode'));
  ui.replace('root', { ...ui.state.root, assistantMode: 'voice' });
  await settle();
  assert.equal(
    document.getElementById('gev-voice-control').dataset.assistantMode,
    'voice',
  );
  assert.ok(on('assistant-voice-mode'));
  ui.replace('root', { ...ui.state.root, assistantMode: 'chat' });
  await settle();
  assert.ok(!on('assistant-voice-mode'));
  ui.replace('root', { ...ui.state.root, assistantMode: 'voice' });
  await settle();
  unmount();
  assert.ok(!on('dock-has-voice') && !on('assistant-voice-mode'));
});

test('the HUD holds hud-minimal-active only while the Minimal HUD is active', async (t) => {
  const { pinia, unmount } = mount(t, IntelHudView);
  const store = useHudStore(pinia);
  const cases = [
    [{ active: false, variant: 'minimal' }, false],
    [{ active: true, variant: 'tactical' }, false],
    [{ active: true, variant: 'minimal' }, true],
    [{ active: false, variant: 'minimal' }, false],
    [{ active: true, variant: 'minimal' }, true],
  ];
  for (const [hud, expected] of cases) {
    store.publish({ vessel: {}, sensor: [], recShown: null, ...hud });
    await settle();
    const el = document.getElementById('intel-hud');
    assert.equal(
      el.classList.contains('active') && el.dataset.variant === 'minimal',
      expected,
    );
    assert.equal(on('hud-minimal-active'), expected, JSON.stringify(hud));
  }
  unmount();
  assert.ok(!on('hud-minimal-active'));
});

test('launcher-shown is on while the first-run launcher is on the page', async (t) => {
  const { pinia } = mount(t, WelcomeView);
  const store = useFirstRunStore(pinia);
  await settle();
  assert.ok(document.getElementById('first-run-launcher'));
  assert.ok(on('launcher-shown'), 'drawn hidden before it is presented');
  store.publish({ removed: false, shown: true, visible: true });
  await settle();
  assert.ok(on('launcher-shown'));
  store.publish({ removed: true });
  await settle();
  assertSameNode(document.getElementById('first-run-launcher'), null);
  assert.ok(!on('launcher-shown'));
});

test('a launcher removed outside the welcome view clears launcher-shown', async (t) => {
  mount(t, WelcomeView);
  await settle();
  assert.ok(on('launcher-shown'));
  // As a page clearing the first-run dialog by hand does: `body:has()` stopped
  // matching, so the class goes too.
  document.getElementById('first-run-launcher').remove();
  await settle();
  assert.ok(!on('launcher-shown'));
});

test('the World Timeline holds has-world-timeline while it is drawn', async (t) => {
  const { pinia } = mount(t, WorldTimeline);
  t.after(() => {
    useWorldTimeStore(pinia).$dispose();
    worldClock.goLive();
    worldClock.setRate(1);
  });
  await settle();
  assertSameNode(document.getElementById('world-timeline'), null);
  assert.ok(!on('has-world-timeline'));
  const at = Date.now();
  const release = worldClock.hold('test-root-class');
  const unregister = worldClock.register({
    id: 'test-root-class',
    coverage: () => ({ start: at - 3_600_000, end: at }),
  });
  await settle();
  assert.ok(document.getElementById('world-timeline'));
  assert.ok(on('has-world-timeline'));
  unregister();
  release();
  await settle();
  assertSameNode(document.getElementById('world-timeline'), null);
  assert.ok(!on('has-world-timeline'));
});

test('the language picker holds has-locale-picker while it is drawn', (t) => {
  const { unmount } = mount(t, LocalePicker, {
    current: 'en',
    onSelect: () => {},
  });
  assert.ok(document.getElementById('locale-picker'));
  assert.ok(on('has-locale-picker'));
  unmount();
  assert.ok(!on('has-locale-picker'));
});

test('the panel stack holds left-panel-open while a panel directly in it is open', async (t) => {
  const { unmount } = mount(t, LayerPanelsView);
  await settle();
  const stack = document.getElementById('left-panel-stack');
  const open = () =>
    [...stack.children].some((child) =>
      child.matches('.panel-collapsible:not(.collapsed)'),
    );
  const check = async (message) => {
    await settle();
    assert.equal(on('left-panel-open'), open(), message);
  };
  for (const panel of stack.querySelectorAll(':scope > .panel-collapsible'))
    panel.classList.add('collapsed');
  await check('every panel closed');
  assert.ok(!on('left-panel-open'));
  const data = document.getElementById('data-panel');
  data.classList.remove('collapsed');
  await check('a panel opened');
  assert.ok(on('left-panel-open'));
  data.classList.add('collapsed');
  await check('closed again');
  // Panels move in and out of the stack at run time.
  const moved = document.createElement('div');
  moved.className = 'panel-collapsible';
  stack.append(moved);
  await check('an open panel moved in');
  assert.ok(on('left-panel-open'));
  moved.classList.add('collapsed');
  await check('the moved panel closed');
  moved.classList.remove('collapsed');
  await check('and opened');
  document.body.append(moved);
  await check('moved out again');
  assert.ok(!on('left-panel-open'));
  // A deeper open panel is not one of the stack's own.
  const nested = data.appendChild(document.createElement('div'));
  nested.className = 'panel-collapsible';
  await check('a nested panel does not count');
  assert.ok(!on('left-panel-open'));
  data.classList.remove('collapsed');
  await check('opened before the stack goes');
  unmount();
  assert.ok(!on('left-panel-open'));
});

test('Stories holds loading-screen-shown while the loading screen shows', async (t) => {
  document.body.replaceChildren();
  const cover = document.body.appendChild(document.createElement('div'));
  cover.id = 'loading-screen';
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(StoriesView).use(createPinia());
  app.mount(host);
  t.after(() => localStorage.removeItem('gevStoriesPopSeen'));
  await settle();
  assert.ok(on('loading-screen-shown'));
  cover.classList.add('hidden');
  await settle();
  assert.ok(!on('loading-screen-shown'));
  cover.classList.remove('hidden');
  await settle();
  assert.ok(on('loading-screen-shown'));
  app.unmount();
  assert.ok(!on('loading-screen-shown'));
  document.body.replaceChildren();
});

test('Stories without a loading screen holds no class', async (t) => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(StoriesView).use(createPinia());
  app.mount(host);
  t.after(() => {
    app.unmount();
    localStorage.removeItem('gevStoriesPopSeen');
  });
  await settle();
  assert.ok(!on('loading-screen-shown'));
});

/** Whether `body:has(#loading-screen:not(.hidden))` holds. */
const loadingShown = () =>
  Boolean(document.body.querySelector('#loading-screen:not(.hidden)'));

test('Stories follows a loading screen removed, added later, nested or renamed', async (t) => {
  document.body.replaceChildren();
  const cover = document.body.appendChild(document.createElement('div'));
  cover.id = 'loading-screen';
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(StoriesView).use(createPinia());
  app.mount(host);
  t.after(() => {
    app.unmount();
    localStorage.removeItem('gevStoriesPopSeen');
    document.body.replaceChildren();
  });
  const agree = async (message) => {
    await settle();
    assert.equal(on('loading-screen-shown'), loadingShown(), message);
  };
  await agree('shown');
  assert.ok(on('loading-screen-shown'));
  cover.remove();
  await agree('a shown loading screen removed');
  assert.ok(!on('loading-screen-shown'));
  const wrap = document.body.appendChild(document.createElement('section'));
  const late = document.createElement('div');
  late.id = 'loading-screen';
  late.className = 'hidden';
  wrap.append(late);
  await agree('a hidden one added later, inside another element');
  late.classList.remove('hidden');
  await agree('the later one shown');
  assert.ok(on('loading-screen-shown'));
  late.id = 'cover';
  await agree('renamed away');
  late.id = 'loading-screen';
  await agree('renamed back');
  const second = document.body.appendChild(document.createElement('div'));
  second.id = 'loading-screen';
  second.className = 'hidden';
  late.classList.add('hidden');
  await agree('two, both hidden');
  second.classList.remove('hidden');
  await agree('the second one shown');
  assert.ok(on('loading-screen-shown'));
  wrap.remove();
  second.remove();
  await agree('both gone');
  assert.ok(!on('loading-screen-shown'));
});

test('Stories mounted before the loading screen follows it once it is added', async (t) => {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(StoriesView).use(createPinia());
  app.mount(host);
  t.after(() => {
    app.unmount();
    localStorage.removeItem('gevStoriesPopSeen');
    document.body.replaceChildren();
  });
  await settle();
  assert.ok(!on('loading-screen-shown'));
  const cover = document.body.appendChild(document.createElement('div'));
  cover.id = 'loading-screen';
  await settle();
  assert.ok(on('loading-screen-shown'));
  cover.classList.add('hidden');
  await settle();
  assert.ok(!on('loading-screen-shown'));
});

// ── The stylesheets ─────────────────────────────────────────────────────────

const STYLESHEETS = [
  'style.css',
  ...fs
    .readdirSync(path.join(ROOT, 'src/ui/styles'))
    .filter((name) => name.endsWith('.css'))
    .map((name) => `src/ui/styles/${name}`),
];
const SFC_STYLES = fs
  .readdirSync(path.join(ROOT, 'src/ui/views/panels'))
  .filter((name) => name.endsWith('.vue'))
  .map((name) => `src/ui/views/panels/${name}`);

/** Every selector of `css`, comments removed and whitespace collapsed. */
function selectors(css) {
  const out = [];
  for (const match of css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{};]+)\{/g)) {
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (text && !text.startsWith('@')) out.push(text);
  }
  return out;
}

// The class each state stands for, and the condition it replaced.
const ROOT_CLASSES = Object.freeze({
  'hud-minimal-active': "#intel-hud[data-variant='minimal'].active",
  'omnibar-focus-within': '#gev-omnibar:focus-within',
  'omnibar-has-results': '#gev-omnibar.has-results',
  'assistant-voice-mode': "#gev-voice-control[data-assistant-mode='voice']",
  'left-panel-open': '#left-panel-stack > .panel-collapsible:not(.collapsed)',
  'launcher-shown': '#first-run-launcher',
  'loading-screen-shown': '#loading-screen:not(.hidden)',
  'has-world-timeline': '#world-timeline',
  'has-locale-picker': '#locale-picker',
  'has-omnibar': '#gev-omnibar',
});

/** The compound selectors of `selector`, split at combinators and commas outside parentheses. */
function compounds(selector) {
  const out = [''];
  let depth = 0;
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (depth === 0 && /[\s>+~,]/.test(char)) {
      if (out[out.length - 1]) out.push('');
    } else out[out.length - 1] += char;
  }
  return out.filter(Boolean);
}

/**
 * The `[class, condition]` of every `:is(.class *, condition)` and
 * `:not(.class *, condition)` in `selector`.
 */
function rootClassArguments(selector) {
  const out = [];
  for (const match of selector.matchAll(/:(?:is|not)\(/g)) {
    let depth = 0;
    let end = -1;
    const args = [''];
    for (
      let i = match.index + match[0].length - 1;
      i < selector.length;
      i += 1
    ) {
      const char = selector[i];
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
      if (char === ',' && depth === 1) args.push('');
      else if (!(char === '(' && depth === 1)) args[args.length - 1] += char;
    }
    assert.ok(end > 0, `unbalanced: ${selector}`);
    const name = args[0].trim().match(/^\.([\w-]+) \*$/)?.[1];
    if (name) {
      assert.equal(args.length, 2, selector);
      out.push([name, args[1].trim()]);
    }
  }
  return out;
}

test('no rule hangs a :has() on body, and every root class keeps its weight', () => {
  const seen = new Set();
  for (const file of [...STYLESHEETS, ...SFC_STYLES]) {
    const css = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const selector of selectors(css)) {
      // A :has() on the page's root, its body, or a rule nested in one.
      for (const compound of compounds(selector))
        assert.ok(
          !/^(body|html|:root|&)(?![\w-])/.test(compound) ||
            !compound.includes(':has('),
          `${file}: ${selector}`,
        );
      // A root class is selected with the condition it stands for beside
      // it, which never matches body and keeps the rule's specificity.
      for (const [name, condition] of rootClassArguments(selector)) {
        assert.ok(
          Object.hasOwn(ROOT_CLASSES, name),
          `${file}: unknown class .${name}`,
        );
        assert.equal(condition, ROOT_CLASSES[name], `${file}: ${selector}`);
        seen.add(name);
      }
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    Object.keys(ROOT_CLASSES).sort(),
    'every root class is selected somewhere',
  );
});
