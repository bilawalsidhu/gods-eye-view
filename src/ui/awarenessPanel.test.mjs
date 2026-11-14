// src/ui/awarenessPanel.test.mjs — the Contacts panel renders what the
// Contacts layer publishes (`subscribePanel()`), over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useContextStore } from './stores/context.js';
import AwarenessPanel from './views/panels/AwarenessPanel.vue';

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(AwarenessPanel).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const store = useContextStore(pinia);
  const calls = [];
  store.connectAwareness({
    navigatePrevious: (options) => calls.push(['previous', options]),
    focusCurrent: (options) => calls.push(['focus', options]),
    navigateNext: (options) => calls.push(['next', options]),
    focusTarget: (layer, id, options) =>
      calls.push([`target:${layer}:${id}`, options]),
  });
  const panel = () => document.getElementById('military-awareness-panel');
  const publish = async (view) => {
    store.publishAwareness(view);
    await nextTick();
  };
  return { panel, publish, calls };
}

const target = (layer, id, label, extra = {}) => ({
  key: `target:${layer}:${id}`,
  layer,
  targetId: id,
  label,
  distance: '4.6 km',
  ariaLabel: `Focus ${label}`,
  names: null,
  ...extra,
});

const results = ({ nearest = [], previousDisabled = true } = {}) => ({
  kind: 'results',
  subject: 'N123AB · 250 km FLIGHT / VESSEL WINDOW',
  subjectNames: null,
  navigation: {
    label: 'Global Context navigation',
    previous: {
      text: 'PREVIOUS',
      title: 'Previous',
      disabled: previousDisabled,
    },
    focus: { text: 'FOCUS' },
    next: { text: 'NEXT', title: 'Next', disabled: false },
  },
  rows: [
    {
      id: 'flights',
      relationship: 'observed',
      label: 'Flights',
      count: '2',
      detail: 'ADS-B · CURRENT VIEWPORT ONLY · nearest',
      nearest,
    },
  ],
  note: 'Open-source mapped/observed context.',
});

test('before the layer publishes, the panel shows its initial markup', (t) => {
  const { panel } = fixture(t);
  const standby = panel().querySelector('.military-awareness-standby');
  assert.equal(
    standby.querySelector('strong').textContent,
    'CONTACTS CONTEXT OFF',
  );
  // Rendered through t(), so a later null view is translated too.
  assert.equal(
    standby.querySelector('strong').hasAttribute('data-i18n'),
    false,
  );
});

test('a standby view replaces the initial copy', async (t) => {
  const { panel, publish } = fixture(t);
  await publish({
    kind: 'standby',
    title: 'CONTEXT READY',
    text: 'SELECT A FLIGHT',
  });
  const standby = panel().querySelector('.military-awareness-standby');
  assert.equal(standby.querySelector('strong').textContent, 'CONTEXT READY');
  assert.equal(standby.querySelector('span').textContent, 'SELECT A FLIGHT');
  await publish({ kind: 'empty' });
  assert.equal(panel().children.length, 0);
});

test('results render the rows, controls and names as text, and buttons call the layer', async (t) => {
  const { panel, publish, calls } = fixture(t);
  const view = results({
    nearest: [
      target('flights', 'abc123', 'ALPHA', {
        names: {
          summary: 'Named areas (2)',
          names: ['Area one', '<Area two>'],
        },
      }),
      {
        key: 'unavailable:1',
        label: '—',
        distance: '9 km',
        ariaLabel: 'Unavailable',
      },
    ],
  });
  await publish(view);
  const root = panel();
  assert.equal(
    root.querySelector('.military-awareness-subject').textContent,
    view.subject,
  );
  const row = root.querySelector('.military-awareness-row');
  assert.equal(row.className, 'military-awareness-row observed');
  assert.equal(row.querySelector('b').getAttribute('aria-live'), 'polite');
  assert.equal(row.querySelector('b').textContent, '2');
  assert.equal(row.querySelector('small').textContent, view.rows[0].detail);
  const alpha = row.querySelector('button[data-awareness-id="abc123"]');
  assert.equal(alpha.dataset.awarenessLayer, 'flights');
  assert.equal(alpha.getAttribute('aria-label'), 'Focus ALPHA');
  assert.equal(alpha.textContent, 'ALPHA 4.6 km');
  const names = row.querySelector('.military-awareness-names div');
  assert.equal(
    names.innerHTML.replace(/<!--[^>]*-->/g, ''),
    'Area one<br>&lt;Area two&gt;',
  );
  const unavailable = row.querySelector(
    'span.military-awareness-target.unavailable',
  );
  assert.equal(unavailable.getAttribute('aria-label'), 'Unavailable');

  const [previous, focus, next] = root.querySelectorAll(
    '[data-awareness-action]',
  );
  assert.equal(previous.disabled, true);
  assert.equal(next.title, 'Next');
  focus.click();
  next.click();
  alpha.click();
  const user = { origin: 'user' };
  assert.deepEqual(calls, [
    ['focus', user],
    ['next', user],
    ['target:flights:abc123', user],
  ]);
  const note = root.querySelector('[data-awareness-focus-continuation]');
  assert.equal(note.tagName, 'P');
  assert.equal(note.getAttribute('tabindex'), '-1');
});

