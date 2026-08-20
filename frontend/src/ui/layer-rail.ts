/**
 * The layer rail: one row per layer, with its live count and its real state.
 *
 * Three things here are the point, and each one exists to stop a specific lie on screen.
 *
 * A layer that cannot run renders as unavailable **with the reason the server gave**, never
 * as a row reading zero. "Ships 0" and "Ships unavailable: AISHub needs a receiver-backed
 * username" are different statements, and only one of them is true when a provider is
 * unconfigured. The reason text is never written here: it comes from `/api/capabilities`.
 *
 * A layer whose feed is degraded names what is missing, and it names two different kinds of
 * missing. `/api/capabilities` lists a merged layer's providers separately
 * (`vessels/aishub`), which says whether a provider is **configured**. `/api/layers` carries
 * the provider rows from the last cycle, which say whether a configured provider actually
 * **answered**. ADR 010 requires both: a provider that errors drops out of the union and the
 * layer reports itself degraded naming it, and a provider that was never configured is a
 * different sentence. A configured provider failing every cycle used to be invisible here.
 *
 * The provider-attributable count rides on the same rows, and ADR 010 asks for it on screen:
 * "ships only this network can see" is a measured number, not a claim.
 *
 * The credits are licence conditions and are matched to rows from the API, never from a
 * table in here. Anything the matching does not claim is rendered under the rail regardless,
 * so a source added to the backend cannot reach the screen uncredited.
 *
 * Counts come off the feed health the store already holds, which is the server's own count
 * per layer, the same number `/api/layers` reports. Nothing walks the entity set to count
 * it, and a toggle changes no count: switching a layer off hides it, it does not unsubscribe.
 */

import type {
  AttributionEntry,
  FeedHealth,
  LayerCapability,
  LayerName,
  ProviderCoverage,
} from '../types/entities';
import { describeFeed } from './status';

export type RailState = 'live' | 'degraded' | 'unavailable';

/** Shown when the API says a layer or provider is off but sends no reason with it. */
export const NO_REASON_GIVEN = 'no reason given';

/** Separates a merged layer from one of its providers in a capability name. */
const PROVIDER_SEPARATOR = '/';

export interface RailRow {
  layer: string;
  label: string;
  state: RailState;
  /** The server's count for this layer, or null when no feed reports on it. */
  count: number | null;
  /** Why it is unavailable, or what is missing when it is degraded. Null when all is well. */
  detail: string | null;
  /**
   * Per-provider records only that provider saw, per ADR 010. Null when there is nothing
   * to say, which is every single-provider layer.
   *
   * Its own field rather than part of `detail`, because coverage is not a fault: a layer
   * showing an exclusive count is working exactly as intended.
   */
  coverage: string | null;
  credits: readonly AttributionEntry[];
  /** True when this build has a renderer for it and can switch it off. */
  toggleable: boolean;
}

export interface RailInput {
  capabilities: readonly LayerCapability[];
  feeds: readonly FeedHealth[];
  attribution: readonly AttributionEntry[];
  /** Layers this build draws and can therefore switch off. */
  toggleable: readonly LayerName[];
  /**
   * Per-provider coverage from `/api/layers`, for the last cycle.
   *
   * Optional because it is absent until the first fetch answers, which is a real state at
   * first paint and not the same as a provider reporting nothing.
   */
  providers?: readonly ProviderCoverage[] | undefined;
  /**
   * Notices only the browser knows, keyed by layer.
   *
   * The satellite layer is the one that has any: the server can say CelesTrak is
   * unreachable, but only the propagator knows how many element sets it refused this tick.
   */
  notices?: ReadonlyMap<string, string> | undefined;
}

/**
 * Comparable form of a source name.
 *
 * The API names the same source three ways: a credit calls it `adsb.lol`, a feed calls
 * itself `adsb.lol/point` and a capability calls a provider `vessels/aishub`. Reducing all
 * three to letters and digits is what lets one be recognised in another without a mapping
 * table that a new source could be left out of.
 */
function token(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z\d]/g, '');
}

