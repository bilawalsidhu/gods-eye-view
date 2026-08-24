/**
 * @vitest-environment jsdom
 */

/**
 * Tests for the search box against a real document.
 *
 * The rest of this suite runs in node, because nothing else under test needs a document: the
 * pure logic does not, and the modules that drive Cesium could not run in jsdom either
 * (no WebGL). This one file is the exception, and it is the exception for a reason.
 *
 * What is asserted here is the keyboard and the screen reader, which is to say the parts of a
 * typeahead that are not visible and therefore never noticed when they break. A combobox that
 * does not report its highlighted row through `aria-activedescendant` looks perfect and is
 * unusable without sight. `/` that fires while somebody is typing an address into another
 * field looks like nothing at all until it eats their keystroke. Neither can be proved by
 * calling a function with a plain object, and both are behaviour rather than paint.
 *
 * What is still not proved here: that any of it is legible, and that the list does not overlap
 * the globe. jsdom has no layout and no renderer, and nothing automated proves legibility: the
 * `e2e/smoke.spec.ts` axe pass reads the closed input, not the results list, because the list
 * is rendered hidden until there is something in it. That the camera actually moves *is*
 * proved, by "picking a city flies the camera there" in that suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchBox } from './search';
import type { SearchHit, SearchResponse } from '../types/entities';

const LONDON: SearchHit = {
  group: 'cities',
  entity_id: '2643743',
  label: 'London',
  detail: 'GB · population 8,961,989',
  point: { lon: -0.12574, lat: 51.50853, altitude_m: null },
  score: 0.9,
};

const ONTARIO: SearchHit = {
  ...LONDON,
  entity_id: '6058560',
  detail: 'CA · population 422,324',
  point: { lon: -81.23304, lat: 42.98339, altitude_m: null },
};

const RESPONSE: SearchResponse = {
  query: 'london',
  groups: [{ name: 'cities', hits: [LONDON, ONTARIO] }],
};

interface Harness {
  root: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  picked: SearchHit[];
  type: (value: string) => Promise<void>;
  press: (key: string, options?: KeyboardEventInit) => void;
  /** The pickable rows, in list order. Headings and notes are not among them. */
  hits: () => HTMLElement[];
}

/** For the two boxes below that are destroyed or fail before anything can be picked. */
function ignorePick(): void {
  // Nothing: these tests never reach a pick.
}

function mount(response: SearchResponse = RESPONSE): Harness {
  const root = document.createElement('div');
  document.body.append(root);
  const picked: SearchHit[] = [];
  new SearchBox(root, {
    // Zero, because the debounce itself is asserted in search.test.ts and a real one here
    // would only be a wait.
    debounceMs: 0,
    search: () => Promise.resolve(response),
    onPick: (hit) => {
      picked.push(hit);
    },
  });
  const input = root.querySelector<HTMLInputElement>('.search-input');
  const list = root.querySelector<HTMLElement>('.search-results');
  if (input === null || list === null) {
    throw new Error('the search box did not build its own template');
  }
  return {
    root,
    input,
    list,
    picked,
    type: async (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(1);
    },
    press: (key: string, options: KeyboardEventInit = {}) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));
    },
    hits: () => [...list.querySelectorAll<HTMLElement>('.search-hit')],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SearchBox markup', () => {
  it('builds a combobox wired to its own listbox', () => {
    const { input, list } = mount();

    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.hidden).toBe(true);
  });

  it('throws rather than half-working when its own template is wrong', () => {
    const root = document.createElement('div');
    // A root whose markup somebody has replaced. The class would otherwise carry two nulls
    // and fail on the first keystroke instead of at construction.
    Object.defineProperty(root, 'querySelector', { value: () => null });

    expect(() => {
      new SearchBox(root, { search: () => Promise.resolve(RESPONSE), onPick: ignorePick });
    }).toThrow('search template is missing');
  });
});

