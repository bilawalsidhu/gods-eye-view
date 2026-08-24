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
 * **Credits are not here any more.** They were, matched to rows from the API, with anything
 * unmatched listed under the rail. That was two more lines under every row plus a line under
 * the rail, and several of the API's licence fields are whole sentences, so it was the single
 * biggest thing on screen after the globe. The credits menu renders the API's whole list
 * instead, matched to nothing, which is a stronger guarantee than the matching ever was: a
 * source the backend adds cannot reach the screen uncredited whether or not anything here
 * recognises its name. The rail keeps the attribution list for one thing only, spelling a
 * provider slug the way its own credit does, `aishub` as `AISHub`.
 *
 * **Layers this build cannot draw are behind one control.** Cameras, buildings and places are
 * all "set a key", which is a note to whoever runs this rather than something a viewer is
 * looking for, and three of them was a third of the rail. They collapse into one line that
 * counts them, and every reason is one click away, unchanged.
 *
 * Counts come off the feed health the store already holds, which is the server's own count
 * per layer, the same number `/api/layers` reports. Nothing walks the entity set to count
 * it, and a toggle changes no count: switching a layer off hides it, it does not unsubscribe.
 */

import type {
  AttributionEntry,
  FeedHealth,
  LayerCapability,
  LayerSummary,
  LayerName,
  ProviderCoverage,
  SweepCoverage,
} from '../types/entities';
import { describeFeed, isFault } from './status';

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
   * The same notices, unjoined, so the row can show one and keep the rest behind a click.
   *
   * A provider reason from the API runs to three hundred characters, and the aircraft row
   * carries two of them. Rendered as one paragraph that is a wall of amber text over the
   * globe, which is how a healthy layer came to look like a broken one.
   */
  notices: readonly string[];
  /**
   * How many of this layer's entities the camera can currently see, or null when the
   * browser has no way to know.
   *
   * Null for a layer this build does not draw. Satellites used to be null here too, because
   * their positions live in the propagation worker's arrays rather than in a slot with a
   * longitude on it, and that is no longer a reason: the cluster grid projects every drawn
   * mark itself, so the layer knows what is on screen without anything holding a longitude.
   */
  inView: number | null;
  /**
   * How many cluster badges this layer is drawing, and zero when it is drawing none.
   *
   * On the row because a badge is one mark standing for many, and a count that silently
   * became a count of badges would be the layer under-reporting itself by a factor of forty.
   * Zero rather than null: a layer with no clustering and a layer with nothing grouped are
   * the same thing to a reader, which is nothing worth saying.
   */
  groups: number;
  /**
   * The sweep that produced this layer's records, or null when the layer has none.
   *
   * On the row because dropped-and-counted means counted somewhere a person can read. The transit
   * sweep refuses three reports for every one it keeps, 50,701 against 16,858 on live data, and
   * 38,708 of those are reports older than five minutes. That number is what proves the staleness
   * bound is doing anything, and it was invisible.
   */
  sweep: SweepCoverage | null;
  /**
   * The layer's own mark, as an image, or null for a layer that draws none.
   *
   * This is the legend, and it costs the dock nothing because it goes inside a 44px row that
   * already exists. The globe had no key at all: aircraft class and vessel state are carried by
   * hue, and nothing on screen said amber meant military, so a viewer could only learn the code
   * by clicking a mark and reading a card. Transit's magenta made that worse rather than better.
   *
   * A row rather than a panel, because a permanent legend is the thing that was complained about
   * and a hover is excluded. And it happens to teach the sharpest distinction for free: Military
   * has its own row, so an amber mark there against a grey-blue one on Aircraft is the mapping,
   * stated where a viewer is already looking.
   *
   * Supplied by `main.ts` rather than built here. The five colours live in `globe/palette.ts` and
   * in three layer modules, and importing those would drag Cesium into this file and into its
   * test for the sake of five strings. The bootstrap already imports every layer, so it is the
   * one place that can name all five without anyone taking on a dependency.
   *
   * What it does not cover: aircraft sub-classes and a vessel under way against a moored one.
   * Neither has a row to sit in, so both stay on the card, which is where they already were.
   */
  mark: string | null;
  /**
   * True when every notice on this row is a standing gate rather than a fault.
   *
   * A gate is a provider this deployment has no credential for, or one whose terms forbid
   * what we would do with it. It will read the same tomorrow and the day after, so quoting it
   * on the row spends two lines saying something a reader learns once. A fault is different:
   * `celestrak/gp down: no successful poll yet` is worth reading now, because it will not say
   * that next week.
   *
   * The rail had these the wrong way round. Measured 2026-08-23: two healthy layers spent four
   * lines of amber between them on gates that cannot change, while two layers that are absent
   * altogether shared one collapsed line. This is the flag that lets the gates collapse
   * without deleting a word of them, which matters because those strings are licence and
   * coverage facts: ADS-B Exchange really does prohibit redistribution and keyless AIS really
   * is northern Europe only.
   */
  gatesOnly: boolean;
  /**
   * Per-provider records only that provider saw, per ADR 010. Null when there is nothing
   * to say, which is every single-provider layer.
   *
   * Its own field rather than part of `detail`, because coverage is not a fault: a layer
   * showing an exclusive count is working exactly as intended.
   */
  coverage: string | null;
  /** True when this build has a renderer for it and can switch it off. */
  toggleable: boolean;
}