test('a live repaint keeps a focused contact by identity and never retargets another', async (t) => {
  const { panel, publish } = fixture(t);
  const alpha = target('flights', 'abc123', 'ALPHA');
  const bravo = target('flights', 'def456', 'BRAVO');
  await publish(results({ nearest: [alpha, bravo] }));
  const alphaButton = panel().querySelector('[data-awareness-id="abc123"]');
  alphaButton.focus();

  await publish(results({ nearest: [bravo, alpha] }));
  assert.equal(
    document.activeElement === alphaButton,
    true,
    'identity wins when rows reorder',
  );

  const charlie = target('ais-live-vessels', '789', 'CHARLIE');
  await publish(results({ nearest: [charlie] }));
  const note = panel().querySelector('[data-awareness-focus-continuation]');
  assert.equal(
    document.activeElement === note,
    true,
    'a departed contact continues at the note',
  );

  await publish(results({ nearest: [bravo] }));
  assert.equal(
    document.activeElement === note,
    true,
    'later repaints keep the continuation point',
  );
});

test('a reorder that drops focus from a moved contact restores the same contact', async (t) => {
  const { panel, publish } = fixture(t);
  const alpha = target('flights', 'abc123', 'ALPHA');
  const bravo = target('flights', 'def456', 'BRAVO');
  await publish(results({ nearest: [alpha, bravo] }));
  // Browsers drop focus from a node that is moved; happy-dom does not, so
  // moving the focused node sends focus outside the panel here.
  const sink = document.body.appendChild(document.createElement('button'));
  const list = panel().querySelector('ul');
  const insertBefore = list.insertBefore.bind(list);
  list.insertBefore = (node, ref) => {
    const moved = node.contains(document.activeElement);
    const result = insertBefore(node, ref);
    if (moved) sink.focus();
    return result;
  };
  const focusNode = (id) =>
    panel().querySelector(`[data-awareness-id="${id}"]`);
  focusNode('def456').focus();
  await publish(results({ nearest: [bravo, alpha] }));
  focusNode('abc123').focus();
  await publish(results({ nearest: [alpha, bravo] }));
  assert.equal(
    document.activeElement === focusNode('abc123'),
    true,
    'the same contact keeps focus, not another one or the note',
  );
});

test('a repaint that disables the focused control continues at the note', async (t) => {
  const { panel, publish } = fixture(t);
  await publish(results({ previousDisabled: false }));
  const previous = panel().querySelector('[data-awareness-action="previous"]');
  previous.focus();
  await publish(results({ previousDisabled: true }));
  assert.equal(previous.disabled, true);
  const note = panel().querySelector('[data-awareness-focus-continuation]');
  assert.equal(document.activeElement === note, true);
});

test('a repaint that leaves focus outside the panel does not pull it back', async (t) => {
  const { panel, publish } = fixture(t);
  const outside = document.body.appendChild(document.createElement('button'));
  await publish(results({ nearest: [target('flights', 'abc123', 'ALPHA')] }));
  outside.focus();
  await publish(results({ nearest: [] }));
  assert.equal(document.activeElement === outside, true);
  assert.equal(
    panel().querySelector('ul'),
    null,
    'an empty cohort renders no list',
  );
});

const photo = (extra = {}) => ({
  src: 'https://t.plnspttrs.net/1/abc123_280.jpg',
  width: 280,
  height: 186,
  link: 'https://www.planespotters.net/photo/1/n123ab',
  credit: 'Photo © Jane Doe',
  ...extra,
});

test('a tracked flight’s photo shows under its name, credited and linked to its page', async (t) => {
  const { panel, publish } = fixture(t);
  await publish({ ...results(), photo: photo() });
  const root = panel();
  const link = root.querySelector('a.military-awareness-photo');
  assert.ok(link, 'the photo renders');
  assert.equal(
    root.querySelector('.military-awareness-subject').nextElementSibling,
    link,
    'directly under the subject line',
  );
  assert.equal(link.getAttribute('href'), photo().link);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener');
  const img = link.querySelector('img');
  assert.equal(img.getAttribute('src'), photo().src);
  assert.equal(img.getAttribute('alt'), '');
  assert.equal(img.getAttribute('width'), '280');
  assert.equal(img.getAttribute('height'), '186');
  assert.equal(link.querySelector('small').textContent, 'Photo © Jane Doe');
});

test('no photo renders without one', async (t) => {
  const { panel, publish } = fixture(t);
  await publish({ ...results(), photo: null });
  assert.equal(panel().querySelector('.military-awareness-photo'), null);
});

test('a photo whose image fails to load is hidden until another arrives', async (t) => {
  const { panel, publish } = fixture(t);
  await publish({ ...results(), photo: photo() });
  panel()
    .querySelector('.military-awareness-photo img')
    .dispatchEvent(new Event('error'));
  await nextTick();
  assert.equal(panel().querySelector('.military-awareness-photo'), null);
  // A repaint with the same photo keeps it hidden.
  await publish({ ...results({ previousDisabled: false }), photo: photo() });
  assert.equal(panel().querySelector('.military-awareness-photo'), null);
  // Another plane's photo shows.
  const next = photo({ src: 'https://t.plnspttrs.net/2/def456_280.jpg' });
  await publish({ ...results(), photo: next });
  assert.equal(
    panel().querySelector('.military-awareness-photo img').getAttribute('src'),
    next.src,
  );
});

test('a late error from a previous photo’s image does not hide the current one', async (t) => {
  const { panel, publish } = fixture(t);
  const previous = photo();
  const current = photo({ src: 'https://t.plnspttrs.net/2/def456_280.jpg' });
  await publish({ ...results(), photo: current });
  // The error belongs to the image that failed: here, one still on the old src.
  const img = panel().querySelector('.military-awareness-photo img');
  img.setAttribute('src', previous.src);
  img.dispatchEvent(new Event('error'));
  await nextTick();
  assert.ok(panel().querySelector('.military-awareness-photo'));
});
