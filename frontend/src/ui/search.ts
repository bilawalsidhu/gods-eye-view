/**
 * The search box: one field that resolves anything, and the camera flight that follows.
 *
 * It is the only navigation this globe has. There is no layer picker to go through first, so
 * a callsign, an MMSI, "ISS", "Rotterdam" and a street address all go in the same field and
 * come back grouped by type.
 *
 * Three things in here are correctness rather than polish.
 *
 * **The debounce.** A keystroke must never become an upstream request. Cities answer from the
 * server's in-process GeoNames index, but a query that matches nothing local falls through to
 * Nominatim, whose usage policy sets an absolute maximum of one request per second and names
 * systematic querying as unacceptable use. One request per typed word, not one per letter, is
 * what keeps a typeahead inside that.
 *
 * **The cache.** Backspacing over a word re-asks a question already answered, and so does
 * retyping it. Answers are kept for the session, keyed on the query as the server folds it,
 * so a unique query costs at most one request however many times it is typed.
 *
 * **The reduced-motion cut.** Flying the camera is motion. See `globe/flyto.ts`.
 *
 * The DOM class at the bottom is glue. Every decision it makes lives in one of the exported
 * functions above it, which is what lets a runner with no `document` test the behaviour. The
 * painting is covered as far as a browser can prove it, by "typing a city name paints a
 * pickable row" and "picking a city flies the camera there" in `e2e/smoke.spec.ts`. Legibility
 * is not covered by anything: the results list renders hidden, so the axe pass in that suite
 * reads the closed input and no more.
 */

import type { Point, SearchGroupName, SearchHit, SearchResponse } from '../types/entities';

/**
 * How long after the last keystroke the query goes out, in milliseconds.
 *
 * 200ms is roughly the gap between words for a fast typist and well inside the gap between
 * thoughts, so a query goes out per word rather than per letter. It is also the difference
 * between honouring Nominatim's one-per-second cap and breaching it: eight letters typed in a
 * second is eight requests without this and one with it.
 *
 * It is spent against the 300ms this phase is judged on, which is why it is not larger. The
 * server resolves a local query in single-digit milliseconds, so the perceived total is this
 * number plus the round trip.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Hits asked for per group.
 *
 * Five, because the point of grouping is that the best few of each type are visible at once
 * without scrolling. "London" returning five cities beneath an aircraft and a ship is a
 * usable list; twenty-five of each is a page.
 */
export const SEARCH_LIMIT = 5;

/**
 * Answers kept per session.
 *
 * Bounded because a long session is a long typing history and nothing here ever evicts on its
 * own. Oldest first, which is what a `Map` iterates. Two hundred queries of grouped hits is
 * tens of kilobytes.
 */
export const SEARCH_CACHE_LIMIT = 200;

/**
 * Camera height above the ellipsoid for a hit of each type, in metres.
 *
 * A `Record` over the contract's own union rather than a lookup with a fallback, so the
 * organisations and profiles that phase 6 adds to `SearchGroupName` fail the type check here
 * until somebody decides what height they deserve.
 *
 * The numbers are what puts the thing you asked for in its context. An aircraft or a ship is
 * a moving dot that means nothing without the coast or the airport around it. A city wants
 * its region. An address from Nominatim is a building, so it gets the closest view of the
 * five. A satellite carries no position at all, so nothing here is used for one.
 */
export const FLY_ALTITUDE_M: Record<SearchGroupName, number> = {
  aircraft: 80_000,
  vessels: 80_000,
  satellites: 2_000_000,
  cities: 200_000,
  places: 20_000,
};

/**
 * What the box currently has to show.
 *
 * `failed` is its own state rather than an empty result, because "the search request did not
 * complete" and "there is nothing called that" are different statements and only one of them
 * is about the data.
 *
 * There is deliberately no `searching` state. At 200ms plus a single-digit round trip a
 * spinner would flash rather than inform, and the previous answer staying on screen while the
 * next one lands is the calmer picture.
 */
