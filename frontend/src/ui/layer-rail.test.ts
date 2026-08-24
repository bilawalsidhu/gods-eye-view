/**
 * Tests for the layer rail, against a fake document.
 *
 * The runner has no DOM, so the handful of element methods the rail uses are faked here,
 * the same way the aircraft layer is tested against a fake Cesium collection. The fake is
 * faithful in the two places that matter: it counts every `createElement`, so "a toggle
 * rebuilds nothing" is asserted rather than assumed, and it fires listeners, so the switch
 * is exercised through the event it will actually receive.
 *
 * What a fake cannot prove is focus order, hit area and how a screen reader announces the
 * group. That needs a real browser and belongs to the Playwright suite in phase 9.
 *
 * The capability, feed and attribution payloads below are what this backend actually
 * served, reason strings and feed names verbatim, read off `/api/capabilities` and
 * `/api/layers` on a live run on 2026-08-20 with no credentials configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LayerRail,
  NO_REASON_GIVEN,
  NOTICE_SUMMARY_MAX,
  countText,
  heldCounts,
  noticeSummary,
  railCollapseLabel,
  sweepLine,
  sweepRefusals,
  sweepSummary,
  noticesNeedDisclosure,
  notDrawnLabel,
  railRows,
} from './layer-rail';
import type {
  AttributionEntry,
  FeedHealth,
  LayerCapability,
  LayerSummary,
  ProviderCoverage,
  SweepCoverage,
} from '../types/entities';

const AISHUB_REASON =
  'AISHub grants API access only to members streaming raw NMEA from a physical AIS ' +
  'receiver, so no username exists to configure and the provider is unavailable';

const AISSTREAM_REASON =
  'Set TRACKER_AISSTREAM_API_KEY (free key from aisstream.io) to enable global ships. ' +
  'Without it the vessel layer runs on the keyless regional providers only.';

const CAMERAS_REASON = 'Set TRACKER_WINDY_API_KEY or TRACKER_TFL_APP_KEY to enable public cameras.';

const CAPABILITIES: readonly LayerCapability[] = [
  { layer: 'aircraft', available: true, reason: null },
  { layer: 'military', available: true, reason: null },
  { layer: 'vessels', available: true, reason: null },
  { layer: 'vessels/aisstream', available: false, reason: AISSTREAM_REASON },
  { layer: 'vessels/aishub', available: false, reason: AISHUB_REASON },
  { layer: 'satellites', available: true, reason: null },
  { layer: 'cameras', available: false, reason: CAMERAS_REASON },
];

const ATTRIBUTION: readonly AttributionEntry[] = [
  {
    source: 'adsb.lol',
    text: 'Aircraft data from adsb.lol',
    url: 'https://adsb.lol',
    licence: 'ODbL 1.0',
    // Single-source fixture, so no grouped-credit operators and no licence date.
    operators: [],
  },
  {
    source: 'adsb.fi',
    text: 'Aircraft failover data from adsb.fi',
    url: 'https://adsb.fi',
    licence: 'Non-commercial use',
    // Single-source fixture, so no grouped-credit operators and no licence date.
    operators: [],
  },
  {
    source: 'Fintraffic',
    text: 'Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
    url: 'https://www.digitraffic.fi',
    licence: 'CC BY 4.0',
    // Single-source fixture, so no grouped-credit operators and no licence date.
    operators: [],
  },
  {
    source: 'aisstream.io',
    text: 'Global vessel positions from aisstream.io',
    url: 'https://aisstream.io',
    licence: 'Provider terms, redistribution not granted; check before commercial use',
    // Single-source fixture, so no grouped-credit operators and no licence date.
    operators: [],
  },
  {
    source: 'AISHub',
    text: 'Vessel data from the AISHub contributor network',
    url: 'https://www.aishub.net',
    licence: 'Contributor terms, redistribution not granted',
    // Single-source fixture, so no grouped-credit operators and no licence date.
    operators: [],
  },
  {
    source: 'CelesTrak',
    text: 'Orbital element sets from CelesTrak',
    url: 'https://celestrak.org',
    licence: 'Not stated by the provider; credit is courtesy',
    // Single-source fixture, so no grouped-credit operators and no licence date.
    operators: [],
  },
  {
    source: 'NASA GIBS',
    text: 'Imagery courtesy of NASA EOSDIS GIBS',
    url: 'https://gibs.earthdata.nasa.gov',
    licence: 'Public domain, attribution requested',
    // Single-source fixture, so no grouped-credit operators and no licence date.
    operators: [],
  },
];

/** A healthy feed, which means one that has actually succeeded at something. See `status.test.ts`. */
function feed(overrides: Partial<FeedHealth> = {}): FeedHealth {
  return {
    source: 'adsb.lol/point',
    layer: 'aircraft',
    healthy: true,
    entity_count: 1234,
    consecutive_failures: 0,
    poll_interval_seconds: 8,
    last_error: null,
    last_success_at: '2026-08-24T09:22:22.801427Z',
    rate_limited_until: null,
    ...overrides,
  };
}

const FEEDS: readonly FeedHealth[] = [
  feed(),
  feed({ source: 'adsb.lol/mil', layer: 'military', entity_count: 391 }),
  feed({ source: 'vessels/union', layer: 'vessels', entity_count: 2048 }),
  feed({ source: 'celestrak/gp', layer: 'satellites', entity_count: 11_432 }),
];

const TOGGLEABLE = ['aircraft', 'military'] as const;

/**
 * Per-provider coverage as `/api/layers` serves it, which is the last cycle rather than the
 * configuration. `error` set means the provider answered badly and the union dropped it.
 */
function provider(overrides: Partial<ProviderCoverage> = {}): ProviderCoverage {
  return {
    layer: 'vessels',
    provider: 'digitraffic',
    records: 109,
    exclusive: 109,
    error: null,
    // Running totals across cycles, which is how a provider that has failed all week is
    // told apart from one that failed once.
    polls: 4,
    failures: 0,
    empty_polls: 0,
    drops: 0,
    ...overrides,
  };
}

interface RowOverrides {
  feeds?: readonly FeedHealth[];
  providers?: readonly ProviderCoverage[];
  notices?: ReadonlyMap<string, readonly string[]>;
  held?: ReadonlyMap<string, number>;
}