/** Whether two names from different parts of the API refer to the same source. */
function related(left: string, right: string): boolean {
  const a = token(left);
  const b = token(right);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

/** Layer names are lower case on the wire; this is a heading. */
function layerLabel(layer: string): string {
  return layer.charAt(0).toUpperCase() + layer.slice(1);
}

/** The provider part of `vessels/aishub`, which is `aishub`. */
function providerSlug(capability: LayerCapability): string {
  return capability.layer.slice(capability.layer.lastIndexOf(PROVIDER_SEPARATOR) + 1);
}

/** A provider named as its own credit calls it where one exists, `aishub` as `AISHub`. */
function providerName(
  capability: LayerCapability,
  attribution: readonly AttributionEntry[],
): string {
  const slug = providerSlug(capability);
  return attribution.find((entry) => related(entry.source, slug))?.source ?? slug;
}

/**
 * One row per layer: the renderable layers first, then anything else the server reports.
 *
 * Both API sources contribute a layer, capabilities and feed health, so a layer the backend
 * has started serving cannot be missing from the rail because one of the two has not caught
 * up. Capability entries naming a provider are folded into their layer's row rather than
 * given one of their own, because a provider is not a layer and a rail listing
 * `vessels/aishub` next to `vessels` would read as two fleets.
 */
export function railRows(input: RailInput): RailRow[] {
  const advertised = input.capabilities
    .filter((entry) => !entry.layer.includes(PROVIDER_SEPARATOR))
    .map((entry) => entry.layer);
  const reporting = input.feeds.map((feed) => feed.layer);
  const names = new Set<string>([...input.toggleable, ...advertised, ...reporting]);
  return [...names].map((layer) => buildRow(layer, input));
}

function buildRow(layer: string, input: RailInput): RailRow {
  const prefix = layer + PROVIDER_SEPARATOR;
  const capability = input.capabilities.find((entry) => entry.layer === layer);
  const providers = input.capabilities.filter((entry) => entry.layer.startsWith(prefix));
  const feeds = input.feeds.filter((feed) => feed.layer === layer);
  const coverage = (input.providers ?? []).filter((entry) => entry.layer === layer);
  // The provider slug, not the whole capability name: `vessels/aisstream` shares no
  // recognisable token with the credit for `aisstream.io`, but `aisstream` does.
  const identities = [
    layer,
    ...providers.map((entry) => providerSlug(entry)),
    ...feeds.map((health) => health.source),
  ];

  const row = {
    layer,
    label: layerLabel(layer),
    coverage: exclusiveText(coverage),
    count: feeds.length === 0 ? null : feeds.reduce((total, feed) => total + feed.entity_count, 0),
    credits: input.attribution.filter((entry) =>
      identities.some((identity) => related(entry.source, identity)),
    ),
    toggleable: (input.toggleable as readonly string[]).includes(layer),
  };

  if (capability !== undefined && !capability.available) {
    // Unavailable outranks everything else on the row: there is nothing to be degraded
    // about and no count worth showing, and the reason is the only useful thing to say.
    return {
      ...row,
      state: 'unavailable',
      coverage: null,
      detail: capability.reason ?? NO_REASON_GIVEN,
    };
  }

  // Reusing the banner's wording rather than writing a second vocabulary for the same
  // states, so a rate limit reads the same in both places.
  const failing = feeds
    .map((feed) => describeFeed(feed))
    .filter((notice) => notice.level !== 'live')
    .map((notice) => notice.text);
  const missing = providers
    .filter((entry) => !entry.available)
    .map(
      (entry) =>
        `${providerName(entry, input.attribution)} missing: ${entry.reason ?? NO_REASON_GIVEN}`,
    );
  // A provider that answered with an error, from the last cycle rather than from the
  // configuration. This is the ADR 010 clause: the union drops it and the layer says which.
  const dropped = coverage
    .filter((entry) => entry.error !== null && entry.error !== undefined)
    .map((entry) => `${entry.provider} dropped out: ${entry.error ?? NO_REASON_GIVEN}`);
  const notice = input.notices?.get(layer);
  const detail = [...failing, ...dropped, ...missing, ...(notice === undefined ? [] : [notice])];

  return {
    ...row,
    state: detail.length === 0 ? 'live' : 'degraded',
    detail: detail.length === 0 ? null : detail.join(' · '),
  };
}

/**
 * The provider-attributable counts for one layer, or null when there is nothing to say.
 *
 * Zero is said out loud rather than hidden. Under R3 in `docs/pending-decisions.md` the
 * aircraft layer's unfiltered coverage is zero until a key lands, and ADR 010's own
 * consequence is to report the zero rather than leave the number absent. A provider that
 * saw nothing exclusively is a measurement.
 */
function exclusiveText(coverage: readonly ProviderCoverage[]): string | null {
  if (coverage.length === 0) {
    return null;
  }
  const parts = coverage.map((entry) => `${entry.provider} only: ${String(entry.exclusive)}`);
  return `Seen by one provider alone: ${parts.join(', ')}`;
}

/**
 * Credits no row claimed.
 *
 * The basemap has no layer of its own and a provider the API does not name against its
 * layer will not match one either. Both still have to be on screen: an unmatched credit is
 * a rendering question, never a reason to drop a licence condition.
 */
export function unclaimedCredits(
  rows: readonly RailRow[],
  attribution: readonly AttributionEntry[],
): AttributionEntry[] {
  const claimed = new Set(rows.flatMap((row) => row.credits.map((credit) => credit.source)));
  return attribution.filter((entry) => !claimed.has(entry.source));
}

export interface LayerRailOptions {
  /**
   * Layers this build draws, in the order they should be listed.
   *
   * Only these get a switch. A layer the server offers but this build has no renderer for
   * is listed with its count and no switch, rather than a switch that does nothing.
   */
  toggleable: readonly LayerName[];
  onToggle: (layer: LayerName, visible: boolean) => void;
}

interface RowNodes {
  root: HTMLElement;
  count: HTMLElement;
  detail: HTMLElement;
  coverage: HTMLElement;
  credit: HTMLElement;
}

export class LayerRail {
  private readonly list: HTMLElement;
  private readonly other: HTMLElement;
  private readonly options: LayerRailOptions;
  private readonly nodes = new Map<string, RowNodes>();
  /** Layers the user has switched off. Survives a rebuild, which capabilities trigger once. */
  private readonly hidden = new Set<string>();
  private capabilities: readonly LayerCapability[] = [];
  private attribution: readonly AttributionEntry[] = [];
  private feeds: readonly FeedHealth[] = [];
  private providers: readonly ProviderCoverage[] = [];
  private notices: ReadonlyMap<string, string> = new Map();
  private built = '';

  constructor(root: HTMLElement, options: LayerRailOptions) {
    this.options = options;
    root.classList.add('rail');
    // A group rather than a landmark: these are controls over the globe, not a section of
    // the document. Named so a screen reader announces what the switches belong to.
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Layers');
    this.list = document.createElement('ul');
    this.list.className = 'rail-rows';
    this.other = document.createElement('p');
    this.other.className = 'rail-other';
    root.append(this.list, this.other);
    this.build();
  }

  /**
   * What this deployment can serve, and the credits it must display.
   *
   * The row set can change here, so this is the one call that rebuilds. It happens once,
   * when `/api/capabilities` answers.
   */
  setCapabilities(
    layers: readonly LayerCapability[],
    attribution: readonly AttributionEntry[],
  ): void {
    this.capabilities = layers;
    this.attribution = attribution;
    this.build();
  }

  /**
   * New feed health, read from the store.
   *
   * Mutates the rows in place. Rebuilding the rail on every broadcast would throw away the
   * focus ring of whichever switch the keyboard was on.
   */
  update(feeds: readonly FeedHealth[], notices: ReadonlyMap<string, string> = new Map()): void {
    this.feeds = feeds;
    this.notices = notices;
    const rows = this.rows();
    if (this.identity(rows) === this.built) {
      for (const row of rows) {
        this.paint(row);
      }
      return;
    }
    this.build();
  }

  /**
   * Per-provider coverage from `/api/layers`, replacing the last set.
   *
   * Paints in place like `update` does: the row set does not change, so a poll landing
   * mid-keystroke must not take the focus ring off a switch.
   */
  setProviders(providers: readonly ProviderCoverage[]): void {
    this.providers = providers;
    for (const row of this.rows()) {
      this.paint(row);
    }
  }

  private rows(): RailRow[] {
    return railRows({
      capabilities: this.capabilities,
      feeds: this.feeds,
      attribution: this.attribution,
      toggleable: this.options.toggleable,
      providers: this.providers,
      notices: this.notices,
    });
  }

  /** The row set, so `update` can tell a changed picture from a changed set of layers. */
  private identity(rows: readonly RailRow[]): string {
    return rows.map((row) => `${row.layer}:${String(row.toggleable)}`).join(',');
  }

  private build(): void {
    const rows = this.rows();
    this.built = this.identity(rows);
    this.nodes.clear();
    this.list.replaceChildren(...rows.map((row) => this.createRow(row)));
    const unclaimed = unclaimedCredits(rows, this.attribution);
    this.other.hidden = unclaimed.length === 0;
    this.other.textContent =
      unclaimed.length === 0
        ? ''
        : `Also credited: ${unclaimed.map((entry) => creditText(entry)).join(', ')}`;
  }

  private createRow(row: RailRow): HTMLElement {
    const item = document.createElement('li');
    item.className = 'rail-row';

    // The switch is a real checkbox: tab-reachable and toggled by space with nothing
    // written here, which is a great deal more than a div with a click handler manages.
    // A row with nothing to switch gets a plain element, because a label with no control
    // in it is a label for nothing.
    const toggle = this.options.toggleable.find((candidate) => candidate === row.layer);
    const switched = toggle !== undefined && row.state !== 'unavailable';
    const head = document.createElement(switched ? 'label' : 'div');
    head.className = 'rail-head';
    const name = document.createElement('span');
    name.className = 'rail-name';
    name.textContent = row.label;
    const count = document.createElement('span');
    count.className = 'rail-count';

    if (toggle !== undefined && switched) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'rail-switch';
      input.checked = !this.hidden.has(row.layer);
      input.addEventListener('change', () => {
        this.toggled(toggle, item, input.checked);
      });
      head.append(input);
    }
    head.append(name, count);

    const detail = document.createElement('p');
    detail.className = 'rail-detail';
    const coverage = document.createElement('p');
    coverage.className = 'rail-coverage';
    const credit = document.createElement('p');
    credit.className = 'rail-credit';
    item.append(head, detail, coverage, credit);

    const nodes: RowNodes = { root: item, count, detail, coverage, credit };
    this.nodes.set(row.layer, nodes);
    this.paint(row);
    return item;
  }

  /**
   * Apply one layer's state to nodes that already exist.
   *
   * Bracketed dataset access because `DOMStringMap` is an index signature, as everywhere
   * else in this UI.
   */
  private paint(row: RailRow): void {
    const nodes = this.nodes.get(row.layer);
    if (nodes === undefined) {
      return;
    }
    nodes.root.dataset['state'] = row.state;
    nodes.count.textContent =
      row.state === 'unavailable' || row.count === null ? '' : row.count.toLocaleString('en-GB');
    nodes.detail.hidden = row.detail === null;
    nodes.detail.textContent = row.detail ?? '';
    nodes.coverage.hidden = row.coverage === null;
    nodes.coverage.textContent = row.coverage ?? '';
    nodes.credit.hidden = row.credits.length === 0;
    nodes.credit.textContent = row.credits.map((entry) => creditText(entry)).join(', ');
  }

  /**
   * Switching a layer off costs one attribute and one call.
   *
   * No refetch, no rebuild of the rail, and nothing recomputed: the layer itself stops
   * drawing. Switching it back on shows the picture the store has kept all along.
   */
  private toggled(layer: LayerName, item: HTMLElement, visible: boolean): void {
    if (visible) {
      this.hidden.delete(layer);
    } else {
      this.hidden.add(layer);
    }
    item.dataset['visible'] = String(visible);
    this.options.onToggle(layer, visible);
  }
}

function creditText(entry: AttributionEntry): string {
  return `${entry.source} (${entry.licence})`;
}