export type SearchState =
  | { kind: 'idle' }
  | { kind: 'results'; response: SearchResponse }
  | { kind: 'failed'; query: string };

/** One line of the typeahead. Only a `hit` row can be highlighted or picked. */
export type TypeaheadRow =
  | { kind: 'group'; label: string }
  | { kind: 'hit'; hit: SearchHit }
  | { kind: 'note'; text: string };

/** What the box prints when the request itself did not complete. */
export const SEARCH_FAILED = 'Search unavailable: the request did not complete';

/** What the box prints when every group was asked and none of them matched. */
export const NO_MATCHES = 'Nothing found';

/**
 * A group heading.
 *
 * Derived from the wire name rather than read out of a table, so a group added to the backend
 * cannot reach the screen unlabelled.
 */
export function groupLabel(name: SearchGroupName): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The list, flattened for rendering.
 *
 * A group with hits contributes a heading and its hits. A group carrying an
 * `unavailable_reason` contributes a heading and that reason: it could not be consulted, which
 * is not the same as having nothing in it, and the reason is the server's words rather than
 * ours. A group that was consulted and matched nothing contributes nothing, because five empty
 * headings is not a result.
 */
export function typeaheadRows(state: SearchState): TypeaheadRow[] {
  if (state.kind === 'idle') {
    return [];
  }
  if (state.kind === 'failed') {
    return [{ kind: 'note', text: SEARCH_FAILED }];
  }
  const rows = state.response.groups.flatMap((group): TypeaheadRow[] => {
    if (group.hits.length > 0) {
      return [
        { kind: 'group', label: groupLabel(group.name) },
        ...group.hits.map((hit): TypeaheadRow => ({ kind: 'hit', hit })),
      ];
    }
    const reason = group.unavailable_reason;
    return reason === null || reason === undefined
      ? []
      : [
          { kind: 'group', label: groupLabel(group.name) },
          { kind: 'note', text: reason },
        ];
  });
  return rows.length === 0 ? [{ kind: 'note', text: NO_MATCHES }] : rows;
}

/**
 * Where the highlight lands after an arrow key, as an index into `rows`.
 *
 * Headings and notes are stepped over: they are not results and cannot be picked. The list
 * wraps, and a first press enters at the top going down or the bottom going up. `-1` means
 * nothing is highlighted, which is what an empty list leaves.
 */
export function nextHighlight(
  rows: readonly TypeaheadRow[],
  current: number,
  delta: number,
): number {
  const pickable = rows.flatMap((row, index) => (row.kind === 'hit' ? [index] : []));
  if (pickable.length === 0) {
    return -1;
  }
  const at = pickable.indexOf(current);
  if (at === -1) {
    return pickable[delta > 0 ? 0 : pickable.length - 1] ?? -1;
  }
  return pickable[(at + delta + pickable.length) % pickable.length] ?? -1;
}

const EDITABLE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Whether a keystroke was aimed at something the user is typing into.
 *
 * Duck-typed rather than an `instanceof HTMLElement` check, because this is the one piece of
 * event handling that has to be testable without a document.
 */
export function isEditableTarget(target: unknown): boolean {
  const node = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (node === null || typeof node !== 'object') {
    return false;
  }
  return (
    (typeof node.tagName === 'string' && EDITABLE_TAGS.has(node.tagName)) ||
    node.isContentEditable === true
  );
}

/**
 * Whether any group in this answer came back carrying a reason rather than hits.
 *
 * Exported because the cache is the thing that must not keep one, and that decision is worth
 * testing without a `document`. A permanently unavailable group (no contact email on the
 * server) therefore costs one cheap round trip to our own server per keystroke burst, which is
 * the right trade against a transient throttle becoming permanent in the browser.
 */
export function isDegraded(response: SearchResponse): boolean {
  return response.groups.some((group) => {
    const reason = group.unavailable_reason;
    return reason !== null && reason !== undefined;
  });
}