function rows(overrides: RowOverrides = {}) {
  return railRows({
    capabilities: CAPABILITIES,
    feeds: overrides.feeds ?? FEEDS,
    attribution: ATTRIBUTION,
    toggleable: TOGGLEABLE,
    providers: overrides.providers,
    notices: overrides.notices,
    held: overrides.held,
  });
}

function row(layer: string, overrides: RowOverrides = {}) {
  const found = rows(overrides).find((candidate) => candidate.layer === layer);
  expect(found, `no row for ${layer}`).toBeDefined();
  return found!;
}

describe('railRows', () => {
  it('shows the count the server reports for the layer', () => {
    expect(row('aircraft').count).toBe(1234);
    expect(row('satellites').count).toBe(11_432);
  });

  it('leaves a layer no feed reports on without a count rather than showing zero', () => {
    // Zero and "nothing has said yet" are different claims, and only one of them is true
    // before the first poll lands.
    expect(row('cameras').count).toBeNull();
  });

  it('renders an unavailable layer with the reason the API gave, not as an empty layer', () => {
    const cameras = row('cameras');

    expect(cameras.state).toBe('unavailable');
    expect(cameras.detail).toBe(CAMERAS_REASON);
  });

  it('names the missing provider on a layer that is live on its others', () => {
    const vessels = row('vessels');

    // The layer is up on Fintraffic, so it is degraded rather than unavailable, and the
    // row has to say which provider is absent or the thinner coverage is invisible.
    expect(vessels.state).toBe('degraded');
    expect(vessels.count).toBe(2048);
    expect(vessels.detail).toContain(`AISHub missing: ${AISHUB_REASON}`);
    expect(vessels.detail).toContain(AISSTREAM_REASON);
  });

  it('names the provider as its own credit does rather than as the API slug', () => {
    // `vessels/aishub` is what the capability is called; AISHub is what the licence calls
    // the source, and that mapping is read off the attribution list, not written here.
    expect(row('vessels').detail).toContain('AISHub missing');
    expect(row('vessels').detail).not.toContain('aishub missing');
  });

  it('folds a provider into its layer instead of giving it a row of its own', () => {
    expect(rows().map((entry) => entry.layer)).not.toContain('vessels/aishub');
  });

  it('lists the layers this build draws first, then the rest the server offers', () => {
    expect(rows().map((entry) => entry.layer)).toStrictEqual([
      'aircraft',
      'military',
      'vessels',
      'satellites',
      'cameras',
    ]);
  });

  it('renders a layer with an unhealthy zero-count feed as unavailable, not as zero', () => {
    // Taken from a live run on 2026-08-20: before the first CelesTrak fetch the capability
    // is false with that reason while the poller already reports the layer at zero. The
    // count is the wrong thing to show, and "0 satellites" is a lie about the sky.
    const [satellites] = railRows({
      capabilities: [
        { layer: 'satellites', available: false, reason: 'CelesTrak has not been queried yet' },
      ],
      feeds: [
        feed({ source: 'celestrak/gp', layer: 'satellites', entity_count: 0, healthy: false }),
      ],
      attribution: ATTRIBUTION,
      toggleable: [],
    });

    expect(satellites!.state).toBe('unavailable');
    expect(satellites!.detail).toBe('CelesTrak has not been queried yet');
  });

  it('says so when the API gives no reason for an unavailable layer', () => {
    // `reason` is optional on the contract, so a row has to read as something other than
    // an empty layer even when the server sends nothing with the flag.
    const [row] = railRows({
      capabilities: [{ layer: 'cameras', available: false, reason: null }],
      feeds: [],
      attribution: [],
      toggleable: [],
    });

    expect(row!.state).toBe('unavailable');
    expect(row!.detail).toBe(NO_REASON_GIVEN);
  });

  it('reuses the banner wording for a feed in trouble', () => {
    const degraded = row('aircraft', {
      feeds: [feed({ healthy: false, last_error: 'connection refused' })],
    });

    expect(degraded.state).toBe('degraded');
    expect(degraded.detail).toBe('adsb.lol/point down: connection refused');
  });

  it('does not mark a row degraded for a feed that has not polled yet', () => {
    // Live on 2026-08-24 the satellite feed had never been asked, because CelesTrak's floor and
    // its element sets are both on disk and a process started inside the six-hour window opens no
    // socket. 676 satellites were on the globe off that cache. A row that reads degraded there is
    // pointing at the layer that is working.
    const waiting = row('aircraft', {
      feeds: [
        feed({
          healthy: false,
          entity_count: 0,
          last_success_at: null,
          last_error: null,
          consecutive_failures: 0,
          poll_interval_seconds: 21_600,
        }),
      ],
    });

    expect(waiting.state).toBe('live');
    expect(waiting.detail).toBeNull();
    expect(waiting.notices).toEqual([]);
  });

  it('offers a switch only for a layer this build draws', () => {
    expect(row('aircraft').toggleable).toBe(true);
    expect(row('military').toggleable).toBe(true);
    // Not in the list this test passes in, so no switch. The running app draws vessels and
    // does list them; what is asserted here is that the list decides, never the server.
    expect(row('vessels').toggleable).toBe(false);
  });
});

/**
 * The smallest element the rail actually uses.
 *
 * Every field here is one the rail assigns or reads. Nothing else is faked, so a rail that
 * starts reaching for the real DOM fails these tests rather than passing against a fake
 * that quietly grew to match it.
 */
class FakeElement {
  readonly tag: string;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string): void => {
      this.classes.add(name);
    },
  };
  className = '';
  textContent = '';
  hidden = false;
  type = '';
  checked = false;
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(tag: string) {
    this.tag = tag;
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, handler: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  /** Deliver the event the browser would deliver when the switch is operated. */
  fire(type: string): void {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) {
      handler();
    }
  }

  /** Every descendant with this class, in document order. */
  select(className: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (child.className === className) {
        found.push(child);
      }
      found.push(...child.select(className));
    }
    return found;
  }
}

/** How many elements have been built, so a test can prove nothing was rebuilt. */
const builds = { count: 0 };

function fakeDocument(): { createElement: (tag: string) => FakeElement } {
  return {
    createElement: (tag: string): FakeElement => {
      builds.count += 1;
      return new FakeElement(tag);
    },
  };
}

function asElement(fake: FakeElement): HTMLElement {
  return fake as unknown as HTMLElement;
}

interface Harness {
  root: FakeElement;
  rail: LayerRail;
  toggles: string[];
}