export interface RailInput {
  capabilities: readonly LayerCapability[];
  feeds: readonly FeedHealth[];
  attribution: readonly AttributionEntry[];
  /** Layers this build draws and can therefore switch off. */
  toggleable: readonly ToggleableLayer[];
  /**
   * Per-provider coverage from `/api/layers`, for the last cycle.
   *
   * Optional because it is absent until the first fetch answers, which is a real state at
   * first paint and not the same as a provider reporting nothing.
   */
  providers?: readonly ProviderCoverage[] | undefined;
  /**
   * Notices only the browser knows, keyed by layer, one array element per notice.
   *
   * The satellite layer is the one that has any: the server can say CelesTrak is
   * unreachable, but only the propagator knows how many element sets it refused this tick.
   *
   * **An array, and it was a single string, which quietly defeated everything below it.**
   * `RailRow.notices` says "the same notices, unjoined, so the row can show one and keep the rest
   * behind a click", and that was not true of anything arriving here: a `string` value cannot
   * carry two notices, so `main.ts` joined them with a middle dot before the rail ever saw them.
   * The social layer serves two, 115 and 100 characters, measured live on 2026-08-24, so what
   * reached the row builder was one 218-character element. `noticeSummary` then cut inside the
   * first notice at 72 and the disclosure showed a single run-on line rather than two legible
   * rows, and no amount of shortening or budgeting could have fixed it, because the structure the
   * shortening needed had already been thrown away one file upstream.
   *
   * A producer with one notice passes a one-element array, which is what every other producer
   * here does.
   */
  notices?: ReadonlyMap<string, readonly string[]> | undefined;
  /**
   * How many of each layer's entities are inside the current view, keyed by layer.
   *
   * Only the browser knows this, and it is the difference between "this layer is broken" and
   * "this layer's only keyless provider covers Finnish waters". A layer absent from the map
   * has no in-view count rather than a count of zero: those are different statements.
   */
  inView?: ReadonlyMap<string, number> | undefined;
  /**
   * How many cluster badges each layer is drawing, keyed by layer.
   *
   * Separate from `inView` rather than folded into one richer value, because the two answer
   * different questions and only one of them existed before: a layer absent here is drawing
   * no badges, which is the same as a build with no clustering in it at all.
   */
  groups?: ReadonlyMap<string, number> | undefined;
  /** Each layer's own mark as an image, keyed by layer. See `RailRow.mark`. */
  marks?: ReadonlyMap<string, string> | undefined;
  /** Sweep coverage from `/api/layers`, one entry per layer that sweeps. */
  sweeps?: readonly SweepCoverage[] | undefined;
  /**
   * How many records the server actually holds for each layer, from `/api/layers`.
   *
   * **It replaces the feed count because the feed count is a different number, and on the
   * transit row the difference was 1.9x with nothing on screen reconciling them.** A feed's
   * `entity_count` is what its last sweep accepted. For a layer polling one upstream those are
   * the same thing, near enough. Transit fans out over 258 feeds with a per-host floor on each,
   * so one cycle reads a different subset every time and the store legitimately holds vehicles
   * from feeds that cycle never asked. Sampled 2026-08-24 over a minute: `entity_count` swung
   * 12,483 at 82 feeds read against 13,635 at 151, while the store sat at 17,241 to 17,548
   * throughout. So the row was moving by a third while nothing about the buses changed, and it
   * disagreed with the provider records on its own row.
   *
   * The store count is the honest answer to "how many are there": it is what the server holds
   * and what the browser could be given. Left undefined until the first `/api/layers` answers,
   * which is a real state at first paint.
   *
   * **`satellites` is deliberately absent from this map**, not missed. There the browser knows
   * better than the server: the propagator refuses element sets over 3.5 days old, so the server
   * holds 698 and the globe draws 676, and `withDrawnSatelliteCount` already puts the drawn
   * figure on the feed. A store count would overwrite the smaller true one with the larger.
   */
  held?: ReadonlyMap<string, number> | undefined;
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
  const row = {
    layer,
    label: layerLabel(layer),
    coverage: exclusiveText(coverage),
    // Still gated on there being a feed at all: a row with no feed has no count today and
    // giving one to `cities` off the store map would be a different change on a different row.
    count:
      feeds.length === 0
        ? null
        : (input.held?.get(layer) ?? feeds.reduce((total, feed) => total + feed.entity_count, 0)),
    inView: input.inView?.get(layer) ?? null,
    groups: input.groups?.get(layer) ?? 0,
    mark: input.marks?.get(layer) ?? null,
    sweep: (input.sweeps ?? []).find((entry) => entry.layer === layer) ?? null,
    toggleable: (input.toggleable as readonly string[]).includes(layer),
  };