/** The shape of a keydown this module needs, so a test can pass a plain object. */
export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  target: unknown;
}

/**
 * Whether this keystroke should put the cursor in the search box.
 *
 * `Ctrl+K`, and `Cmd+K` because on a Mac that is the same shortcut. `/` on its own, which is
 * the convention every map and every code host uses, and which is why it is ignored while the
 * user is typing into a field: a slash in an address is a slash, not a command.
 */
export function isFocusShortcut(event: ShortcutEvent): boolean {
  if ((event.key === 'k' || event.key === 'K') && (event.ctrlKey || event.metaKey)) {
    return true;
  }
  return event.key === '/' && !isEditableTarget(event.target);
}

/** What picking a result can do. Supplied by the bootstrap, so nothing here holds the globe. */
export interface PickTargets {
  flyTo: (point: Point, altitudeM: number) => void;
  /** Open the card for an aircraft or a vessel, by the identity its store is keyed on. */
  selectEntity: (id: string) => void;
  /** Draw a satellite's orbit. Its position is propagated in the browser, not served. */
  selectSatellite: (noradCatId: number) => void;
}

/**
 * Act on one picked result: fly there, and open whatever card it has.
 *
 * A satellite hit carries no point, because a satellite's position is propagated in the
 * browser from its element set and is not a field on the record, so picking one draws its
 * orbit and leaves the camera alone. A city or an address has no card in this build: flying
 * there is the whole action, and inventing a card for it would be inventing content.
 */
export function routePick(hit: SearchHit, targets: PickTargets): void {
  const point = hit.point;
  if (point !== null && point !== undefined) {
    targets.flyTo(point, FLY_ALTITUDE_M[hit.group]);
  }
  if (hit.group === 'satellites') {
    // A catalogue number, or nothing. `Number` rather than `parseInt` on purpose: a leading
    // digit followed by a name would otherwise be read as a number that names no satellite.
    const noradCatId = Number(hit.entity_id);
    if (Number.isSafeInteger(noradCatId) && noradCatId > 0) {
      targets.selectSatellite(noradCatId);
    }
    return;
  }
  if (hit.group === 'aircraft' || hit.group === 'vessels') {
    targets.selectEntity(hit.entity_id);
  }
}

/**
 * The query as the server folds it, for use as a cache key.
 *
 * Internal whitespace collapsed and lower-cased, which is what `services/search.py` does with
 * `" ".join(query.split())` and `casefold`. `toLowerCase` folds slightly less than `casefold`
 * does, and that is the safe direction: it can cost one extra request for a query the server
 * would have treated as identical, where folding harder than the server would serve one
 * query's answer for another's.
 */
export function foldQuery(raw: string): string {
  return raw.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}

export interface SearchQueueOptions {
  search: (query: string, limit: number, signal: AbortSignal) => Promise<SearchResponse>;
  onState: (state: SearchState) => void;
  debounceMs?: number;
  limit?: number;
}

/**
 * The debounce, the cache and the in-flight request, with no DOM anywhere near it.
 *
 * Separate from the box because this is the part that can be wrong in a way nobody sees. A
 * missing debounce looks like a working typeahead right up to the point a provider blocks us,
 * and a response applied out of order looks like a flicker. Both are asserted by tests, which
 * needs them reachable without a document.
 */
export class SearchQueue {
  private readonly options: SearchQueueOptions;
  private readonly cache = new Map<string, SearchResponse>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: AbortController | null = null;
  /** The last query asked for, so a late answer to an abandoned one is dropped. */
  private latest = '';

  constructor(options: SearchQueueOptions) {
    this.options = options;
  }