function mount(): Harness {
  const root = new FakeElement('div');
  const toggles: string[] = [];
  const rail = new LayerRail(asElement(root), {
    toggleable: TOGGLEABLE,
    onToggle: (layer, visible) => {
      toggles.push(`${layer}:${String(visible)}`);
    },
  });
  rail.setCapabilities(CAPABILITIES, ATTRIBUTION);
  rail.update(FEEDS);
  return { root, rail, toggles };
}

function textOf(root: FakeElement, className: string): string[] {
  return root.select(className).map((node) => node.textContent);
}

/**
 * Just enough `window` for the rail's own disclosure.
 *
 * The rail asks `matchMedia` whether the viewport is short enough to collapse itself, which is a
 * browser API this runner does not have any more than it has a document. `matches: false` is the
 * tall-window case, so every existing test sees the rail it has always seen, expanded.
 */
function fakeWindow(matches = false) {
  const listeners: ((event: { matches: boolean }) => void)[] = [];
  return {
    window: {
      matchMedia: () => ({
        matches,
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
          listeners.push(listener);
        },
      }),
    },
    /** Fire a viewport change, so the collapse can be driven without resizing anything. */
    resize(short: boolean): void {
      for (const listener of listeners) {
        listener({ matches: short });
      }
    },
  };
}

