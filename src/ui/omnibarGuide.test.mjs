// The guided walk's callout, rendered by startGuide() over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, onMounted } from 'vue';
import { startGuide } from './omnibarGuide.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const $ = (selector) => document.querySelector(selector);

function fixture(t) {
  document.body.replaceChildren();
  const target = document.body.appendChild(document.createElement('button'));
  const field = document.body.appendChild(document.createElement('input'));
  field.focus();
  t.after(() => $('.gev-guide-close')?.click());
  return { target, field };
}

test('the walk is the last of the body, takes focus and gives it back', async (t) => {
  const { target, field } = fixture(t);
  startGuide([{ targets: () => [target], text: () => 'Press it' }], {
    title: 'Flights',
  });
  await settle();
  const guide = $('.gev-guide');
  assert.equal(document.body.lastElementChild, guide);
  assert.equal(guide.parentElement, document.body);
  assert.ok(guide.classList.contains('visible'));
  const callout = $('.gev-guide-callout');
  assert.equal(document.activeElement, callout);
  assert.equal(callout.getAttribute('role'), 'dialog');
  assert.equal(callout.getAttribute('aria-modal'), 'false');
  assert.equal(callout.getAttribute('tabindex'), '-1');
  assert.equal($('.gev-guide-title').textContent, 'Guide · Flights');
  const close = $('.gev-guide-close');
  assert.equal(close.getAttribute('type'), 'button');
  assert.equal(close.getAttribute('aria-label'), 'End guide');
  assert.equal(close.getAttribute('title'), 'End guide');
  assert.ok(close.classList.contains('ui-close-button'));
  close.focus();
  close.click();
  assert.equal($('.gev-guide'), null);
  assert.equal(document.activeElement, field);
});

test('the status line says each step once, and each step draws new progress', async (t) => {
  const { target } = fixture(t);
  startGuide([
    { targets: () => [target], text: () => 'Press it' },
    { text: () => 'Then this' },
    {
      text: () => 'More?',
      offer: { label: () => 'Show more', steps: () => [] },
    },
  ]);
  const status = $('.gev-guide-status');
  const said = [];
  // One change per step: its text replaced once, never cleared first.
  const observer = new MutationObserver(() => said.push(status.textContent));
  observer.observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  t.after(() => observer.disconnect());
  await settle();
  const firstDots = [...document.querySelectorAll('.gev-guide-progress li')];
  assert.deepEqual(
    firstDots.map((dot) => dot.getAttribute('class')),
    ['current', null, null],
  );
  const next = $('.gev-guide-next');
  assert.equal(next.textContent, 'Skip step');
  assert.ok(next.classList.contains('quiet'));
  assert.equal($('.gev-guide-hint').hidden, false);
  next.click();
  await settle();
  const secondDots = [...document.querySelectorAll('.gev-guide-progress li')];
  assert.deepEqual(
    secondDots.map((dot) => dot.getAttribute('class')),
    ['done', 'current', null],
  );
  assert.ok(secondDots.every((dot) => !firstDots.includes(dot)));
  assert.equal(next.textContent, 'Next');
  assert.equal(next.classList.contains('quiet'), false);
  assert.equal($('.gev-guide-hint').hidden, true);
  next.click();
  await settle();
  // The closing offer: its two buttons, no Esc hint and no Next.
  assert.equal($('.gev-guide-keys').hidden, true);
  assert.equal(next.hidden, true);
  assert.equal($('.gev-guide-skip').hidden, false);
  assert.equal($('.gev-guide-skip').textContent, 'Not now');
  assert.equal($('.gev-guide-offer').textContent, 'Show more');
  assert.deepEqual(said, [
    '1 / 3: Press it',
    '2 / 3: Then this',
    '3 / 3: More?',
  ]);
  $('.gev-guide-skip').click();
  assert.equal($('.gev-guide'), null);
});

test('starting another walk ends the one in progress', async (t) => {
  fixture(t);
  startGuide([{ text: () => 'First' }]);
  startGuide([{ text: () => 'Second' }]);
  await settle();
  assert.equal(document.querySelectorAll('.gev-guide').length, 1);
  assert.equal($('.gev-guide-text').textContent, 'Second');
});

test('a walk started while Vue mounts something else still starts and ends', async (t) => {
  const { target, field } = fixture(t);
  let stop = null;
  const app = createApp({
    setup() {
      onMounted(() => {
        stop = startGuide([
          { targets: () => [target], text: () => 'Press it' },
        ]);
      });
      return () => h('span');
    },
  });
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  await settle();
  assert.equal(typeof stop, 'function');
  assert.equal(document.activeElement, $('.gev-guide-callout'));
  assert.ok($('.gev-guide').classList.contains('visible'));
  stop();
  assert.equal($('.gev-guide'), null);
  assert.equal(document.activeElement, field);
});

test('each further target of a step gets its own ring after the callout', async (t) => {
  const { target } = fixture(t);
  const more = document.body.appendChild(document.createElement('button'));
  const box = (left) => () => ({
    left,
    top: 20,
    right: left + 30,
    bottom: 50,
    width: 30,
    height: 30,
  });
  target.getBoundingClientRect = box(10);
  more.getBoundingClientRect = box(100);
  let targets = [target, more];
  startGuide([{ targets: () => targets, text: () => 'Press these' }]);
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  await settle();
  await frame();
  const subs = () => [...document.querySelectorAll('.gev-guide-ring--sub')];
  assert.equal(subs().length, 1);
  const [sub] = subs();
  assert.equal(sub.className, 'gev-guide-ring gev-guide-ring--sub');
  assert.equal(sub.parentElement, $('.gev-guide'));
  assert.equal(sub.previousElementSibling, $('.gev-guide-callout'));
  assert.equal(sub.childElementCount, 0);
  assert.equal(sub.style.opacity, '1');
  assert.equal(sub.style.left, '96px');
  assert.equal(sub.style.width, '38px');
  // A step with fewer targets keeps the ring, faded out.
  targets = [target];
  $('.gev-guide-ring').dispatchEvent(new Event('scroll', { bubbles: true }));
  await frame();
  assert.deepEqual(subs(), [sub]);
  assert.equal(sub.style.opacity, '0');
});