  /**
   * Take what is in the box now.
   *
   * An empty box is idle immediately: no timer, no request, and any answer still coming is
   * abandoned. A query already answered this session is served from the cache synchronously,
   * so backspacing through a word costs nothing and a unique query costs one request.
   */
  ask(raw: string): void {
    const query = foldQuery(raw);
    this.latest = query;
    this.stop();
    if (query === '') {
      this.options.onState({ kind: 'idle' });
      return;
    }
    const cached = this.cache.get(query);
    if (cached !== undefined) {
      this.options.onState({ kind: 'results', response: cached });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send(query);
    }, this.options.debounceMs ?? SEARCH_DEBOUNCE_MS);
  }

  /** Drop the pending keystroke and abandon anything in flight. */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) {
      this.inFlight.abort();
      this.inFlight = null;
    }
  }

  private send(query: string): void {
    const controller = new AbortController();
    this.inFlight = controller;
    void this.options
      .search(query, this.options.limit ?? SEARCH_LIMIT, controller.signal)
      .then((response) => {
        this.remember(query, response);
        this.settle(query, { kind: 'results', response });
      })
      .catch(() => {
        // Our own abort is not a failure: a query we abandoned has no answer to report.
        if (!controller.signal.aborted) {
          this.settle(query, { kind: 'failed', query });
        }
      });
  }

  /** Report a state, if the query it answers is still the one in the box. */
  private settle(query: string, state: SearchState): void {
    if (this.latest === query) {
      this.options.onState(state);
    }
  }

  private remember(query: string, response: SearchResponse): void {
    // A degraded answer is not an answer. The server's own one-per-second Nominatim floor
    // refuses a keystroke with an HTTP 200 whose places group carries the reason, and caching
    // that pins the query on "retry in 1.0s" for the life of the page while the retry can
    // never happen: `ask` serves the cache before the debounce, so nothing goes out again.
    // Correcting the last letter of a mistyped address is enough to hit it.
    if (isDegraded(response)) {
      return;
    }
    this.cache.set(query, response);
    if (this.cache.size > SEARCH_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }
}

export interface SearchBoxOptions extends Omit<SearchQueueOptions, 'onState'> {
  onPick: (hit: SearchHit) => void;
}

const OPTION_ID_PREFIX = 'search-option-';

/**
 * The box itself: an input, a grouped list under it, and the keys that drive both.
 *
 * A combobox in the ARIA sense, so the list is announced and the highlighted row is reported
 * through `aria-activedescendant` rather than by moving focus, which is what keeps the typed
 * text where it is while the arrows walk the results.
 */
export class SearchBox {
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly queue: SearchQueue;
  private readonly onPick: (hit: SearchHit) => void;
  private rows: TypeaheadRow[] = [];
  private highlight = -1;