describe('LayerRail', () => {
  beforeEach(() => {
    builds.count = 0;
    // The rail builds its rows with `document.createElement`, so the runner needs one.
    vi.stubGlobal('document', fakeDocument());
    vi.stubGlobal('window', fakeWindow().window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('names the group so a screen reader says what the switches belong to', () => {
    const { root } = mount();

    expect(root.classes.has('rail')).toBe(true);
    expect(root.attributes['role']).toBe('group');
    expect(root.attributes['aria-label']).toBe('Layers');
  });

  it('draws one row per layer with its count', () => {
    const { root } = mount();

    expect(textOf(root, 'rail-name')).toStrictEqual([
      'Aircraft',
      'Military',
      'Vessels',
      'Satellites',
      'Cameras',
    ]);
    expect(textOf(root, 'rail-count')).toStrictEqual(['1,234', '391', '2,048', '11,432', '']);
  });

  it('gives an unavailable layer its reason and no count', () => {
    const { root } = mount();
    const cameras = root.select('rail-row').at(-1)!;

    expect(cameras.dataset['state']).toBe('unavailable');
    expect(cameras.select('rail-count')[0]!.textContent).toBe('');
    // This reason is past the summary cap, so the row shows a shortened line and keeps the
    // whole thing inside the disclosure. Shortening is for the summary, never for the reason.
    expect(textOf(cameras, 'rail-notice')).toStrictEqual([CAMERAS_REASON]);
    // No switch: there is nothing to switch off.
    expect(cameras.select('rail-switch')).toHaveLength(0);
  });

  it('renders the switch as a checkbox inside its label, so it is reachable by keyboard', () => {
    const { root } = mount();
    const switches = root.select('rail-switch');

    expect(switches).toHaveLength(2);
    expect(switches.every((input) => input.type === 'checkbox')).toBe(true);
    expect(switches.every((input) => input.checked)).toBe(true);
    // Focus order and the announced name need a real browser: that is the Playwright suite.
    const heads = root.select('rail-head');
    expect(heads.slice(0, 2).every((head) => head.tag === 'label')).toBe(true);
    // A row with no switch is not a label: there would be no control for it to label.
    expect(heads.at(-1)!.tag).toBe('div');
  });

  it('switching a layer off costs one call and touches nothing else', () => {
    const fetching = vi.spyOn(globalThis, 'fetch');
    const { root, toggles } = mount();
    const before = builds.count;
    const counts = textOf(root, 'rail-count');

    root.select('rail-switch')[0]!.checked = false;
    root.select('rail-switch')[0]!.fire('change');

    expect(toggles).toStrictEqual(['aircraft:false']);
    // No element built, so no row was rebuilt and no count was recomputed.
    expect(builds.count).toBe(before);
    expect(textOf(root, 'rail-count')).toStrictEqual(counts);
    expect(fetching).not.toHaveBeenCalled();
  });

  it('reports the layer both ways round, and only the one that was switched', () => {
    const { root, toggles } = mount();
    const input = root.select('rail-switch')[0]!;

    input.checked = false;
    input.fire('change');
    input.checked = true;
    input.fire('change');

    // Only the aircraft row moved: a rail that reported the wrong layer would hide the
    // wrong aircraft, and both switches sit in the same list.
    expect(toggles).toStrictEqual(['aircraft:false', 'aircraft:true']);
    expect(root.select('rail-row')[0]!.dataset['visible']).toBe('true');
  });

  it('keeps a layer switched off across a rebuild', () => {
    const { root, rail } = mount();
    root.select('rail-switch')[0]!.checked = false;
    root.select('rail-switch')[0]!.fire('change');

    // Capabilities answering a second time rebuilds the rows. A layer the user switched
    // off must not come back on by itself.
    rail.setCapabilities(CAPABILITIES, ATTRIBUTION);

    expect(root.select('rail-switch')[0]!.checked).toBe(false);
    expect(root.select('rail-switch')[1]!.checked).toBe(true);
  });

  it('updates counts in place rather than rebuilding the rail', () => {
    const { root, rail } = mount();
    const before = builds.count;

    rail.update([feed({ entity_count: 1500 }), ...FEEDS.slice(1)]);

    expect(textOf(root, 'rail-count')[0]).toBe('1,500');
    expect(builds.count).toBe(before);
  });

  it('rebuilds when the set of layers changes, not when the numbers do', () => {
    const { root, rail } = mount();
    const before = builds.count;

    rail.setCapabilities(
      [
        ...CAPABILITIES,
        { layer: 'places', available: false, reason: 'Set TRACKER_CONTACT_EMAIL.' },
      ],
      ATTRIBUTION,
    );

    expect(builds.count).toBeGreaterThan(before);
    expect(textOf(root, 'rail-name')).toContain('Places');
  });

  it('adds a row for a layer only the feed list mentions', () => {
    const { root, rail } = mount();

    // A feed reporting on a layer `/api/capabilities` never listed still has a count worth
    // showing, so the row set is rebuilt rather than the layer being dropped.
    rail.update([...FEEDS, feed({ source: 'usgs/quakes', layer: 'events', entity_count: 42 })]);

    expect(textOf(root, 'rail-name')).toContain('Events');
    expect(textOf(root, 'rail-count')).toContain('42');
  });

  it('runs before the API answers, with no capabilities and no feeds', () => {
    const root = new FakeElement('div');
    new LayerRail(asElement(root), { toggleable: TOGGLEABLE, onToggle: vi.fn() });

    // The switches exist from the first frame; the counts arrive with the first broadcast.
    expect(textOf(root, 'rail-name')).toStrictEqual(['Aircraft', 'Military']);
    expect(textOf(root, 'rail-count')).toStrictEqual(['', '']);
    // Nothing the server offers is known yet, so there is no collapsed group either.
    expect(root.select('rail-extra-summary')[0]!.textContent).toBe('');
  });
});

/**
 * The layer half of the URL state.
 *
 * The rail owns which layers are switched off, because its checkboxes are the thing on
 * screen that states it. A shared URL asks it to switch some off; the URL writer asks it
 * which are off. Neither keeps a second copy, so neither can disagree with the switches.
 */
describe('LayerRail and the URL', () => {
  beforeEach(() => {
    builds.count = 0;
    vi.stubGlobal('document', fakeDocument());
    vi.stubGlobal('window', fakeWindow().window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('switches off exactly the layers a shared URL named', () => {
    const { root, rail, toggles } = mount();

    rail.hide(['military']);

    expect(toggles).toStrictEqual(['military:false']);
    expect(root.select('rail-switch')[0]!.checked).toBe(true);
    expect(root.select('rail-switch')[1]!.checked).toBe(false);
    expect(rail.hiddenLayers).toStrictEqual(['military']);
  });

  it('ignores a layer name this build cannot draw', () => {
    const { rail, toggles } = mount();

    rail.hide(['military', 'bananas', 'places']);

    // A link from a deployment that has a layer this one does not must still open.
    expect(toggles).toStrictEqual(['military:false']);
    expect(rail.hiddenLayers).toStrictEqual(['military']);
  });

  it('switches a layer back on when the URL stops naming it', () => {
    const { root, rail, toggles } = mount();
    rail.hide(['military']);

    rail.hide([]);

    expect(toggles).toStrictEqual(['military:false', 'military:true']);
    expect(root.select('rail-switch')[1]!.checked).toBe(true);
    expect(rail.hiddenLayers).toStrictEqual([]);
  });

  it('costs nothing when the URL agrees with the switches', () => {
    const { rail, toggles } = mount();
    const before = builds.count;

    rail.hide([]);

    // The usual case at first paint is that nothing is hidden, so nothing is rebuilt and
    // no layer is told anything.
    expect(toggles).toStrictEqual([]);
    expect(builds.count).toBe(before);
  });

  it('reports what the user switched off with the checkbox', () => {
    const { root, rail } = mount();

    root.select('rail-switch')[0]!.checked = false;
    root.select('rail-switch')[0]!.fire('change');

    expect(rail.hiddenLayers).toStrictEqual(['aircraft']);
  });
});

/**
 * A configured provider that failed, which is a different sentence from one never configured.
 *
 * ADR 010: a provider that errors, rate-limits or loses its key drops out of the union for
 * that cycle and the layer reports itself degraded with which provider is missing. The rail
 * used to derive its state from `/api/capabilities` alone, which is a credential check, so a
 * provider answering HTTP 500 on every single cycle left the row reading fully live.
 */
describe('railRows with per-provider coverage', () => {
  it('names a configured provider that dropped out, with the error the cycle recorded', () => {
    const vessels = row('vessels', {
      providers: [
        provider(),
        provider({ provider: 'aishub', records: 0, exclusive: 0, error: 'HTTP 500' }),
      ],
    });

    expect(vessels.state).toBe('degraded');
    expect(vessels.detail).toContain('aishub dropped out: HTTP 500');
  });

  it('degrades a layer whose capabilities all read available, on the runtime error alone', () => {
    const [vessels] = railRows({
      capabilities: [{ layer: 'vessels', available: true, reason: null }],
      feeds: [feed({ source: 'vessels/union', layer: 'vessels', entity_count: 109 })],
      attribution: [],
      toggleable: [],
      providers: [provider({ provider: 'aisstream', error: 'socket closed' })],
    });

    // The one poller covering the whole union stays healthy when a provider dies, so
    // nothing else on the row would have said a word about it.
    expect(vessels!.state).toBe('degraded');
    expect(vessels!.detail).toBe('aisstream dropped out: socket closed');
  });

  it('stays live when every provider answered', () => {
    const [vessels] = railRows({
      capabilities: [{ layer: 'vessels', available: true, reason: null }],
      feeds: [feed({ source: 'vessels/union', layer: 'vessels', entity_count: 109 })],
      attribution: [],
      toggleable: [],
      providers: [provider()],
    });

    expect(vessels!.state).toBe('live');
    expect(vessels!.detail).toBeNull();
  });

  it('puts the provider-attributable count on the row, zero included', () => {
    // ADR 010 wants "ships only this network can see" on screen as a measured number. Under
    // R3 in docs/pending-decisions.md the aircraft equivalent is zero until a key lands, and
    // the consequence written there is to report the zero rather than leave it absent.
    const vessels = row('vessels', {
      providers: [provider({ exclusive: 97 }), provider({ provider: 'aishub', exclusive: 0 })],
    });

    expect(vessels.coverage).toBe(
      'Seen by one provider alone: digitraffic only: 97, aishub only: 0',
    );
  });

  it('says nothing about coverage for a layer with no provider rows', () => {
    expect(row('aircraft', { providers: [provider()] }).coverage).toBeNull();
    expect(row('vessels').coverage).toBeNull();
  });

  it('drops the coverage line on an unavailable layer, which has no coverage to report', () => {
    const [vessels] = railRows({
      capabilities: [{ layer: 'vessels', available: false, reason: 'no provider configured' }],
      feeds: [],
      attribution: [],
      toggleable: [],
      providers: [provider({ exclusive: 4 })],
    });

    expect(vessels!.state).toBe('unavailable');
    expect(vessels!.coverage).toBeNull();
  });

  it('keeps two browser-side notices apart, which is what the disclosure needs', () => {
    // The two strings `/api/social` actually served on 2026-08-24, 115 and 100 characters. They
    // used to be joined with a middle dot in `main.ts` before the rail saw them, because this map
    // carried a `string`, so the row received one 218-character element. The shortening then cut
    // inside the first notice and the disclosure showed one run-on line instead of two rows, and
    // nothing here could have fixed it: the structure had been thrown away one file upstream.
    const first =
      'photograph search returned its maximum of 500 files, so this view holds the nearest of them rather than all of them';
    const second =
      'photographs searched within 10km of the centre of this view, which is as wide as the provider allows';

    const satellites = row('satellites', { notices: new Map([['satellites', [first, second]]]) });

    expect(satellites.notices).toStrictEqual([first, second]);
    expect(noticeSummary(satellites.notices)).toContain('(+1 more)');
    expect(noticesNeedDisclosure(satellites.notices)).toBe(true);
    // Both verbatim inside, neither shortened, and no middle dot joining them.
    expect(satellites.notices.every((text) => !text.includes(' · '))).toBe(true);
  });

  it('carries a browser-side notice onto its layer, alongside whatever the server said', () => {
    const satellites = row('satellites', {
      notices: new Map([['satellites', ['3 objects dropped: would not propagate.']]]),
    });

    // Only the propagator knows this: the server holds the element set and the browser is
    // the thing that refused it.
    expect(satellites.state).toBe('degraded');
    expect(satellites.detail).toBe('3 objects dropped: would not propagate.');
    expect(row('aircraft', { notices: new Map([['satellites', ['x']]]) }).detail).toBeNull();
  });
});

describe('LayerRail.setProviders', () => {
  beforeEach(() => {
    builds.count = 0;
    vi.stubGlobal('document', fakeDocument());
    vi.stubGlobal('window', fakeWindow().window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('paints the dropped provider and the coverage line without rebuilding a row', () => {
    const { root, rail } = mount();
    const before = builds.count;

    rail.setProviders([
      provider({ exclusive: 97 }),
      provider({ provider: 'aishub', records: 0, exclusive: 0, error: 'HTTP 500' }),
    ]);

    const vessels = root.select('rail-row')[2]!;
    expect(vessels.dataset['state']).toBe('degraded');
    // Two notices on this row, so they sit inside the disclosure with the summary naming the
    // first and counting the rest. The full text has to be in there verbatim: shortening is
    // for the summary line, never for the reason itself.
    expect(vessels.select('rail-notice-summary')[0]!.textContent).toContain('+2 more');
    expect(textOf(vessels, 'rail-notice').join(' ')).toContain('aishub dropped out: HTTP 500');
    expect(vessels.select('rail-coverage')[0]!.textContent).toContain('digitraffic only: 97');
    // A poll landing mid-keystroke must not take the focus ring off a switch, so the row
    // itself is the same node it was. Counting `createElement` cannot say that any more: a
    // notice appearing legitimately allocates the list items to hold it.
    expect(root.select('rail-row')[2]).toBe(vessels);
    // Three list items for the three notices, and nothing else: a rebuilt row would allocate
    // a switch, a name, a count and six more nodes per layer.
    expect(builds.count - before).toBe(3);
  });

  it('shows nothing under a row until the first fetch answers', () => {
    const { root } = mount();

    const vessels = root.select('rail-row')[2]!;
    expect(vessels.select('rail-coverage')[0]!.hidden).toBe(true);
  });
});

describe('countText', () => {
  it('shows the total when nothing knows what is in view', () => {
    // A layer this build has no renderer for. It used to be the satellite case too, on the
    // grounds that satellite positions live in the propagation worker's arrays rather than in a
    // slot with a longitude on it; the cluster grid holds the drawn marks, so that layer has a
    // real in-view count now and no longer reaches this branch.
    expect(countText(1234, null)).toBe('1,234');
  });

  it('shows the total once when everything held is on screen', () => {
    expect(countText(521, 521)).toBe('521');
  });

  it('shows both numbers when the camera cannot see what the server holds', () => {
    // The vessel layer over the Atlantic. "685" on its own reads as a broken renderer; this
    // says the ships are real and somewhere else.
    expect(countText(685, 0)).toBe('0 in view of 685');
    expect(countText(685, 12)).toBe('12 in view of 685');
  });

  it('says nothing when no feed reports on the layer', () => {
    expect(countText(null, 4)).toBe('');
  });

  it('shows the total alone when the browser is holding more than the server reported', () => {
    // Two clocks, not a discovery: the total is the server's last feed_status and the in-view
    // count is what the browser holds now, which keeps an entity until a removal reaches it.
    // "556 in view of 525" is a puzzle rather than an answer.
    expect(countText(525, 556)).toBe('525');
  });

  it('names the grouping when the layer is drawing badges', () => {
    // A badge is one mark standing for many, so a view that looks like forty marks has to say
    // it is forty groups and not forty ships.
    expect(countText(3878, 412, 41)).toBe('412 in view of 3,878 · 41 groups');
  });

  it('says nothing about grouping when nothing is grouped', () => {
    // Zero badges and a build with no clustering in it are the same thing to a reader, and a
    // row reading "· 0 groups" spends characters saying nothing.
    expect(countText(3878, 412, 0)).toBe('412 in view of 3,878');
    expect(countText(3878, 412)).toBe('412 in view of 3,878');
  });

  it('keeps the grouping on a row showing one number', () => {
    // A fully visible layer can still be grouped: the whole fleet on screen behind nine
    // badges is one number and a suffix, not a reason to drop the suffix.
    expect(countText(669, 669, 9)).toBe('669 · 9 groups');
    expect(countText(1234, null, 3)).toBe('1,234 · 3 groups');
  });

  it('reads singular when there is one group', () => {
    // Found by looking at a live rail rather than by a test: it said "27 in view of 199 · 1
    // groups". A count next to a plural noun reads as a bug in the copy, and this is the text on
    // the rail a viewer looks at most.
    expect(countText(199, 27, 1)).toBe('27 in view of 199 · 1 group');
    expect(countText(199, 27, 2)).toBe('27 in view of 199 · 2 groups');
  });

  it('groups the badge count itself, because four figures of them is possible', () => {
    expect(countText(90_000, 1200, 1041)).toBe('1,200 in view of 90,000 · 1,041 groups');
  });

  it('never lets the in-view figure become a count of badges', () => {
    // The rule the whole suffix exists to protect. `ClusterState.onScreen` counts a badge's
    // members one by one and asserts `onScreen === individuals + inGroups` at the source, so
    // the row states members against total and names the badges separately. A count of marks
    // here would have read "41 in view of 3,878" and under-reported the view ten times over.
    const text = countText(3878, 412, 41);

    expect(text).toContain('412 in view of');
    expect(text).not.toContain('41 in view of');
  });
});

/**
 * Standing gates against faults, which is the rail's priority problem rather than a wording one.
 *
 * A gate is a provider this deployment has no credential for, or one whose terms forbid what we
 * would do with it. It reads the same forever. A fault is worth reading now. The rail had two
 * healthy layers spending four lines of amber on gates while two absent layers shared one
 * collapsed line, and these are the tests for the split that fixes it.
 *
 * Nothing is deleted by any of this: every word stays one click away, because these strings are
 * licence and coverage facts rather than decoration.
 */
/**
 * The rail collapsing itself on a short viewport.
 *
 * Measured rather than guessed: the dock's content is 783px against a cap of `100vh - 96px`, so
 * the rail only fits whole above about 879px of viewport. Between there and 760 it overflows by
 * less than a row and the persistent scrollbar carries it. Below 760 a switch goes off the bottom,
 * and a control a viewer cannot see is the thing worth a click to reach.
 */
/**
 * The sweep line, which exists because dropped-and-counted has to mean counted somewhere a person
 * can read.
 *
 * The transit sweep refuses three reports for every one it keeps: 50,701 against 16,858 on live
 * data, and 38,708 of those are reports older than five minutes. That last number is what proves
 * the staleness bound is doing anything, and until now it was invisible on screen.
 *
 * The zeros test is not decoration. The refusal reasons used to be counted into the provider
 * tally, where each came out at zero, and the rail rendered "gtfs-rt/positioned at 0,0 only: 0"
 * five times over. A presenter that let a zero through would put that straight back.
 */
/** One live transit sweep, read off `/api/layers` on 2026-08-23. */
function makeSweep(overrides: Partial<SweepCoverage> = {}): SweepCoverage {
  return {
    layer: 'transit',
    provider: 'gtfs-rt',
    feeds: 258,
    read: 81,
    unchanged: 2,
    skipped: 175,
    failed: 0,
    records: 16_858,
    refused: [
      { reason: 'entity id repeated inside one message', count: 15 },
      { reason: 'positioned at 0,0', count: 579 },
      { reason: 'report older than 5 minutes', count: 38_708 },
      { reason: 'report timestamped in the future', count: 5 },
      { reason: 'reported without a position', count: 11_394 },
    ],
    ...overrides,
  };
}

describe('what the row total counts', () => {
  it('takes the store count over the feed count, because they are different numbers', () => {
    // Measured live 2026-08-24 on the transit row: the feed reported 12,483 and the store held
    // 17,548, a 1.9x gap with nothing on screen reconciling them. `entity_count` is what the last
    // sweep accepted, and transit fans out over 258 feeds with a per-host floor on each, so one
    // cycle asks a different subset every time while the store keeps the rest inside its TTL.
    const held = row('transit', {
      feeds: [feed({ source: 'transit/gtfsrt', layer: 'transit', entity_count: 12_483 })],
      held: new Map([['transit', 17_548]]),
    });

    expect(held.count).toBe(17_548);
  });

  it('stops the total swinging with the sweep rather than with the traffic', () => {
    // The same store, two cycles that were allowed to read different numbers of feeds. Sampled
    // 82 feeds read against 151, which moved `entity_count` by 1,152 while the store barely
    // moved. The row must not report a third of the fleet appearing and vanishing.
    const store = new Map([['transit', 17_300]]);
    const lean = row('transit', {
      feeds: [feed({ layer: 'transit', entity_count: 12_483 })],
      held: store,
    });
    const full = row('transit', {
      feeds: [feed({ layer: 'transit', entity_count: 13_635 })],
      held: store,
    });

    expect(lean.count).toBe(full.count);
  });

  it('falls back to the feed count before the first coverage fetch answers', () => {
    expect(row('aircraft', { feeds: [feed({ entity_count: 955 })] }).count).toBe(955);
  });

  it('never takes a store count for satellites, where the browser knows better', () => {
    // The propagator refuses an element set over 3.5 days old, so the server held 698 on
    // 2026-08-24 and the globe drew 676. `withDrawnSatelliteCount` puts 676 on the feed, and a
    // store count would put the 22 undrawn ones back on a row whose own notice says they are not
    // drawn. The exclusion lives in `heldCounts` so it cannot be forgotten at a call site.
    const summary = {
      feeds: [],
      layers: { aircraft: 955, satellites: 698, transit: 17_548 },
      providers: [],
      registries: [],
      sweeps: [],
    } satisfies LayerSummary;

    const counts = heldCounts(summary);

    expect(counts.get('satellites')).toBeUndefined();
    expect(counts.get('transit')).toBe(17_548);
    expect(counts.get('aircraft')).toBe(955);
  });

  it('says what a transit number is a number of, and nothing else does', () => {
    // AGENTS.md: 23.7% of GTFS-Realtime entity ids carry their own trip id, so a bus finishing a
    // trip reappears under a new key and a bare figure reads as a count of buses.
    expect(countText(17_264, 3876, 58, 'recent reports')).toBe(
      '3,876 in view of 17,264 recent reports · 58 groups',
    );
    expect(countText(17_264, null, 0, 'recent reports')).toBe('17,264 recent reports');
    // Every other layer counts the thing its label names.
    expect(countText(955, 400)).toBe('400 in view of 955');
  });
});

describe('the sweep line', () => {
  it('states the count without inventing a denominator', () => {
    expect(sweepSummary(makeSweep())).toBe('50,701 reports refused so far');
  });

  it('never divides the refusals by the store size, because they are two clocks', () => {
    // This is the mistake this line was shipped with for one iteration. Sampled against the live
    // backend 25 seconds apart, `refused` went 109,744 to 117,851 while `records` went 16,859 to
    // 17,190: the refusals accumulate for the life of the process and `records` is the store right
    // now. A ratio between them drifts towards 100 per cent the longer the server runs, whatever
    // the feeds do. Asserted by holding the refusals still and moving the store: the line must not
    // change, because nothing about the refusals did.
    const small = sweepSummary(makeSweep({ records: 100 }));
    const large = sweepSummary(makeSweep({ records: 1_000_000 }));

    expect(small).toBe(large);
    expect(small).not.toContain('67,559');
  });

  it('drops every zero, which is the bug this replaced', () => {
    const withZeros = makeSweep({
      refused: [
        { reason: 'report older than 5 minutes', count: 12 },
        { reason: 'positioned at 0,0', count: 0 },
        { reason: 'entity id repeated inside one message', count: 0 },
      ],
    });

    expect(sweepRefusals(withZeros).map(([reason]) => reason)).toEqual([
      'report older than 5 minutes',
    ]);
  });

  it('orders by count, not by the alphabet the API sends', () => {
    // The API sorts by reason, which puts 15 repeated ids ahead of 38,708 stale reports. The
    // number a reader wants is the biggest one.
    expect(sweepRefusals(makeSweep())[0]).toEqual(['report older than 5 minutes', 38_708]);
  });

  it('says nothing at all when a sweep refused nothing', () => {
    // An empty disclosure is still a 44px element and this rail has fourteen of those.
    expect(sweepSummary(makeSweep({ refused: [], failed: 0 }))).toBeNull();
    expect(sweepSummary(makeSweep({ refused: [{ reason: 'x', count: 0 }], failed: 0 }))).toBeNull();
  });

  it('names a failed read, which is the one a viewer might act on', () => {
    expect(sweepSummary(makeSweep({ failed: 1 }))).toBe(
      '50,701 reports refused so far · 1 feed read failed',
    );
  });

  it('counts failed reads rather than failed feeds, and says so', () => {
    // `failed` is on the same accumulating clock as `refused`, so one host failing on four cycles
    // is four here. "4 of 258 feeds failed" would imply four hosts.
    expect(sweepSummary(makeSweep({ refused: [], failed: 4 }))).toBe('4 feed reads failed');
    expect(sweepSummary(makeSweep({ refused: [], failed: 4 }))).not.toContain('258');
  });

  it('says nothing about read, unchanged or skipped', () => {
    // 81 read, 2 unchanged and 175 skipped is the rate discipline working: a skipped host is
    // inside its own politeness window and an unchanged one answered 304. "175 skipped" on a rail
    // invites a reader to conclude the layer is broken.
    const text = sweepSummary(makeSweep()) ?? '';

    expect(text).not.toContain('skipped');
    expect(text).not.toContain('unchanged');
    expect(text).not.toContain('175');
    expect(text).not.toContain('81');
  });

  it('groups the digits, because five-figure counts are what this reports', () => {
    expect(sweepLine('report older than 5 minutes', 38_708)).toBe(
      'report older than 5 minutes: 38,708',
    );
  });
});

describe('railCollapseLabel', () => {
  it('counts the layers behind it', () => {
    expect(railCollapseLabel(7, 0)).toBe('7 layers');
  });

  it('reads singular for one', () => {
    expect(railCollapseLabel(1, 0)).toBe('1 layer');
  });

  it('says how many are switched off, because that is what collapsing hides', () => {
    // The one fact a viewer cannot recover without opening it. Everything else behind the
    // disclosure is a count they can see on the globe.
    expect(railCollapseLabel(7, 2)).toBe('7 layers, 2 off');
  });

  it('says nothing about feed health, because the banner above it already does', () => {
    // The status banner is a separate element in the same column and stays visible when the rail
    // is collapsed, so repeating "1 of 5 feeds down" here would spend this one line on the one
    // fact already on screen.
    expect(railCollapseLabel(7, 2)).not.toContain('feed');
    expect(railCollapseLabel(7, 2)).not.toContain('down');
  });
});

describe('standing gates', () => {
  const GATES = [
    'adsbexchange missing: Paid key, and its terms prohibit redistribution',
    'airplanes.live missing: Access not granted',
  ];

  it('counts the gates instead of quoting one of them', () => {
    expect(noticeSummary(GATES, true)).toBe('2 providers unavailable');
  });

  it('reads properly for a single gate', () => {
    expect(noticeSummary([GATES[0]!], true)).toBe('1 provider unavailable');
  });

  it('still says the layer is narrower than it could be', () => {
    // The part that must not be lost. A row whose providers are gated is not a healthy row, and
    // a summary that said nothing would let it read as one.
    expect(noticeSummary(GATES, true)).not.toBe('');
    expect(noticeSummary(GATES, true)).toContain('unavailable');
  });

  it('quotes a fault rather than counting it', () => {
    // The other half of the split. "celestrak/gp down" will not say that next week, so it is
    // worth the row it takes.
    const faults = ['celestrak/gp down: no successful poll yet'];
    expect(noticeSummary(faults)).toBe('celestrak/gp down: no successful poll yet');
    expect(noticeSummary(faults, false)).toBe('celestrak/gp down: no successful poll yet');
  });

  it('collapses a lone gate however short it is', () => {
    // Otherwise the rule would depend on how many characters a provider's terms happen to
    // need, which is not a distinction a reader can see or would want.
    expect(noticesNeedDisclosure(['x missing: no key'], true)).toBe(true);
    expect(noticesNeedDisclosure(['x missing: no key'], false)).toBe(false);
  });

  it('leaves a row with no notices alone', () => {
    expect(noticesNeedDisclosure([], true)).toBe(false);
    expect(noticeSummary([], true)).toBe('');
  });

  it('defaults to the old behaviour, so a caller that knows nothing of gates is unchanged', () => {
    expect(noticeSummary(GATES)).toContain('adsbexchange missing');
    expect(noticeSummary(GATES)).toContain('(+1 more)');
  });

  it('takes the "(+N more)" suffix out of the budget rather than adding it on top', () => {
    // A real three-line overflow before this, measured in a browser at the rail's 354px and 14px.
    // The first notice was shortened to the full 72 and then 10 more characters of suffix were
    // appended, giving 80, and 80 characters of capitals and underscores is three lines: the
    // measured two-line limit for text of that shape is 73. Capital-heavy is not a corner case
    // here, because an environment variable name is most of what a gate reason is made of.
    const capitals = 'Set TRACKER_WINDY_API_KEY or TRACKER_TFL_APP_KEY or TRACKER_NY511_KEY now';

    const summary = noticeSummary([capitals, 'second', 'third']);

    expect(summary).toContain('(+2 more)');
    expect(summary.length).toBeLessThanOrEqual(73);
  });

  it('spends the whole budget when there is no suffix to pay for', () => {
    // The other half of the same rule: a lone notice must not be charged for a suffix it has not
    // got, or every single-notice row loses ten characters to nothing.
    expect(noticeSummary(['a'.repeat(200)]).length).toBe(NOTICE_SUMMARY_MAX + 1);
  });
});

describe('noticesNeedDisclosure', () => {
  it('leaves a single short reason on the row', () => {
    // Hiding "celestrak/gp down: no successful poll yet" behind a click would be worse than
    // the wall of text the disclosure exists to remove.
    expect(noticesNeedDisclosure(['celestrak/gp down: no successful poll yet'])).toBe(false);
  });

  it('collapses a reason too long to be a row', () => {
    // A literal length, not `NOTICE_SUMMARY_MAX + 1`, which is the test asking the implementation
    // what the answer is: move the constant and the expectation moves with it, so the assertion
    // survives the mutation it exists to catch. 73 is one past the measured two-line limit for a
    // capital-heavy reason, taken from rendered line boxes in a real browser, not from this module.
    expect(noticesNeedDisclosure(['x'.repeat(73)])).toBe(true);
    expect(NOTICE_SUMMARY_MAX).toBeLessThan(73);
  });

  it('collapses two reasons however short they are', () => {
    expect(noticesNeedDisclosure(['one down', 'two missing'])).toBe(true);
  });

  it('has nothing to collapse on a healthy layer', () => {
    expect(noticesNeedDisclosure([])).toBe(false);
  });
});

describe('noticeSummary', () => {
  it('is empty when there is nothing wrong', () => {
    expect(noticeSummary([])).toBe('');
  });

  it('counts the ones it is not showing, so the row never reads as healthier than it is', () => {
    expect(noticeSummary(['first thing', 'second thing', 'third thing'])).toBe(
      'first thing (+2 more)',
    );
  });

  it('cuts a long reason at a word rather than mid-word', () => {
    const long = `${'word '.repeat(30)}end`;
    const summary = noticeSummary([long]);

    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(NOTICE_SUMMARY_MAX + 1);
    expect(summary).not.toContain('wor…');
  });
});

describe('the heading a person reads', () => {
  it('calls the transit row trains and buses, not "Transit"', () => {
    // Alexander Fanthome asked to "ensure trains and busses are also tracked on the globe" while
    // 27,399 of them were tracked and this row was reporting them, so the heading was the defect.
    // Asserted rather than left to the map, because a label nobody tests is a label that reverts.
    // Its own capability list rather than the shared fixture, which carries no transit row: adding
    // one there would change what every other test in this file is handed.
    const rows = railRows({
      capabilities: [{ layer: 'transit', available: true, reason: null }],
      feeds: FEEDS,
      attribution: ATTRIBUTION,
      toggleable: TOGGLEABLE,
    });

    expect(rows.find((row) => row.layer === 'transit')?.label).toBe('Trains and buses');
  });

  it('still capitalises a layer that names itself, so the map stays the exception', () => {
    // The mutation this catches is someone routing every heading through the map and leaving the
    // rest undefined. Vessels, satellites and aircraft need no friendlier word and must not get one.
    const rows = railRows({
      capabilities: [
        { layer: 'vessels', available: true, reason: null },
        { layer: 'satellites', available: true, reason: null },
      ],
      feeds: FEEDS,
      attribution: ATTRIBUTION,
      toggleable: TOGGLEABLE,
    });

    expect(rows.find((row) => row.layer === 'vessels')?.label).toBe('Vessels');
    expect(rows.find((row) => row.layer === 'satellites')?.label).toBe('Satellites');
  });
});

describe('railRows in-view counts', () => {
  it('carries the browser count onto the row it belongs to', () => {
    const rows = railRows({
      capabilities: CAPABILITIES,
      feeds: FEEDS,
      attribution: ATTRIBUTION,
      toggleable: TOGGLEABLE,
      inView: new Map([['vessels', 0]]),
    });

    const vessels = rows.find((row) => row.layer === 'vessels');
    expect(vessels?.inView).toBe(0);
  });

  it('leaves a layer nothing counted as unknown rather than as zero', () => {
    const rows = railRows({
      capabilities: CAPABILITIES,
      feeds: FEEDS,
      attribution: ATTRIBUTION,
      toggleable: TOGGLEABLE,
      inView: new Map([['vessels', 4]]),
    });

    // "Nobody counted" and "counted, none there" are different statements, and the satellite
    // layer is the first: its positions live in the propagation worker's arrays.
    expect(rows.find((row) => row.layer === 'satellites')?.inView).toBeNull();
  });
});

describe('LayerRail and layers this build cannot draw', () => {
  beforeEach(() => {
    builds.count = 0;
    vi.stubGlobal('document', fakeDocument());
    vi.stubGlobal('window', fakeWindow().window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('collapses them behind one line that counts them', () => {
    const { root } = mount();

    // This fixture lists only aircraft and military as drawable, so vessels, satellites and
    // cameras all fall into the group. "Set a key" is a note to whoever runs this rather than
    // something a viewer is looking for, and three of those was a third of the rail.
    expect(root.select('rail-extra-summary')[0]!.textContent).toBe('3 layers not drawn here');
  });

  it('keeps their reasons intact inside it, not shortened away', () => {
    const { root } = mount();
    const cameras = root.select('rail-row').at(-1)!;

    expect(cameras.dataset['state']).toBe('unavailable');
    // Verbatim, not shortened: the summary line is the only thing that gets cut.
    expect(textOf(cameras, 'rail-notice')).toStrictEqual([CAMERAS_REASON]);
  });

  it('leaves the layers this build does draw in the rail itself', () => {
    const { root } = mount();

    // The running app lists vessels, satellites and cities as drawable, so those rows stay
    // on the rail even while one of them is unavailable: a viewer looking for satellites
    // needs the row that says why there are none, not a group labelled "not drawn".
    const railNames = root
      .select('rail-rows')[0]!
      .select('rail-name')
      .map((node) => node.textContent);
    expect(railNames).toStrictEqual(['Aircraft', 'Military']);
  });
});

describe('notDrawnLabel', () => {
  it('reads properly for one layer and for several', () => {
    expect(notDrawnLabel(1)).toBe('1 layer not drawn here');
    expect(notDrawnLabel(4)).toBe('4 layers not drawn here');
  });
});
