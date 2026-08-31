/**
 * Tests for the search box's behaviour, with no DOM in sight.
 *
 * Three things here are the reason the logic was split out of the class that paints it.
 *
 * The debounce: a keystroke that became a request would put a typeahead straight through
 * Nominatim's stated absolute maximum of one request per second, and it would look like a
 * working feature while doing it.
 *
 * The ordering: a slow answer to an abandoned query must not overwrite the answer to the one
 * in the box, which on screen reads as a flicker rather than as a bug.
 *
 * The routing: picking a satellite must not try to fly to a position no record carries, and
 * picking a city must not try to open a card that does not exist.
 *
 * The painting of the list is covered by the Playwright suite, which has a real document.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FLY_ALTITUDE_M,
  NO_MATCHES,
  SEARCH_DEBOUNCE_MS,
  SEARCH_FAILED,
  SEARCH_LIMIT,
  SearchQueue,
  foldQuery,
  groupLabel,
  isEditableTarget,
  isFocusShortcut,
  nextHighlight,
  routePick,
  typeaheadRows,
} from './search';
import type { PickTargets, SearchState, ShortcutEvent, TypeaheadRow } from './search';
import type { Point, SearchGroupName, SearchHit, SearchResponse } from '../types/entities';

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    group: 'cities',
    entity_id: '2643743',
    label: 'London',
    detail: 'United Kingdom · 8,961,989 people',
    point: { lon: -0.12574, lat: 51.50853, altitude_m: null },
    score: 1,
    ...overrides,
  };
}

function response(groups: SearchResponse['groups'] = [], query = 'london'): SearchResponse {
  return { query, groups };
}

function results(groups: SearchResponse['groups']): SearchState {
  return { kind: 'results', response: response(groups) };
}

describe('typeaheadRows', () => {
  it('shows nothing at all when the box is empty', () => {
    expect(typeaheadRows({ kind: 'idle' })).toEqual([]);
  });

  it('puts a heading above each group hits', () => {
    const london = hit();
    const ontario = hit({ entity_id: '6058560', detail: 'Canada · 422,324 people' });

    const rows = typeaheadRows(results([{ name: 'cities', hits: [london, ontario] }]));

    expect(rows).toEqual([
      { kind: 'group', label: 'Cities' },
      { kind: 'hit', hit: london },
      { kind: 'hit', hit: ontario },
    ]);
  });

  it('keeps the groups in the order the server ranked them', () => {
    const rows = typeaheadRows(
      results([
        { name: 'aircraft', hits: [hit({ group: 'aircraft', label: 'BAW117' })] },
        { name: 'cities', hits: [hit()] },
      ]),
    );

    expect(rows.filter((row) => row.kind === 'group')).toEqual([
      { kind: 'group', label: 'Aircraft' },
      { kind: 'group', label: 'Cities' },
    ]);
  });

  it('prints the server reason for a group that could not be consulted', () => {
    const rows = typeaheadRows(
      results([{ name: 'places', hits: [], unavailable_reason: 'no contact address configured' }]),
    );

    // The reason is the server's words. A degraded group reading "nothing found" would be
    // this app inventing a fact about the world from a fact about its own configuration.
    expect(rows).toEqual([
      { kind: 'group', label: 'Places' },
      { kind: 'note', text: 'no contact address configured' },
    ]);
  });

  it('drops a group that was asked and matched nothing', () => {
    const rows = typeaheadRows(
      results([
        { name: 'aircraft', hits: [] },
        { name: 'cities', hits: [hit()] },
      ]),
    );

    expect(rows.map((row) => row.kind)).toEqual(['group', 'hit']);
  });

  it('says so once when every group was asked and none matched', () => {
    expect(typeaheadRows(results([]))).toEqual([{ kind: 'note', text: NO_MATCHES }]);
  });

  it('separates a failed request from an empty world', () => {
    expect(typeaheadRows({ kind: 'failed', query: 'london' })).toEqual([
      { kind: 'note', text: SEARCH_FAILED },
    ]);
  });
});

describe('groupLabel', () => {
  it('capitalises whatever the contract calls the group', () => {
    const names: SearchGroupName[] = ['aircraft', 'vessels', 'satellites', 'cities', 'places'];

    expect(names.map((name) => groupLabel(name))).toEqual([
      'Aircraft',
      'Vessels',
      'Satellites',
      'Cities',
      'Places',
    ]);
  });
});

describe('nextHighlight', () => {
  const rows: TypeaheadRow[] = [
    { kind: 'group', label: 'Cities' },
    { kind: 'hit', hit: hit() },
    { kind: 'hit', hit: hit({ entity_id: '6058560' }) },
    { kind: 'group', label: 'Places' },
    { kind: 'hit', hit: hit({ group: 'places', entity_id: 'way/12345' }) },
  ];

  it('enters at the first result going down', () => {
    expect(nextHighlight(rows, -1, 1)).toBe(1);
  });

  it('enters at the last result going up', () => {
    expect(nextHighlight(rows, -1, -1)).toBe(4);
  });

  it('steps over group headings', () => {
    // Index 3 is the Places heading, so down from index 2 lands on 4, not on 3.
    expect(nextHighlight(rows, 2, 1)).toBe(4);
  });

  it('wraps at both ends', () => {
    expect(nextHighlight(rows, 4, 1)).toBe(1);
    expect(nextHighlight(rows, 1, -1)).toBe(4);
  });

  it('highlights nothing when there is nothing to highlight', () => {
    expect(nextHighlight([{ kind: 'note', text: NO_MATCHES }], -1, 1)).toBe(-1);
  });
});

function shortcut(overrides: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return { key: '/', ctrlKey: false, metaKey: false, target: null, ...overrides };
}

describe('isFocusShortcut', () => {
  it('takes a bare slash', () => {
    expect(isFocusShortcut(shortcut())).toBe(true);
  });

  it('leaves a slash alone while the user is typing into a field', () => {
    // A slash in an address is a slash. Stealing it would make the field unusable.
    expect(isFocusShortcut(shortcut({ target: { tagName: 'INPUT' } }))).toBe(false);
    expect(isFocusShortcut(shortcut({ target: { isContentEditable: true } }))).toBe(false);
  });

  it('takes Ctrl+K and Cmd+K, in either case, wherever the cursor is', () => {
    for (const key of ['k', 'K']) {
      expect(isFocusShortcut(shortcut({ key, ctrlKey: true, target: { tagName: 'INPUT' } }))).toBe(
        true,
      );
      expect(isFocusShortcut(shortcut({ key, metaKey: true }))).toBe(true);
    }
  });

  it('ignores a bare k', () => {
    expect(isFocusShortcut(shortcut({ key: 'k' }))).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('is false for whatever the DOM hands over that is not an element', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget('window')).toBe(false);
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
  });
});

function targets() {
  const flights: [Point, number][] = [];
  const entities: string[] = [];
  const satellites: number[] = [];
  const spy: PickTargets = {
    flyTo: (point, altitudeM) => {
      flights.push([point, altitudeM]);
    },
    selectEntity: (id) => {
      entities.push(id);
    },
    selectSatellite: (noradCatId) => {
      satellites.push(noradCatId);
    },
  };
  return { spy, flights, entities, satellites };
}

describe('routePick', () => {
  it('flies to a city and opens no card, because a city has none', () => {
    const { spy, flights, entities, satellites } = targets();

    routePick(hit(), spy);

    expect(flights).toEqual([[{ lon: -0.12574, lat: 51.50853, altitude_m: null }, 200_000]]);
    expect(entities).toEqual([]);
    expect(satellites).toEqual([]);
  });

  it('flies to an aircraft and opens its card', () => {
    const { spy, flights, entities } = targets();

    routePick(hit({ group: 'aircraft', entity_id: '4ca7b3', label: 'BAW117' }), spy);

    expect(flights[0]?.[1]).toBe(FLY_ALTITUDE_M.aircraft);
    expect(entities).toEqual(['4ca7b3']);
  });

  it('flies to a vessel and opens its card', () => {
    const { spy, entities } = targets();

    routePick(hit({ group: 'vessels', entity_id: '244660000' }), spy);

    expect(entities).toEqual(['244660000']);
  });

  it('draws a satellite orbit and leaves the camera where it is', () => {
    const { spy, flights, satellites, entities } = targets();

    // A satellite record carries no point: its position is propagated in the browser from
    // its element set, so there is nothing to fly to and no card to open.
    routePick(
      hit({ group: 'satellites', entity_id: '25544', label: 'ISS (ZARYA)', point: null }),
      spy,
    );

    expect(flights).toEqual([]);
    expect(entities).toEqual([]);
    expect(satellites).toEqual([25_544]);
  });

  it('ignores a satellite whose id is not a catalogue number', () => {
    const { spy, satellites } = targets();

    routePick(hit({ group: 'satellites', entity_id: 'ZARYA', point: null }), spy);

    expect(satellites).toEqual([]);
  });
});

describe('foldQuery', () => {
  it('folds the way the server does, so one question is asked once', () => {
    expect(foldQuery('  New   YORK  ')).toBe('new york');
  });
});

function queue(
  search: (query: string, limit: number, signal: AbortSignal) => Promise<SearchResponse>,
) {
  const states: SearchState[] = [];
  const instance = new SearchQueue({
    search,
    onState: (state) => {
      states.push(state);
    },
  });
  return { instance, states };
}

describe('SearchQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one request for a word typed a letter at a time', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const { instance, states } = queue((query) => {
      asked.push(query);
      return Promise.resolve(response([{ name: 'cities', hits: [hit()] }], query));
    });

    for (const partial of ['l', 'lo', 'lon', 'lond', 'londo', 'london']) {
      instance.ask(partial);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    // Six keystrokes, one request. Without this a typeahead breaches Nominatim's cap of one
    // request per second on the first word anybody types.
    expect(asked).toEqual(['london']);
    expect(states).toHaveLength(1);
    expect(states[0]?.kind).toBe('results');
  });

  it('asks for the number of hits per group the list will show', async () => {
    vi.useFakeTimers();
    const limits: number[] = [];
    const { instance } = queue((query, limit) => {
      limits.push(limit);
      return Promise.resolve(response([], query));
    });

    instance.ask('london');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(limits).toEqual([SEARCH_LIMIT]);
  });

  it('answers a repeated query from the cache, with no request and no wait', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { instance, states } = queue((query) => {
      calls += 1;
      return Promise.resolve(response([{ name: 'cities', hits: [hit()] }], query));
    });

    instance.ask('london');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    instance.ask('londo');
    instance.ask('london');

    // Synchronous, before any timer runs: backspacing over a word and retyping it must not
    // put a second question to a provider that already answered this one.
    expect(calls).toBe(1);
    expect(states).toHaveLength(2);
    expect(states.at(-1)?.kind).toBe('results');
  });

  it('never caches an answer whose group came back unavailable', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const throttled = 'nominatim: self-imposed floor of one request per 1s not yet elapsed';
    const { instance } = queue((query) => {
      calls += 1;
      const group =
        calls === 1
          ? { name: 'places' as const, hits: [], unavailable_reason: throttled }
          : { name: 'places' as const, hits: [hit({ group: 'places' })] };
      return Promise.resolve(response([group], query));
    });

    instance.ask('10 downing street');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    instance.ask('10 downing street');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    // The server's own one-per-second Nominatim floor refuses a keystroke with an HTTP 200
    // carrying the reason. Cached, that pins the query on "retry in 1.0s" for the life of the
    // page, and `ask` serves the cache before the debounce so the retry can never happen.
    expect(calls).toBe(2);
  });

  it('goes idle on an empty box and abandons what was pending', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { instance, states } = queue((query) => {
      calls += 1;
      return Promise.resolve(response([], query));
    });

    instance.ask('lond');
    instance.ask('');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);

    expect(calls).toBe(0);
    expect(states).toEqual([{ kind: 'idle' }]);
  });

  it('drops a late answer to a query nobody is asking any more', async () => {
    vi.useFakeTimers();
    const { instance, states } = queue((query) => {
      // "rotterdam" answers slowly, "london" quickly, so the abandoned query lands last.
      const delay = query === 'rotterdam' ? 400 : 10;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(response([{ name: 'cities', hits: [hit({ label: query })] }], query));
        }, delay);
      });
    });

    instance.ask('rotterdam');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    instance.ask('london');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 500);

    const labels = states.map((state) =>
      state.kind === 'results' ? state.response.query : state.kind,
    );
    expect(labels).toEqual(['london']);
  });

  it('aborts the request in flight when the query moves on', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { instance } = queue((query, _limit, signal) => {
      signals.push(signal);
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(response([], query));
        }, 400);
      });
    });

    instance.ask('rotterdam');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    instance.ask('london');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('reports a failed request as a failure, not as an empty result', async () => {
    vi.useFakeTimers();
    const { instance, states } = queue(() => Promise.reject(new Error('offline')));

    instance.ask('london');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(states).toEqual([{ kind: 'failed', query: 'london' }]);
  });

  it('says nothing about a query it abandoned itself', async () => {
    vi.useFakeTimers();
    const { instance, states } = queue(
      (_query, _limit, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    instance.ask('rotterdam');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    instance.stop();
    await vi.advanceTimersByTimeAsync(10);

    // An abort is our own decision, not a failure of the search. Reporting it would put
    // "search unavailable" on screen every time somebody kept typing.
    expect(states).toEqual([]);
  });

  it('leaves room inside the 300ms this phase is judged on', () => {
    // Acceptance criterion 1 is measured from the last keystroke, so the debounce is spent
    // out of the same budget as the round trip. Measured against the running backend on
    // 2026-08-20, 25 samples across a live callsign, an MMSI, "ISS", "London" and
    // "Rotterdam": 1.8ms to 5.5ms. The allowance below is an order of magnitude over that,
    // and the perceived total is still about 205ms.
    const measuredRoundTripMs = 40;

    expect(SEARCH_DEBOUNCE_MS + measuredRoundTripMs).toBeLessThan(300);
  });
});
