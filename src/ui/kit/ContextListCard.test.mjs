// src/ui/kit/ContextListCard.test.mjs — the kit's list card for Context:
// its head and bar, a page at a time with a range label that sets the page
// size, the caller's search, an item's detail in the list's place with Back,
// focus that never falls to the page, and its states, over happy-dom.
import '../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, reactive } from 'vue';
import ContextListCard, {
  groupSplit,
  resetListCardMemory,
} from './ContextListCard.vue';

const fruit = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i + 1}`,
    name: `Fruit ${i + 1}`,
    kind: ['apple', 'pear', 'apple', 'plum', 'fig', 'apple'][i % 6],
  }));

/** Mount a card with reactive props; returns them, the events and `$`. */
function mount(t, props = {}, { slots = {} } = {}) {
  resetListCardMemory();
  document.body.replaceChildren();
  // A panel body for the last focus fallback.
  const scroller = document.body.appendChild(document.createElement('div'));
  scroller.setAttribute('data-rail-scroller', '');
  scroller.tabIndex = -1;
  const host = scroller.appendChild(document.createElement('div'));
  const state = reactive({
    id: 'fruit',
    title: 'Fruit',
    icon: 'nutrition',
    toneText: 'Live',
    items: fruit(12),
    selected: null,
    shown: true,
    ...props,
  });
  const events = [];
  const app = createApp({
    render: () =>
      state.shown
        ? h(
            ContextListCard,
            {
              ...state,
              onSelect: (item) => {
                events.push(['select', item.id]);
                state.selected = item.id;
              },
              onBack: () => {
                events.push(['back']);
                state.selected = null;
              },
              onOrder: (keys) => events.push(['order', keys]),
              'onRow-pointer': (item) =>
                events.push(['pointer', item?.id ?? null]),
              'onRow-focus': (item) => events.push(['focus', item.id]),
              'onRow-blur': (item) => events.push(['blur', item?.id ?? null]),
            },
            {
              row: ({ item }) => h('span', { class: 'name' }, item.name),
              detail: ({ item }) => h('p', { class: 'detail' }, item.name),
              ...slots,
            },
          )
        : null,
  });
  app.mount(host);
  t.after(() => app.unmount());
  const $ = (selector) => document.querySelector(selector);
  const names = () =>
    [...document.querySelectorAll('[data-list-key] .name')].map(
      (name) => name.textContent,
    );
  const range = () => {
    const label = $('[data-list-range]');
    return label?.textContent;
  };
  return { state, events, $, names, range, scroller };
}
const settle = async () => {
  await nextTick();
  await nextTick();
};
const focused = (element) => document.activeElement === element;

test('the head is a layer block’s: feed dot, icon, title and how many, as a heading', async (t) => {
  const { $ } = mount(t);
  await settle();
  const head = $('h4.view-context__block-head');
  assert.equal(head.id, 'context-list-card-fruit');
  assert.equal($('section').getAttribute('aria-labelledby'), head.id);
  assert.ok(
    head.querySelector('.view-context__dot--nominal[aria-label="Live"]'),
  );
  assert.equal(
    head.querySelector('.material-symbols-outlined').textContent,
    'nutrition',
  );
  assert.equal(
    head.querySelector('.view-context__block-name').textContent,
    'Fruit',
  );
  assert.equal(head.querySelector('strong').textContent, '12');
});

test('groupBy draws the bar: the three largest groups named, the rest as Other, adding up', async (t) => {
  const { $, state } = mount(t, { groupBy: (item) => item.kind });
  await settle();
  const bar = $('.view-context__bar');
  assert.equal(bar.getAttribute('aria-hidden'), 'true', 'the legend says it');
  const legend = [
    ...document.querySelectorAll('.view-context__bar-key span'),
  ].map((part) => [part.textContent, part.dataset.tone]);
  assert.deepEqual(legend, [
    ['apple 6', '0'],
    ['pear 2', '1'],
    ['plum 2', '2'],
    ['Other 2', '4'],
  ]);
  assert.equal(
    legend.reduce((sum, [text]) => sum + Number(text.split(' ').at(-1)), 0),
    12,
  );
  assert.deepEqual(
    groupSplit(fruit(4), (item) => item.kind).map((part) => part.other),
    [false, false, false],
    'no Other with three groups or fewer',
  );

  state.groupBy = (item) => (item.kind === 'apple' ? 'Other' : item.kind);
  await settle();
  assert.deepEqual(
    [...document.querySelectorAll('.view-context__bar-key span')].map(
      (part) => part.textContent,
    ),
    ['Other 6', 'pear 2', 'plum 2', 'Remaining groups 2'],
  );
});

test('a page at a time: Next and Previous stop at either end', async (t) => {
  const { $, names, range } = mount(t);
  await settle();
  assert.deepEqual(names(), [
    'Fruit 1',
    'Fruit 2',
    'Fruit 3',
    'Fruit 4',
    'Fruit 5',
  ]);
  assert.equal(range(), '1–5 of 12');
  const previous = $('[data-list-previous]');
  const next = $('[data-list-next]');
  assert.equal(previous.getAttribute('aria-disabled'), 'true');
  previous.click();
  await settle();
  assert.equal(range(), '1–5 of 12');
  next.click();
  await settle();
  next.click();
  await settle();
  assert.equal(range(), '11–12 of 12');
  assert.equal(next.getAttribute('aria-disabled'), 'true');
  next.click();
  await settle();
  assert.equal(range(), '11–12 of 12');
  assert.equal($('nav').getAttribute('aria-label'), 'Pages');
});

test('the range label sets the page size, keeping the first item shown, and the card remembers it by id', async (t) => {
  const { $, names, range, state } = mount(t, { items: fruit(24) });
  await settle();
  const label = () => $('[data-list-size]');
  assert.equal(label().tagName, 'SELECT');
  assert.equal(
    label().getAttribute('aria-label'),
    'Fruit per page, showing 1–5 of 24',
  );
  $('[data-list-next]').click();
  await settle();
  $('[data-list-next]').click();
  await settle();
  assert.deepEqual(
    [...label().options].map((option) => [option.value, option.textContent]),
    [
      ['5', '5'],
      ['10', '10'],
      ['15', '15'],
    ],
  );
  label().value = '10';
  label().dispatchEvent(new Event('change'));
  await settle();
  assert.equal(range(), '11–20 of 24');
  assert.equal(names()[0], 'Fruit 11');
  assert.equal(names().length, 10);
  // Gone and back: the same page and size.
  state.shown = false;
  await settle();
  state.shown = true;
  await settle();
  assert.equal(range(), '11–20 of 24');
});

test('five or fewer: the range is plain text, with no Previous or Next', async (t) => {
  const { $, range } = mount(t, { items: fruit(4) });
  await settle();
  assert.equal($('[data-list-range]').tagName, 'SPAN');
  assert.equal(range(), '1–4 of 4');
  assert.equal($('[data-list-next]'), null);
});

test('page-size choices remain distinct when sizes cover the same rows', async (t) => {
  const { $ } = mount(t, { items: fruit(8) });
  await settle();
  const options = [...$('[data-list-size]').options];
  assert.deepEqual(
    options.map((option) => option.value),
    ['5', '10', '15'],
  );
  assert.notEqual(options[1].textContent, options[2].textContent);
});

test('sort and filter shape the list; a new query starts at page one; the order is reported', async (t) => {
  const { $, names, range, events, state } = mount(t, {
    sort: (items) => [...items].reverse(),
  });
  await settle();
  assert.equal(names()[0], 'Fruit 12');
  assert.deepEqual(events.find(([name]) => name === 'order')[1].slice(0, 3), [
    'f12',
    'f11',
    'f10',
  ]);
  $('[data-list-next]').click();
  await settle();
  state.filter = (item) => item.kind === 'apple';
  state.query = 'apple';
  await settle();
  assert.equal(range(), '1–5 of 6', 'page one of the matches');
  assert.equal($('h4 strong').textContent, '6');
  assert.deepEqual(events.at(-1), [
    'order',
    ['f12', 'f9', 'f7', 'f6', 'f3', 'f1'],
  ]);
});

test('a row selects; the detail shows in the list’s place, Back returns to the same page and row', async (t) => {
  const { $, events, range } = mount(t);
  await settle();
  $('[data-list-next]').click();
  await settle();
  const row = $('[data-list-key="f7"]');
  row.focus();
  row.click();
  await settle();
  assert.deepEqual(
    events.filter(([name]) => name === 'select'),
    [['select', 'f7']],
  );
  assert.equal($('.detail').textContent, 'Fruit 7');
  assert.equal($('[data-list-key]'), null, 'no rows meanwhile');
  const back = $('[data-list-back]');
  assert.equal(focused(back), true, 'focus moves to Back');
  back.click();
  await settle();
  assert.equal(range(), '6–10 of 12');
  assert.equal(focused($('[data-list-key="f7"]')), true, 'and back to the row');
});

test('Esc in the detail is the card’s: it goes back, and nothing else takes it', async (t) => {
  const { $, events, state } = mount(t, { selected: 'f2' });
  await settle();
  const detail = $('.context-list-card__detail');
  assert.equal(detail.hasAttribute('data-owns-escape'), true);
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  $('[data-list-back]').dispatchEvent(event);
  await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(events.filter(([name]) => name === 'back').length, 1);
  assert.equal(state.selected, null);
});

test('a pick made elsewhere leaves focus where it is; a click in the card moves it even unfocused', async (t) => {
  const { $, state } = mount(t);
  await settle();
  document.activeElement?.blur?.();
  assert.equal(document.activeElement, document.body);
  // A camera or mission picked on the globe, then let go there.
  state.selected = 'f2';
  await settle();
  assert.equal(document.activeElement, document.body, 'a pick elsewhere');
  state.selected = null;
  await settle();
  assert.equal(document.activeElement, document.body, 'a deselect elsewhere');
  // As in Safari, a click leaves the row unfocused; it still hands focus on.
  $('[data-list-key="f3"]').click();
  await settle();
  assert.equal(focused($('[data-list-back]')), true, 'focus moves to Back');
  $('[data-list-back]').click();
  await settle();
  assert.equal(focused($('[data-list-key="f3"]')), true, 'and back to the row');
});

test('Back restores the original row when detail advances beyond its page', async (t) => {
  const { $, state, range } = mount(t, {
    headerClose: true,
    returnRevision: 0,
  });
  $('[data-list-next]').click();
  await settle();
  const onPage = $('[data-list-key="f10"]');
  onPage.focus();
  onPage.click();
  await settle();

  state.selected = 'f11';
  await settle();
  assert.equal($('.detail').textContent, 'Fruit 11');
  assert.equal(focused($('[data-list-back]')), true);
  $('[data-list-back]').click();
  await settle();
  assert.equal(range(), '6–10 of 12');
  assert.equal(focused($('[data-list-key="f10"]')), true);
});

test('a focused row that leaves hands focus on: the same item, the row in its place, the last row, the panel', async (t) => {
  const { $, state, scroller } = mount(t, { items: fruit(7) });
  await settle();
  // Chromium blurs a focused node moved within the page.
  const insert = Node.prototype.insertBefore;
  let blurredOnMove = false;
  t.mock.method(Node.prototype, 'insertBefore', function (node, anchor) {
    const active = document.activeElement;
    if (node.isConnected && active && node.contains(active)) {
      blurredOnMove = true;
      active.blur();
    }
    return insert.call(this, node, anchor);
  });
  // The same item, moved.
  $('[data-list-key="f3"]').focus();
  state.items = [fruit(7)[2], ...fruit(7).filter((item) => item.id !== 'f3')];
  await settle();
  assert.equal(blurredOnMove, true, 'the moved node lost focus');
  assert.equal(focused($('[data-list-key="f3"]')), true);
  // The row in its place.
  $('[data-list-key="f3"]').focus();
  state.items = fruit(7).filter((item) => item.id !== 'f3');
  await settle();
  assert.equal(focused($('[data-list-index="0"]')), true);
  // A pager button that goes: the last row.
  $('[data-list-next]').focus();
  state.items = fruit(4);
  await settle();
  assert.equal(focused($('[data-list-index="3"]')), true);
  // The card going: the panel's body.
  state.shown = false;
  await settle();
  assert.equal(focused(scroller), true);
});

test('row events for a preview: pointer, focus and blur with the next row', async (t) => {
  const { $, events, state } = mount(t, { items: fruit(3) });
  await settle();
  const [a, b] = document.querySelectorAll('[data-list-key]');
  a.dispatchEvent(new MouseEvent('mouseenter'));
  a.dispatchEvent(new MouseEvent('mousemove'));
  a.dispatchEvent(new MouseEvent('mouseleave'));
  a.focus();
  b.focus();
  const rowEvents = events.filter(([name]) => name !== 'order');
  assert.deepEqual(rowEvents, [
    ['pointer', 'f1'],
    ['pointer', null],
    ['focus', 'f1'],
    ['blur', 'f2'],
    ['focus', 'f2'],
  ]);
  // After the rows change, the next movement over a row reports it once.
  events.length = 0;
  state.items = fruit(3).reverse();
  await settle();
  const row = $('[data-list-key="f1"]');
  row.dispatchEvent(new MouseEvent('mousemove'));
  row.dispatchEvent(new MouseEvent('mousemove'));
  assert.deepEqual(
    events.filter(([name]) => name === 'pointer'),
    [['pointer', 'f1']],
  );
});

test('states: loading, failed, empty and no matches, each its slot or default', async (t) => {
  const { $, state } = mount(
    t,
    { state: 'loading' },
    {
      slots: {
        empty: () => 'No fruit today',
        'no-matches': () => 'No fruit matches',
      },
    },
  );
  await settle();
  const text = () => $('.context-list-card__state')?.textContent;
  assert.equal(text(), 'Loading');
  assert.equal($('h4 strong'), null, 'no count while loading');
  state.state = 'failed';
  await settle();
  assert.equal(text(), 'Unavailable');
  state.state = 'empty';
  state.items = [];
  await settle();
  assert.equal(text(), 'No fruit today');
  state.state = 'ready';
  state.items = fruit(5);
  state.filter = () => false;
  await settle();
  assert.equal(text(), 'No fruit matches');
  assert.equal($('[data-list-key]'), null);
});

test('the filter slot sits above the list; rows with their own controls get select', async (t) => {
  const { $, events } = mount(
    t,
    { rowButton: false },
    {
      slots: {
        filter: () => h('div', { class: 'filters' }, 'Filters'),
        row: ({ item, select }) =>
          h('a', { class: 'name', href: '#', onClick: select }, item.name),
      },
    },
  );
  await settle();
  const filters = $('.filters');
  const list = $('.nearby-lists__layer');
  assert.ok(
    filters.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal($('[data-list-key="f1"]').tagName, 'DIV', 'no wrapping button');
  $('[data-list-key="f1"] .name').click();
  assert.deepEqual(
    events.find((e) => e[0] === 'select'),
    ['select', 'f1'],
  );
});