describe('SearchBox typeahead', () => {
  it('paints a heading and its hits, and opens the list', async () => {
    const box = mount();

    await box.type('london');

    expect(box.list.hidden).toBe(false);
    expect(box.input.getAttribute('aria-expanded')).toBe('true');
    expect([...box.list.children].map((node) => node.className)).toEqual([
      'search-group',
      'search-hit',
      'search-hit',
    ]);
    expect(box.list.textContent).toContain('GB · population 8,961,989');
    // A heading is not a result, so it is not an option and cannot be reached by the arrows.
    expect(box.list.querySelector('.search-group')?.getAttribute('role')).toBe('presentation');
    expect(box.hits()[0]?.getAttribute('role')).toBe('option');
  });

  it('closes the list again when the box is emptied', async () => {
    const box = mount();

    await box.type('london');
    await box.type('');

    expect(box.list.hidden).toBe(true);
    expect(box.list.children).toHaveLength(0);
    expect(box.input.getAttribute('aria-expanded')).toBe('false');
  });

  it('reports the highlighted row to a screen reader rather than moving focus', async () => {
    const box = mount();
    box.input.focus();

    await box.type('london');
    box.press('ArrowDown');

    const first = box.hits()[0];
    expect(box.input.getAttribute('aria-activedescendant')).toBe(first?.id);
    expect(first?.getAttribute('aria-selected')).toBe('true');
    // Focus stays in the input, or the typed text would stop being editable.
    expect(document.activeElement).toBe(box.input);
  });

  it('wraps the highlight and steps over the heading', async () => {
    const box = mount();

    await box.type('london');
    box.press('ArrowUp');

    // Up from nothing enters at the last result, not at the heading above the first.
    expect(box.input.getAttribute('aria-activedescendant')).toBe(box.hits()[1]?.id);

    box.press('ArrowDown');

    expect(box.input.getAttribute('aria-activedescendant')).toBe(box.hits()[0]?.id);
  });

  it('picks the highlighted hit on Enter and puts the list away', async () => {
    const box = mount();

    await box.type('london');
    box.press('ArrowDown');
    box.press('Enter');

    expect(box.picked).toEqual([LONDON]);
    expect(box.list.hidden).toBe(true);
    // The query stays: somebody flying between two results wants what they typed still there.
    expect(box.input.value).toBe('london');
  });

  it('does nothing on Enter with nothing highlighted', async () => {
    const box = mount();

    await box.type('london');
    box.press('Enter');

    expect(box.picked).toEqual([]);
    expect(box.list.hidden).toBe(false);
  });

  it('picks the row a click landed on, and ignores a click on a heading', async () => {
    const box = mount();

    await box.type('london');
    box.list
      .querySelector('.search-group')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(box.picked).toEqual([]);

    await box.type('london');
    box.hits()[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(box.picked).toEqual([ONTARIO]);
  });

  it('keeps focus on the press that starts a click, or the list would go first', async () => {
    const box = mount();
    await box.type('london');

    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    box.hits()[0]?.dispatchEvent(press);

    // Without this the input blurs, the list is emptied, and the click lands on nothing.
    expect(press.defaultPrevented).toBe(true);
  });

  it('closes the list on Escape and keeps the query', async () => {
    const box = mount();

    await box.type('london');
    box.press('Escape');

    expect(box.list.hidden).toBe(true);
    expect(box.input.value).toBe('london');
  });

  it('closes the list when the box loses focus', async () => {
    const box = mount();
    box.input.focus();
    await box.type('london');

    box.input.dispatchEvent(new FocusEvent('blur'));

    // Or a dropdown stays over the globe on top of whatever the next click was aiming at.
    expect(box.list.hidden).toBe(true);
  });

  it('says the request failed rather than showing an empty world', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    new SearchBox(root, {
      debounceMs: 0,
      search: () => Promise.reject(new Error('offline')),
      onPick: ignorePick,
    });
    const input = root.querySelector<HTMLInputElement>('.search-input');
    input!.value = 'london';
    input!.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(1);

    expect(root.querySelector('.search-note')?.textContent).toContain('did not complete');
  });
});

describe('SearchBox focus shortcuts', () => {
  it('takes a bare slash from anywhere on the page', () => {
    const box = mount();
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });

    document.body.dispatchEvent(event);

    expect(document.activeElement).toBe(box.input);
    // Firefox starts quick find on a bare slash, which would take the keystroke instead.
    expect(event.defaultPrevented).toBe(true);
  });

  it('takes Ctrl+K', () => {
    const box = mount();

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
    );

    expect(document.activeElement).toBe(box.input);
  });

  it('leaves a slash alone when somebody is typing into another field', () => {
    const box = mount();
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();

    other.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));

    // A slash in an address is a slash. This is the whole reason the check exists.
    expect(document.activeElement).toBe(other);
    expect(box.input.getAttribute('aria-expanded')).toBe('false');
  });
});