  if (capability !== undefined && !capability.available) {
    // Unavailable outranks everything else on the row: there is nothing to be degraded
    // about and no count worth showing, and the reason is the only useful thing to say.
    // Not marked as a gate: this row has no count and no switch, so its reason is the entire
    // content of the row and collapsing it would leave a label with nothing after it.
    const reason = capability.reason ?? NO_REASON_GIVEN;
    return {
      ...row,
      state: 'unavailable',
      coverage: null,
      detail: reason,
      notices: [reason],
      gatesOnly: false,
    };
  }

  // Reusing the banner's wording rather than writing a second vocabulary for the same
  // states, so a rate limit reads the same in both places.
  const failing = feeds
    .map((feed) => describeFeed(feed))
    // `isFault`, not `level !== 'live'`. A feed that has not polled yet is not live and is not a
    // fault either, and this row is for things that are wrong: putting "celestrak/gp not polled
    // yet" here would mark the satellite layer degraded while it draws 676 satellites off cache.
    .filter((notice) => isFault(notice))
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
  const detail = [...failing, ...dropped, ...missing, ...(input.notices?.get(layer) ?? [])];

  return {
    ...row,
    state: detail.length === 0 ? 'live' : 'degraded',
    detail: detail.length === 0 ? null : detail.join(' · '),
    notices: detail,
    // `missing` is the standing-gate bucket and it is already computed apart from the two
    // fault buckets, so the split this needs was latent in the code rather than guessed at.
    gatesOnly: detail.length > 0 && detail.length === missing.length,
  };
}

/**
 * The viewport height at or below which the rail collapses behind its own disclosure.
 *
 * 760, not the 879 the arithmetic gives for a rail that fits whole. Between the two the rail
 * overflows by less than a row and no switch is lost, so the persistent scrollbar is enough and
 * collapsing would be taking the rail away from every ordinary laptop to solve a problem those
 * laptops do not have. Below 760 a switch starts going off the bottom, which is the harm worth
 * a click.
 */
export const RAIL_COLLAPSE_MAX_HEIGHT_PX = 760;

/**
 * The line the collapsed rail shows.
 *
 * It has to say what is behind it and it has to say the thing being hidden that a viewer cannot
 * otherwise see, which is how many layers are switched off. Feed health is not in here on
 * purpose: the status banner sits above this in the same column, stays visible when the rail is
 * collapsed, and already carries "1 of 5 feeds down". Repeating it would spend the one line this
 * has on the one fact already on screen.
 */
export function railCollapseLabel(drawn: number, off: number): string {
  const layers = `${String(drawn)} ${drawn === 1 ? 'layer' : 'layers'}`;
  return off === 0 ? layers : `${layers}, ${String(off)} off`;
}

/**
 * The refusals on one sweep, largest first, with the zeros left out.
 *
 * Zeros left out because five of them on screen was the visible half of a real bug: the refusal
 * reasons were being counted into the provider tally, where every one came out at zero, and the
 * rail faithfully rendered "gtfs-rt/positioned at 0,0 only: 0" five times over. A presenter that
 * let a zero back through would put it straight back.
 *
 * Sorted by count rather than kept in the order the API sends them, which is alphabetical by
 * reason. The number a reader wants is the biggest one, and on live data that is not the first
 * alphabetically: 38,708 stale reports sort under "report older than 5 minutes", behind
 * "entity id repeated inside one message" at 15.
 */
export function sweepRefusals(sweep: SweepCoverage): readonly (readonly [string, number])[] {
  return sweep.refused
    .filter((entry) => entry.count > 0)
    .map((entry) => [entry.reason, entry.count] as const)
    .toSorted(([, left], [, right]) => right - left);
}

/**
 * The one line a collapsed sweep shows, or null when there is nothing to say.
 *
 * **No ratio, and that took a measurement to get right.** The obvious line is "N of M reports
 * refused", which is what this said first, and it is two clocks rather than one fact. Sampled
 * against the live backend 25 seconds apart: `refused` went from 109,744 to 117,851 while
 * `records` went from 16,859 to 17,190. The refusal counters accumulate for the life of the
 * process; `records` is the size of the store right now. Adding them produces a denominator that
 * is neither, and the ratio drifts towards 100 per cent the longer the server runs whatever the
 * feeds do. This file's own `countText` warns about exactly that shape for in-view against total,
 * and I walked into it one function later.
 *
 * So the count stands alone and says what it is. `read` is on the same clock as `refused` but
 * counts feed reads rather than reports, so there is no honest report-level denominator to offer.
 *
 * `failed` counts failed reads for the same reason, not distinct feeds, so it is not "N of 258"
 * either: one feed failing on four cycles is four here and the phrasing must not imply four hosts.
 *
 * `unchanged` and `skipped` are left out entirely. They are the rate discipline working, and "175
 * skipped" invites a reader to conclude the layer is broken when a skipped host is inside its own
 * politeness window and an unchanged one answered 304.
 */
