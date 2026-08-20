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

import { LayerRail, NO_REASON_GIVEN, railRows, unclaimedCredits } from './layer-rail';
import type {
  AttributionEntry,
  FeedHealth,
  LayerCapability,
  ProviderCoverage,
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
  },
  {
    source: 'adsb.fi',
    text: 'Aircraft failover data from adsb.fi',
    url: 'https://adsb.fi',
    licence: 'Non-commercial use',
  },
  {
    source: 'Fintraffic',
    text: 'Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
    url: 'https://www.digitraffic.fi',
    licence: 'CC BY 4.0',
  },
  {
    source: 'aisstream.io',
    text: 'Global vessel positions from aisstream.io',
    url: 'https://aisstream.io',
    licence: 'Provider terms, redistribution not granted; check before commercial use',
  },
  {
    source: 'AISHub',
    text: 'Vessel data from the AISHub contributor network',
    url: 'https://www.aishub.net',
    licence: 'Contributor terms, redistribution not granted',
  },
  {
    source: 'CelesTrak',
    text: 'Orbital element sets from CelesTrak',
    url: 'https://celestrak.org',
    licence: 'Not stated by the provider; credit is courtesy',
  },
  {
    source: 'NASA GIBS',
    text: 'Imagery courtesy of NASA EOSDIS GIBS',
    url: 'https://gibs.earthdata.nasa.gov',
    licence: 'Public domain, attribution requested',
  },
];

function collate(a: string, b: string): number {
  return a.localeCompare(b);
}

function feed(overrides: Partial<FeedHealth> = {}): FeedHealth {
  return {
    source: 'adsb.lol/point',
    layer: 'aircraft',
    healthy: true,
    entity_count: 1234,
    consecutive_failures: 0,
    poll_interval_seconds: 8,
    last_error: null,
    last_success_at: null,
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
    ...overrides,
  };
}

interface RowOverrides {
  feeds?: readonly FeedHealth[];
  providers?: readonly ProviderCoverage[];
  notices?: ReadonlyMap<string, string>;
}

function rows(overrides: RowOverrides = {}) {
  return railRows({
    capabilities: CAPABILITIES,
    feeds: overrides.feeds ?? FEEDS,
    attribution: ATTRIBUTION,
    toggleable: TOGGLEABLE,
    providers: overrides.providers,
    notices: overrides.notices,
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

  it('offers a switch only for a layer this build draws', () => {
    expect(row('aircraft').toggleable).toBe(true);
    expect(row('military').toggleable).toBe(true);
    // Not in the list this test passes in, so no switch. The running app draws vessels and
    // does list them; what is asserted here is that the list decides, never the server.
    expect(row('vessels').toggleable).toBe(false);
  });

  it('matches each layer to its credit through the API rather than a table', () => {
    expect(row('aircraft').credits.map((credit) => credit.source)).toStrictEqual(['adsb.lol']);
    expect(row('satellites').credits.map((credit) => credit.source)).toStrictEqual(['CelesTrak']);
    // Matched off the provider capability names, which are the only place the API says the
    // vessel layer has anything to do with either of these two.
    expect(row('vessels').credits.map((credit) => credit.source)).toStrictEqual([
      'aisstream.io',
      'AISHub',
    ]);
  });
});

describe('unclaimedCredits', () => {
  it('keeps a credit no layer claimed, so nothing ships uncredited', () => {
    const unclaimed = unclaimedCredits(rows(), ATTRIBUTION).map((credit) => credit.source);

    // The basemap has no layer of its own, the aircraft failover is not a capability, and
    // the API never names Fintraffic against the vessel layer. All three are licence
    // conditions and all three stay on screen.
    expect(unclaimed).toStrictEqual(['adsb.fi', 'Fintraffic', 'NASA GIBS']);
  });

  it('accounts for every credit the API served', () => {
    const railRowSet = rows();
    const claimed = new Set(
      railRowSet.flatMap((entry) => entry.credits.map((credit) => credit.source)),
    );
    for (const credit of unclaimedCredits(railRowSet, ATTRIBUTION)) {
      claimed.add(credit.source);
    }

    expect([...claimed].toSorted(collate)).toStrictEqual(
      ATTRIBUTION.map((credit) => credit.source).toSorted(collate),
    );
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

describe('LayerRail', () => {
  beforeEach(() => {
    builds.count = 0;
    // The rail builds its rows with `document.createElement`, so the runner needs one.
    vi.stubGlobal('document', fakeDocument());
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
    expect(cameras.select('rail-detail')[0]!.textContent).toBe(CAMERAS_REASON);
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

  it('shows the credits for each layer and keeps the unclaimed ones on screen', () => {
    const { root } = mount();

    expect(textOf(root, 'rail-credit')[0]).toBe('adsb.lol (ODbL 1.0)');
    const other = root.select('rail-other')[0]!;
    expect(other.hidden).toBe(false);
    expect(other.textContent).toContain('Fintraffic');
    expect(other.textContent).toContain('NASA GIBS');
  });

  it('runs before the API answers, with no capabilities and no feeds', () => {
    const root = new FakeElement('div');
    new LayerRail(asElement(root), { toggleable: TOGGLEABLE, onToggle: vi.fn() });

    // The switches exist from the first frame; the counts arrive with the first broadcast.
    expect(textOf(root, 'rail-name')).toStrictEqual(['Aircraft', 'Military']);
    expect(textOf(root, 'rail-count')).toStrictEqual(['', '']);
    expect(root.select('rail-other')[0]!.hidden).toBe(true);
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

  it('carries a browser-side notice onto its layer, alongside whatever the server said', () => {
    const satellites = row('satellites', {
      notices: new Map([['satellites', '3 objects dropped: would not propagate.']]),
    });

    // Only the propagator knows this: the server holds the element set and the browser is
    // the thing that refused it.
    expect(satellites.state).toBe('degraded');
    expect(satellites.detail).toBe('3 objects dropped: would not propagate.');
    expect(row('aircraft', { notices: new Map([['satellites', 'x']]) }).detail).toBeNull();
  });
});

describe('LayerRail.setProviders', () => {
  beforeEach(() => {
    builds.count = 0;
    vi.stubGlobal('document', fakeDocument());
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
    expect(vessels.select('rail-detail')[0]!.textContent).toContain('aishub dropped out: HTTP 500');
    expect(vessels.select('rail-coverage')[0]!.textContent).toContain('digitraffic only: 97');
    // A poll landing mid-keystroke must not take the focus ring off a switch.
    expect(builds.count).toBe(before);
  });

  it('shows nothing under a row until the first fetch answers', () => {
    const { root } = mount();

    const vessels = root.select('rail-row')[2]!;
    expect(vessels.select('rail-coverage')[0]!.hidden).toBe(true);
  });
});