  constructor(root: HTMLElement, options: SearchBoxOptions) {
    this.onPick = options.onPick;
    root.classList.add('search');
    root.innerHTML = `
      <input class="search-input" type="search" role="combobox" autocomplete="off"
        spellcheck="false" aria-expanded="false" aria-autocomplete="list"
        aria-controls="search-results" placeholder="Search. Press / or Ctrl+K"
        aria-label="Search aircraft, ships, satellites and places" />
      <ul class="search-results" id="search-results" role="listbox"
        aria-label="Search results" hidden></ul>`;

    const input = root.querySelector<HTMLInputElement>('.search-input');
    const list = root.querySelector<HTMLElement>('.search-results');
    if (input === null || list === null) {
      throw new Error('search template is missing its input or its list');
    }
    this.input = input;
    this.list = list;

    this.queue = new SearchQueue({
      ...options,
      onState: (state) => {
        this.render(state);
      },
    });

    input.addEventListener('input', () => {
      this.queue.ask(input.value);
    });
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      this.onKeyDown(event);
    });
    // Leaving the box puts the list away. Without this a dropdown stays over the globe after
    // a click somewhere else, on top of the thing that click was meant to select.
    input.addEventListener('blur', () => {
      this.render({ kind: 'idle' });
    });
    // A mousedown on the list would blur the input and take the list away before the click
    // that picked a row could land, so the press does not move focus at all.
    list.addEventListener('mousedown', (event: MouseEvent) => {
      event.preventDefault();
    });
    list.addEventListener('click', (event: MouseEvent) => {
      const index = optionIndex(event.target);
      if (index !== null) {
        this.pick(index);
      }
    });
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!isFocusShortcut(event)) {
        return;
      }
      // Firefox gives Ctrl+K to its own search bar, and a bare `/` starts quick find.
      event.preventDefault();
      this.focus();
    });
  }

  /** Put the cursor in the box and select what is there, so typing replaces it. */
  focus(): void {
    this.input.focus();
    this.input.select();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Or the caret jumps to the start or the end of the query while the list moves.
      event.preventDefault();
      this.setHighlight(
        nextHighlight(this.rows, this.highlight, event.key === 'ArrowDown' ? 1 : -1),
      );
      return;
    }
    if (event.key === 'Enter' && this.highlight !== -1) {
      event.preventDefault();
      this.pick(this.highlight);
      return;
    }
    if (event.key === 'Escape') {
      // Escape closes the list and leaves the query, so a second press can be Cesium's or
      // the card's. The card treats Escape as close, and both listen on the document.
      this.queue.stop();
      this.render({ kind: 'idle' });
    }
  }

  private pick(index: number): void {
    const row = this.rows[index];
    if (row?.kind !== 'hit') {
      return;
    }
    this.onPick(row.hit);
    // The list goes away, the query stays. Somebody flying between two results wants the
    // text they typed still there; somebody done with it presses Escape or types over it.
    this.render({ kind: 'idle' });
    this.input.blur();
  }

  private render(state: SearchState): void {
    this.rows = typeaheadRows(state);
    this.highlight = -1;
    this.list.hidden = this.rows.length === 0;
    this.input.setAttribute('aria-expanded', String(this.rows.length > 0));
    this.input.removeAttribute('aria-activedescendant');
    this.list.replaceChildren(...this.rows.map((row, index) => renderRow(row, index)));
  }

  private setHighlight(index: number): void {
    this.highlight = index;
    for (const [at, node] of [...this.list.children].entries()) {
      const selected = at === index;
      node.setAttribute('aria-selected', String(selected));
      // Bracketed because `DOMStringMap` is an index signature: dotted access on one is a
      // typo waiting to happen, which is what noPropertyAccessFromIndexSignature says.
      if (node instanceof HTMLElement) {
        node.dataset['highlight'] = String(selected);
      }
    }
    if (index === -1) {
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    this.input.setAttribute('aria-activedescendant', `${OPTION_ID_PREFIX}${index}`);
  }
}

/** The row a click landed on, or null when it landed on a heading or a gap. */
function optionIndex(target: unknown): number | null {
  const id = (target instanceof Element ? target.closest('.search-hit') : null)?.id;
  if (id?.startsWith(OPTION_ID_PREFIX) !== true) {
    return null;
  }
  const index = Number(id.slice(OPTION_ID_PREFIX.length));
  return Number.isSafeInteger(index) ? index : null;
}

function renderRow(row: TypeaheadRow, index: number): HTMLElement {
  const node = document.createElement('li');
  if (row.kind === 'group') {
    node.className = 'search-group';
    node.setAttribute('role', 'presentation');
    node.textContent = row.label;
    return node;
  }
  if (row.kind === 'note') {
    node.className = 'search-note';
    node.setAttribute('role', 'presentation');
    node.textContent = row.text;
    return node;
  }
  node.className = 'search-hit';
  node.id = `${OPTION_ID_PREFIX}${index}`;
  node.setAttribute('role', 'option');
  node.setAttribute('aria-selected', 'false');
  const label = document.createElement('span');
  label.className = 'search-label';
  label.textContent = row.hit.label;
  node.append(label);
  const detail = row.hit.detail;
  if (detail !== null && detail !== undefined && detail !== '') {
    const line = document.createElement('span');
    line.className = 'search-detail';
    line.textContent = detail;
    node.append(line);
  }
  return node;
}