export function sweepSummary(sweep: SweepCoverage): string | null {
  const refused = sweepRefusals(sweep).reduce((total, [, count]) => total + count, 0);
  const parts: string[] = [];
  if (refused > 0) {
    parts.push(`${refused.toLocaleString('en-GB')} reports refused so far`);
  }
  if (sweep.failed > 0) {
    const reads = sweep.failed.toLocaleString('en-GB');
    parts.push(`${reads} feed ${sweep.failed === 1 ? 'read' : 'reads'} failed`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** One refusal, as the row lists it when the line is expanded. */
export function sweepLine(reason: string, count: number): string {
  return `${reason}: ${count.toLocaleString('en-GB')}`;
}

/**
 * How big a legend mark is drawn in a rail row, in pixels.
 *
 * 24, which is larger than any mark the globe draws unselected: 26 for an aircraft, 22 for a
 * vessel, 20 for a satellite and 20 for a transit vehicle. Bigger than the smallest three on
 * purpose, because a key that is harder to read than the thing it explains is not a key, and it
 * sits inside a 44px row so it costs no height at all.
 */
export const RAIL_MARK_PX = 24;

/** The collapsed group's label. Singular reads properly, and one of these is common. */
export function notDrawnLabel(count: number): string {
  return `${String(count)} ${count === 1 ? 'layer' : 'layers'} not drawn here`;
}

/**
 * How long a notice can be before the row shows a shortened form and keeps the rest behind
 * a click.
 *
 * Two lines at 14px in the rail's 24rem. Three lines of amber under a row is the wall of text
 * this exists to remove.
 *
 * **72 stays, and this comment exists because I measured it in order to raise it and could not.**
 * The reason for measuring was sound: the old comment here claimed the only thing shortening would
 * ever hit was the "set this environment variable" notes, which run past 150, and that is wrong.
 * The social notice is 115 characters whose second half carries the entire meaning, and at 72 it
 * reads "…so this view holds…", which tells a reader a ceiling was hit and nothing about what it
 * means for the view in front of them.
 *
 * So I measured rendered line boxes in a real browser at the real 354px and 14px, rather than
 * counting characters. How many characters actually fit two lines:
 *
 *     all-caps text                                61
 *     "Set TRACKER_WINDY_API_KEY or TRACKER_..."   73   ← a third key added to a real reason
 *     the same reason as it stands today           74
 *     "Set TRACKER_CONTACT_EMAIL. Nominatim..."    94
 *     aishub gate                                 103
 *     airplanes.live                              106
 *     social 500-cap                              109
 *     typical prose                               108
 *     narrow lowercase                            119
 *
 * **The limit varies by nearly two to one with the glyphs, so no fixed character count is
 * correct, and 72 is about as high as one can safely go.** Capitals and underscores are the
 * problem and this rail is full of them, because environment variable names are what a gate
 * reason names. 94 looked safe against every string the live API serves and I nearly shipped it:
 * what stopped it was `CAMERAS_REASON` in the test file, a reason of the same shape one key
 * longer, which renders three lines at anything above 73. The strings I had sampled were the ones
 * the running server happened to be sending, which excluded exactly the class the old comment had
 * named.
 *
 * So the social notice is not fixed here. The informative half has to come first in the string
 * itself, which is the backend's to change. The layout-correct alternative is `line-clamp: 2`,
 * which needs a span inside the `summary` and moves the disclosure decision out of a pure
 * function into a layout query, and that is not worth it for a line whose full text is already
 * one click away.
 *
 * If the rail's width or font size ever changes, every number above is stale.
 */
export const NOTICE_SUMMARY_MAX = 72;

/**
 * Cut to the last word that fits, so the shortened form is not a severed word.
 *
 * Takes its own budget because the caller may have a suffix to fit on the same two lines, and
 * appending one after shortening spends characters the budget already promised away.
 */
function shorten(text: string, max: number = NOTICE_SUMMARY_MAX): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Whether a row's notices need a disclosure, or fit on the row as they are.
 *
 * One short notice is shown outright: hiding "celestrak/gp down: no successful poll yet"
 * behind a click would be worse than the wall of text this replaces.
 */
export function noticesNeedDisclosure(notices: readonly string[], gatesOnly = false): boolean {
  if (gatesOnly && notices.length > 0) {
    // Whatever its length. A lone short gate shown inline would make the rule depend on how
    // many characters a provider's terms happen to need, which is not a distinction a reader
    // can see or would want.
    return true;
  }
  const only = notices.length === 1 ? notices[0] : undefined;
  return notices.length > 1 || (only !== undefined && only.length > NOTICE_SUMMARY_MAX);
}

/**
 * The line a collapsed set of notices shows.
 *
 * Names the first one and counts the rest, so the row never reads as healthier than it is.
 *
 * Unless they are all standing gates, in which case it counts them and quotes none. The row
 * still says the layer is narrower than it could be, which is the part that must not be lost;
 * what it stops doing is spending two lines on a sentence that will not change. Every word is
 * still there, one click away, and `gatesOnly` is what decides which of the two this is.
 */
export function noticeSummary(notices: readonly string[], gatesOnly = false): string {
  const first = notices[0];
  if (first === undefined) {
    return '';
  }
  if (gatesOnly) {
    const count = notices.length;
    return count === 1 ? '1 provider unavailable' : `${String(count)} providers unavailable`;
  }
  if (notices.length === 1) {
    return shorten(first);
  }
  // **The suffix comes out of the same two lines, so it comes out of the same budget.** This was
  // a real three-line overflow, not a precaution: appending after shortening to the full budget
  // spends 72 characters and then 10 more, and measured in a real browser
  // "Set TRACKER_WINDY_API_KEY or TRACKER_TFL_APP_KEY or TRACKER_NY511_KEY…" plus " (+2 more)"
  // renders 80 characters over three lines. Budgeting the suffix brings the same row back to two.
  // Found while measuring whether `NOTICE_SUMMARY_MAX` could be raised; it could not, and this
  // was next door to it.
  const suffix = ` (+${String(notices.length - 1)} more)`;
  return `${shorten(first, NOTICE_SUMMARY_MAX - suffix.length)}${suffix}`;
}

/**
 * The count on a row, which is two different numbers when they disagree.
 *
 * A layer can be live, healthy and reporting hundreds of entities while the camera is
 * pointed at an ocean none of them is in. "685" over an empty globe reads as a broken
 * renderer; "0 in view of 685" is the true statement and it tells the user to move the
 * camera rather than to file a bug. Equal numbers are shown once: "685 in view of 685" is
 * noise.
 *
 * **The in-view figure counts movers, never badges.** When a layer groups, one mark on the
 * globe stands for many, so a count of marks would under-report a busy view by whatever the
 * biggest badge holds. `ClusterState.onScreen` counts a badge's members one by one and
 * `onScreen === individuals + inGroups` is asserted at the source, which is what lets this
 * say both halves without them ever disagreeing.
 *
 * The badge count rides as a suffix and only when there is one, because a badge already shows
 * its own number on the globe: the row exists to say the picture is grouped, not to repeat
 * what the picture says. Nothing is said about the largest group, which would be a third
 * number on a row that has to stay readable.
 */
export function countText(
  count: number | null,
  inView: number | null,
  groups = 0,
  noun = '',
): string {
  if (count === null) {
    return '';
  }
  const of = noun === '' ? '' : ` ${noun}`;
  // Singular when there is one, like `notDrawnLabel` below. "1 groups" reads as a bug in the
  // copy, and on a rail this is the text a viewer looks at most.
  const grouped =
    groups > 0 ? ` · ${groups.toLocaleString('en-GB')} group${groups === 1 ? '' : 's'}` : '';
  const total = count.toLocaleString('en-GB');
  // `inView >= count` is not a discovery, it is two clocks. The total is the server's last
  // `feed_status`; the in-view count is what the browser is holding now, and the browser
  // keeps an entity until a removal reaches it. So a surplus means the layer is fully on
  // screen as far as anyone here can tell, and "556 in view of 525" would be a puzzle rather
  // than an answer.
  if (inView === null || inView >= count) {
    return `${total}${of}${grouped}`;
  }
  return `${inView.toLocaleString('en-GB')} in view of ${total}${of}${grouped}`;
}

/**
 * What a row's number is a number of, where the obvious noun would be wrong.
 *
 * Only transit, and AGENTS.md requires it: 23.7% of GTFS-Realtime `FeedEntity.id` values contain
 * their own trip id, and on Entur it is all of them, so a bus finishing a trip reappears under a
 * new key while the finished one sits in the store until it expires. A bare "17,264" therefore
 * reads as a count of buses and is not one. Every other row counts the thing its label names: an
 * aircraft has an ICAO address for as long as it is flying.
 *
 * A word on the number rather than a sentence beside it, because the row has three elements
 * already and the qualifier is worth nothing if it is not next to the figure it qualifies.
 */
const COUNT_NOUN: ReadonlyMap<string, string> = new Map([['transit', 'recent reports']]);

/**
 * The layer a store count must never be taken for, and the reason is that the browser knows more.
 *
 * The propagator refuses an element set over 3.5 days old, so the server holds more satellites
 * than the globe draws: 698 against 676, measured 2026-08-24. `withDrawnSatelliteCount` puts the
 * drawn figure on the feed, and taking the store count here would quietly undo it and report 22
 * satellites that are not on screen, on the one row that also carries a notice saying they are not
 * being drawn.
 */
const BROWSER_KNOWS_BETTER = 'satellites';

/**
 * The per-layer store counts from `/api/layers`, ready for `RailInput.held`.
 *
 * Here rather than in `main.ts` because `main.ts` is excluded from coverage by design, and the
 * satellite exclusion below is exactly the kind of one-line rule that is invisible until it is
 * wrong.
 */
export function heldCounts(summary: LayerSummary): ReadonlyMap<string, number> {
  return new Map(
    Object.entries(summary.layers).filter(([layer]) => layer !== BROWSER_KNOWS_BETTER),
  );
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
  // One provider means every record it saw, it saw alone, so the line restates the count in
  // more words. It is the difference between two providers that ADR 010 is about, and a
  // single-provider union is every layer this build currently serves.
  if (coverage.length < 2) {
    return null;
  }
  const parts = coverage.map((entry) => `${entry.provider} only: ${String(entry.exclusive)}`);
  return `Seen by one provider alone: ${parts.join(', ')}`;
}

/**
 * A layer this build can draw and therefore switch off.
 *
 * `LayerName` plus `cities` and `clouds`, spelled out rather than taken from the contract,
 * because the backend keeps both out of that union on purpose: `LayerName` is the set of
 * layers the WebSocket carries deltas for, and neither a weekly gazetteer file nor a NASA
 * tile pyramid has any. Written as a literal union rather than `string` so a typo in the
 * list below is still a compile error.
 */
/**
 * A layer this build can switch, which is more than the socket carries.
 *
 * `LayerName` is the set the WebSocket delivers deltas for. Three layers are drawn without being
 * in it and each for its own reason: cities are a weekly file with no deltas to send, clouds are
 * imagery fetched straight from NASA, and social posts are a viewport query against a provider
 * rather than a store the server holds.
 */
export type ToggleableLayer = LayerName | 'cities' | 'clouds' | 'social';

export interface LayerRailOptions {
  /**
   * Layers this build draws, in the order they should be listed.
   *
   * Only these get a switch. A layer the server offers but this build has no renderer for
   * is listed with its count and no switch, rather than a switch that does nothing.
   */
  toggleable: readonly ToggleableLayer[];
  onToggle: (layer: ToggleableLayer, visible: boolean) => void;
  /**
   * Each layer's own mark as an image, keyed by layer. Optional, and a build that omits it gets
   * the rail it had before, which is what keeps every existing test unchanged.
   *
   * In the constructor rather than in `update`, because a layer's mark never changes. Passing it
   * per repaint would mean rebuilding an identical map several times a second.
   */
  marks?: ReadonlyMap<string, string> | undefined;
}

interface RowNodes {
  root: HTMLElement;
  /**
   * The notices the list currently holds, joined.
   *
   * A repaint runs on every socket batch and on every camera move, and the notices change on
   * almost none of them. Without this, one list item per notice is allocated several times a
   * second for text that has not changed.
   */
  painted: string;
  count: HTMLElement;
  /** One short notice, shown outright. */
  detail: HTMLElement;
  /** The disclosure used instead when there is more than one notice, or a long one. */
  notices: HTMLElement;
  noticeSummary: HTMLElement;
  noticeList: HTMLElement;
  coverage: HTMLElement;
  sweep: HTMLDetailsElement;
  sweepSummary: HTMLElement;
  sweepList: HTMLElement;
}

export class LayerRail {
  private readonly list: HTMLElement;
  private readonly extra: HTMLElement;
  private readonly extraSummary: HTMLElement;
  private readonly extraList: HTMLElement;
  private readonly options: LayerRailOptions;
  private readonly collapse: HTMLDetailsElement;
  private readonly collapseSummary: HTMLElement;
  private readonly short: MediaQueryList;
  /** Rows with a switch, so the collapsed line can count them without rebuilding. */
  private drawnCount = 0;
  private readonly nodes = new Map<string, RowNodes>();
  /** Layers the user has switched off. Survives a rebuild, which capabilities trigger once. */
  private readonly hidden = new Set<string>();
  private capabilities: readonly LayerCapability[] = [];
  private attribution: readonly AttributionEntry[] = [];
  private feeds: readonly FeedHealth[] = [];
  private providers: readonly ProviderCoverage[] = [];
  private sweeps: readonly SweepCoverage[] = [];
  private held: ReadonlyMap<string, number> = new Map();
  private notices: ReadonlyMap<string, readonly string[]> = new Map();
  private inView: ReadonlyMap<string, number> = new Map();
  private groups: ReadonlyMap<string, number> = new Map();
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
    // Layers this build cannot draw, behind one control. "Set a key" is a note to whoever
    // runs this rather than something a viewer is looking for, and three of them was a third
    // of the rail's height.
    this.extra = document.createElement('details');
    this.extra.className = 'rail-extra';
    this.extraSummary = document.createElement('summary');
    this.extraSummary.className = 'rail-extra-summary';
    this.extraList = document.createElement('ul');
    this.extraList.className = 'rail-rows';
    this.extra.append(this.extraSummary, this.extraList);
    // The whole rail behind one disclosure, opened or closed by viewport height.
    //
    // Measured 2026-08-23: this column's content is 783px and the dock caps itself at
    // `100vh - 96px`, so the rail only fits whole at a viewport 879px tall or more. Below that it
    // scrolls, and at 700px the Clouds switch is off the bottom while at 620px, which is a 720p
    // projector, Satellites, Cities and Clouds all are. A persistent scrollbar is the cue for
    // that; this is the answer. Collapsed, every switch is one click away instead of behind a
    // scroll a viewer has no reason to suspect.
    //
    // The threshold is a media query rather than a measurement, deliberately. This rail repaints
    // on every socket batch and every camera move, so reading `scrollHeight` in that path would
    // force a reflow several times a second to answer a question that changes only when the
    // window does. A fixed breakpoint is occasionally a pixel out; a reflow in the paint path is
    // wrong every frame.
    this.collapse = document.createElement('details');
    this.collapse.className = 'rail-collapse';
    this.collapseSummary = document.createElement('summary');
    this.collapseSummary.className = 'rail-collapse-summary';
    const body = document.createElement('div');
    body.className = 'rail-collapse-body';
    body.append(this.list, this.extra);
    this.collapse.append(this.collapseSummary, body);
    root.append(this.collapse);
    // `matchMedia` rather than a resize listener: it fires only when the answer changes, and it
    // gives the initial state without measuring anything.
    this.short = window.matchMedia(`(max-height: ${String(RAIL_COLLAPSE_MAX_HEIGHT_PX)}px)`);
    this.collapse.open = !this.short.matches;
    this.short.addEventListener('change', (event) => {
      this.collapse.open = !event.matches;
    });
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
  update(
    feeds: readonly FeedHealth[],
    notices: ReadonlyMap<string, readonly string[]> = new Map(),
    inView: ReadonlyMap<string, number> = new Map(),
    groups: ReadonlyMap<string, number> = new Map(),
  ): void {
    this.feeds = feeds;
    this.notices = notices;
    this.inView = inView;
    this.groups = groups;
    const rows = this.rows();
    if (this.identity(rows) === this.built) {
      this.paintAll(rows);
      return;
    }
    this.build();
  }

  /**
   * Layers the user has switched off, in rail order.
   *
   * Exposed for the URL state, which has to write what is off without keeping a second copy
   * of it. The rail owns this: the checkboxes are the thing on screen that states it.
   */
  get hiddenLayers(): readonly string[] {
    return this.options.toggleable.filter((layer) => this.hidden.has(layer));
  }

  /**
   * Switch exactly these layers off and the rest on, because a shared URL said so.
   *
   * A name this build cannot draw is ignored rather than treated as an error: a link from a
   * deployment that has a layer this one does not must still open, and on a layer nobody
   * recognises there is nothing to switch. A layer that is here but unavailable keeps the
   * request, which is why this reads the toggleable list rather than the capability list:
   * hiding something that is serving nothing costs nothing, and the request survives being
   * passed on to somebody whose deployment can serve it.
   */
  hide(layers: readonly string[]): void {
    let changed = false;
    for (const layer of this.options.toggleable) {
      const visible = !layers.includes(layer);
      if (visible !== this.hidden.has(layer)) {
        continue;
      }
      if (visible) {
        this.hidden.delete(layer);
      } else {
        this.hidden.add(layer);
      }
      this.options.onToggle(layer, visible);
      changed = true;
    }
    // One rebuild for the lot, and only when something actually changed: this runs at first
    // paint, where the answer is usually that nothing is hidden.
    if (changed) {
      this.build();
    }
  }

  /**
   * Per-provider coverage from `/api/layers`, replacing the last set.
   *
   * Paints in place like `update` does: the row set does not change, so a poll landing
   * mid-keystroke must not take the focus ring off a switch.
   */
  setProviders(
    providers: readonly ProviderCoverage[],
    sweeps: readonly SweepCoverage[] = [],
    held: ReadonlyMap<string, number> = new Map(),
  ): void {
    this.providers = providers;
    this.sweeps = sweeps;
    this.held = held;
    this.paintAll(this.rows());
  }

  /**
   * The sweep line, or nothing at all.
   *
   * Hidden rather than empty when a layer does not sweep or refused nothing, because an empty
   * disclosure is still a 44px element and this rail has fourteen of those already.
   *
   * Rebuilt only when the text changes. `/api/layers` is polled every sixty seconds and this is
   * five list items, so without the guard it would be five allocations a minute for text that
   * usually has not moved.
   */
  private paintSweep(nodes: RowNodes, row: RailRow): void {
    const sweep = row.sweep;
    const summary = sweep === null ? null : sweepSummary(sweep);
    if (sweep === null || summary === null) {
      nodes.sweep.hidden = true;
      return;
    }
    nodes.sweep.hidden = false;
    if (nodes.sweepSummary.textContent === summary) {
      return;
    }
    nodes.sweepSummary.textContent = summary;
    nodes.sweepList.replaceChildren(
      ...sweepRefusals(sweep).map(([reason, count]) => {
        const line = document.createElement('li');
        line.textContent = sweepLine(reason, count);
        return line;
      }),
    );
  }

  /** Paint every row against nodes that already exist. */
  private paintAll(rows: readonly RailRow[]): void {
    for (const row of rows) {
      this.paint(row);
    }
  }

  /**
   * The collapsed line, which has to follow a switch as well as a rebuild.
   *
   * A switch moving changes the "N off" half and nothing else on the rail, and `toggled` does not
   * rebuild, so without this the collapsed summary would state the count from whenever
   * `/api/capabilities` last answered.
   */
  private paintCollapseSummary(): void {
    this.collapseSummary.textContent = railCollapseLabel(this.drawnCount, this.hidden.size);
  }

  private rows(): RailRow[] {
    return railRows({
      capabilities: this.capabilities,
      feeds: this.feeds,
      attribution: this.attribution,
      toggleable: this.options.toggleable,
      providers: this.providers,
      sweeps: this.sweeps,
      held: this.held,
      notices: this.notices,
      inView: this.inView,
      groups: this.groups,
      marks: this.options.marks,
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
    // Rows this build draws stay in the rail. Everything else, a layer with no renderer or
    // no key, goes behind one line that counts them.
    const drawn = rows.filter((row) => row.toggleable);
    const rest = rows.filter((row) => !row.toggleable);
    this.list.replaceChildren(...drawn.map((row) => this.createRow(row)));
    this.extraList.replaceChildren(...rest.map((row) => this.createRow(row)));
    this.extra.hidden = rest.length === 0;
    this.extraSummary.textContent = rest.length === 0 ? '' : notDrawnLabel(rest.length);
    this.drawnCount = drawn.length;
    this.paintCollapseSummary();
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
    // Before the name, so the eye meets the mark and then what it means. Decorative to a screen
    // reader: the row's own text already names the layer, and "image, aircraft, Aircraft" is
    // noise rather than help.
    if (row.mark !== null) {
      const mark = document.createElement('img');
      mark.className = 'rail-mark';
      mark.setAttribute('alt', '');
      mark.setAttribute('src', row.mark);
      mark.setAttribute('width', String(RAIL_MARK_PX));
      mark.setAttribute('height', String(RAIL_MARK_PX));
      head.append(mark);
    }
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

    // One element, not one per reason. Five lines of refusal counts is the thing that was just
    // removed from this rail; a line that expands says the same and costs a row.
    const sweep = document.createElement('details');
    sweep.className = 'rail-sweep';
    const sweepSummaryNode = document.createElement('summary');
    sweepSummaryNode.className = 'rail-sweep-summary';
    const sweepList = document.createElement('ul');
    sweepList.className = 'rail-sweep-list';
    sweep.append(sweepSummaryNode, sweepList);

    const detail = document.createElement('p');
    detail.className = 'rail-detail';
    // A `details` element rather than a button and a panel: the browser owns the open state,
    // the keyboard and telling a screen reader whether it is expanded. Two of these were
    // holding three hundred characters of provider reason open over the globe.
    const notices = document.createElement('details');
    notices.className = 'rail-notices';
    const noticeSummaryNode = document.createElement('summary');
    noticeSummaryNode.className = 'rail-notice-summary';
    const noticeList = document.createElement('ul');
    noticeList.className = 'rail-notice-list';
    notices.append(noticeSummaryNode, noticeList);
    const coverage = document.createElement('p');
    coverage.className = 'rail-coverage';
    // After the coverage block: both are muted facts about the feed rather than faults, and
    // the refusals only make sense once a reader has the counts above them.
    item.append(head, detail, notices, coverage, sweep);

    const nodes: RowNodes = {
      root: item,
      painted: '',
      count,
      detail,
      notices,
      noticeSummary: noticeSummaryNode,
      noticeList,
      coverage,
      sweep,
      sweepSummary: sweepSummaryNode,
      sweepList,
    };
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
      row.state === 'unavailable'
        ? ''
        : countText(row.count, row.inView, row.groups, COUNT_NOUN.get(row.layer) ?? '');
    // One of the two, never both: a short notice reads on the row, and anything longer or
    // plural goes behind the disclosure with the whole text intact inside it.
    this.paintSweep(nodes, row);
    const expandable = noticesNeedDisclosure(row.notices, row.gatesOnly);
    nodes.detail.hidden = expandable || row.notices.length === 0;
    nodes.detail.textContent = expandable ? '' : (row.detail ?? '');
    nodes.notices.hidden = !expandable;
    nodes.noticeSummary.textContent = expandable ? noticeSummary(row.notices, row.gatesOnly) : '';
    const painted = expandable ? row.notices.join('\n') : '';
    if (painted !== nodes.painted) {
      nodes.painted = painted;
      nodes.noticeList.replaceChildren(
        ...row.notices.map((notice) => {
          const line = document.createElement('li');
          line.className = 'rail-notice';
          line.textContent = notice;
          return line;
        }),
      );
    }
    nodes.coverage.hidden = row.coverage === null;
    nodes.coverage.textContent = row.coverage ?? '';
  }

  /**
   * Switching a layer off costs one attribute and one call.
   *
   * No refetch, no rebuild of the rail, and nothing recomputed: the layer itself stops
   * drawing. Switching it back on shows the picture the store has kept all along.
   */
  private toggled(layer: ToggleableLayer, item: HTMLElement, visible: boolean): void {
    if (visible) {
      this.hidden.delete(layer);
    } else {
      this.hidden.add(layer);
    }
    item.dataset['visible'] = String(visible);
    this.paintCollapseSummary();
    this.options.onToggle(layer, visible);
  }
}
