/**
 * The information card: a docked side panel, not a floating popup.
 *
 * Docked because the point of the card is to compare one aircraft against its
 * neighbours, and a popup covers exactly the neighbours you are looking at.
 *
 * Everything on it is either reported by the feed or derived from it, and the age of the
 * last fix is always on screen. A card that showed a position without its age would let a
 * frozen feed look live.
 */

import { FOLLOW_HINT } from '../globe/follow';
import { iconImage } from '../globe/icons';
import type { IconShape } from '../globe/icons';
import { CLASS_LABELS, colourFor } from '../globe/palette';
import { store } from '../state/store';
import type { TrackedAircraft } from '../state/store';
import type { Aircraft, AircraftDetail, AttributionEntry, EmergencyState } from '../types/entities';
import {
  NOT_ESTABLISHED,
  REGISTER_CAVEAT,
  absentReason,
  officerRows,
  officersAbsentText,
  ownershipRows,
  refusedText,
  unheldText,
  unprovenText,
} from './ownership';
import { aircraftLabel, inEmergency } from '../domain/derive';

/** Fallback feed cadence, matching the backend default for adsb.lol in seconds. */
export const DEFAULT_FEED_INTERVAL_SECONDS = 8;

const METRES_TO_FEET = 3.28084;

/** Shared with the vessel card, which leads with knots rather than showing them second. */
export const MPS_TO_KNOTS = 1.94384;

/** What both cards print for a field the feed did not report. Never a zero, never a dash. */
export const ABSENT = 'not reported';

/**
 * Whether an optional string actually carries something, narrowing it when it does.
 *
 * Three of these contracts distinguish absent from empty and one provider writes an empty string
 * where a null belongs, so `null`, `undefined` and `''` all mean the same thing to a reader and
 * none of them may reach a card as a blank value. Written as one comparison rather than three:
 * the chain is correct but trips `unicorn/prefer-includes-over-repeated-comparisons`, which this
 * codebase has now hit three times writing the same predicate by hand.
 */
export function hasText(value: string | null | undefined): value is string {
  return (value ?? '') !== '';
}

export type AgeSeverity = 'fresh' | 'amber' | 'red';

/**
 * How worried to be about a fix of this age.
 *
 * Two missed intervals is amber and four is red. One missed poll is normal: the feed
 * aggregates on its own cadence and a single gap says nothing. Four in a row means what is
 * on screen is no longer where the aircraft is.
 */
export function ageSeverity(
  ageSeconds: number,
  feedIntervalSeconds: number = DEFAULT_FEED_INTERVAL_SECONDS,
): AgeSeverity {
  if (ageSeconds > feedIntervalSeconds * 4) {
    return 'red';
  }
  if (ageSeconds > feedIntervalSeconds * 2) {
    return 'amber';
  }
  return 'fresh';
}

/** Age of a fix in words. Coarse on purpose: nobody needs milliseconds of staleness. */
export function formatAge(ageSeconds: number): string {
  const seconds = Math.max(0, Math.round(ageSeconds));
  if (seconds < 60) {
    return `${String(seconds)}s ago`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes)}m ${String(seconds % 60)}s ago`;
  }
  const hours = Math.floor(seconds / 3600);
  return `${String(hours)}h ${String(Math.floor((seconds % 3600) / 60))}m ago`;
}

/**
 * Seconds since the position fix, measured without trusting the browser clock against the
 * server's. The feed tells us how old the fix already was when it reached the server;
 * everything after that is elapsed local time.
 */
export function fixAgeSeconds(tracked: TrackedAircraft, nowMs: number = Date.now()): number {
  return tracked.aircraft.position_age_s + (nowMs - tracked.receivedAtMs) / 1000;
}

const EMERGENCY_TEXT: Record<EmergencyState, string> = {
  none: '',
  general: 'General emergency',
  lifeguard: 'Lifeguard / medical flight',
  minfuel: 'Minimum fuel',
  nordo: 'Radio failure',
  unlawful: 'Unlawful interference',
  downed: 'Downed aircraft',
  reserved: 'Emergency, reserved code',
};

/**
 * A Map, not an object literal.
 *
 * The squawk comes off the wire, so looking it up with `in` or `[]` on a plain object
 * would let a transponder reporting "constructor" or "__proto__" return something from
 * Object.prototype instead of null. A Map has no prototype chain to walk.
 */
const SQUAWK_TEXT: ReadonlyMap<string, string> = new Map([
  ['7500', 'Squawk 7500, unlawful interference'],
  ['7600', 'Squawk 7600, radio failure'],
  ['7700', 'Squawk 7700, general emergency'],
]);

/** The alert line, or null when the aircraft is not declaring anything. */
export function emergencyText(
  emergency: EmergencyState,
  squawk: string | null | undefined,
): string | null {
  const bySquawk = squawk === null || squawk === undefined ? undefined : SQUAWK_TEXT.get(squawk);
  if (bySquawk !== undefined) {
    return bySquawk;
  }
  return emergency === 'none' ? null : EMERGENCY_TEXT[emergency];
}

/** What the card prints for the LADD attribute when the provider's database does not flag it. */
export const NOT_FLAGGED = 'not flagged';

/** What the card prints while the registry lookup is still in flight. */
export const LOOKING_UP = 'looking up';

/** What the card prints when the register answered and does not hold the airframe. */
export const NOT_IN_REGISTER = 'not in this register';

/** What the card prints when the register holds the airframe and records no owner for it. */
export const NO_OWNER_RECORDED = 'held, no owner recorded';

/** What the card prints when the server no longer holds this aircraft. */
export const NOT_HELD = 'no longer tracked';

/** What the card prints when the request for the registry join did not complete. */
export const LOOKUP_FAILED = 'lookup failed, not retried';

/**
 * What we know about one aircraft's registry join, and the four states must stay four.
 *
 * `'pending'` is a request in flight, `'not-held'` is the server answering that it is no
 * longer holding this aircraft, `'unreachable'` is the request itself failing, and a
 * `AircraftDetail` is an answer. All three of the first were `null` before, and `null` read
 * as "looking up", so a failed request rendered as work in progress for as long as the card
 * stayed open and nothing retried it.
 */
export type OwnerLookup = 'pending' | 'not-held' | 'unreachable' | AircraftDetail;

/**
 * Every provider that reported this aircraft, freshest first.
 *
 * ADR 010 puts the provider on the record rather than on the layer, so a merged store can
 * be audited one aircraft at a time. `providers` is empty on a record no merge has touched,
 * and then the record's own `source` is the whole answer.
 */
export function providerText(record: Aircraft): string {
  return record.providers.length === 0 ? record.source : record.providers.join(', ');
}

/**
 * The owner line, and the six states behind it that must not be confused.
 *
 * A register that answered and does not hold the airframe is not a failure: about one live
 * aircraft in five is genuinely absent from it. A register that did not answer is a different
 * sentence, and a request that never completed is a third, because "no owner", "we could not
 * ask" and "we are still asking" would otherwise all read as "looking up".
 *
 * Whether the register holds the airframe is read off `registry`, never off the owner string.
 * The server keeps those apart deliberately (`api/routes_entities.py`: "registry is null in
 * two situations that must not be confused") and `owner` is optional by contract, so a held
 * record with no owner recorded used to print "not in this register" while the card footer
 * printed that register's own credit.
 */
export function ownerText(lookup: OwnerLookup): string {
  if (lookup === 'pending') {
    return LOOKING_UP;
  }
  if (lookup === 'not-held') {
    return NOT_HELD;
  }
  if (lookup === 'unreachable') {
    return LOOKUP_FAILED;
  }
  if (lookup.aircraft.owner !== null && lookup.aircraft.owner !== undefined) {
    return lookup.aircraft.owner;
  }
  if (lookup.degraded_reason !== null && lookup.degraded_reason !== undefined) {
    return `registry unavailable (${lookup.degraded_reason})`;
  }
  return lookup.registry === null || lookup.registry === undefined
    ? NOT_IN_REGISTER
    : NO_OWNER_RECORDED;
}

export interface InfoCardOptions {
  onClose: () => void;
  /**
   * Ask the server for this aircraft's registry join.
   *
   * Injected so the card can be built and driven with no network, and so the one call in
   * this app that makes the server touch an upstream is visible at the call site rather
   * than buried in a render method.
   */
  fetchDetail: (icao24: string) => Promise<AircraftDetail | null>;
}

export class InfoCard {
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly age: HTMLElement;
  private readonly fields: HTMLElement;
  private readonly ownership: HTMLElement;
  private readonly ownershipNote: HTMLElement;
  private readonly ownershipFields: HTMLElement;
  private readonly officers: HTMLElement;
  private readonly credit: HTMLElement;
  private tracked: TrackedAircraft | null = null;
  private lookup: OwnerLookup = 'pending';
  /**
   * The address whose registry answer we are currently waiting for.
   *
   * Compared against on arrival, so a slow answer for an aircraft the user has already
   * clicked away from is discarded instead of writing another aircraft's owner onto the
   * open card.
   */
  private awaiting: string | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private attribution: readonly AttributionEntry[] = [];
  private readonly root: HTMLElement;
  private readonly options: InfoCardOptions;

  constructor(root: HTMLElement, options: InfoCardOptions) {
    this.root = root;
    this.options = options;
    root.classList.add('card');
    root.setAttribute('aria-label', 'Selected aircraft');
    root.innerHTML = `
      <header class="card-head">
        <div class="card-identity">
          <div class="card-headings">
            <h2 class="card-title"></h2>
            <p class="card-subtitle"></p>
          </div>
        </div>
        <button type="button" class="card-close" aria-label="Close card, Escape">Close</button>
      </header>
      <p class="card-hint"></p>
      <p class="card-alert" role="alert" hidden></p>
      <p class="card-age" aria-live="polite"></p>
      <dl class="card-fields"></dl>
      <section class="card-ownership" hidden>
        <h3 class="card-ownership-head">Ownership</h3>
        <p class="card-ownership-note" hidden></p>
        <dl class="card-fields"></dl>
        <div class="card-officers"></div>
      </section>
      <footer class="card-credit"></footer>`;

    this.title = mustFind(root, '.card-title');
    this.subtitle = mustFind(root, '.card-subtitle');
    // Built here rather than written into the template above, so the element never exists
    // without a `src` on it. `show` paints it before the card is ever unhidden.
    this.icon = cardIconElement();
    mustFind(root, '.card-identity').prepend(this.icon);
    mustFind(root, '.card-hint').textContent = FOLLOW_HINT;
    this.alert = mustFind(root, '.card-alert');
    this.age = mustFind(root, '.card-age');
    this.fields = mustFind(root, '.card-fields');
    this.ownership = mustFind(root, '.card-ownership');
    this.ownershipNote = mustFind(root, '.card-ownership-note');
    this.ownershipFields = mustFind(root, '.card-ownership .card-fields');
    this.officers = mustFind(root, '.card-officers');
    this.credit = mustFind(root, '.card-credit');

    mustFind(root, '.card-close').addEventListener('click', () => {
      this.options.onClose();
    });
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.tracked !== null) {
        this.options.onClose();
      }
    });

    this.hide();
  }

  /** Licence credits, used to name the licence the card's data arrived under. */
  setAttribution(entries: readonly AttributionEntry[]): void {
    this.attribution = entries;
    if (this.tracked !== null) {
      this.show(this.tracked);
    }
  }

  show(tracked: TrackedAircraft | null): void {
    if (tracked === null) {
      this.hide();
      return;
    }
    const record = tracked.aircraft;
    if (this.tracked?.aircraft.icao24 !== record.icao24) {
      // A different aircraft, so the previous one's registry answer is not about this one.
      this.lookup = 'pending';
      this.requestDetail(record.icao24);
    }
    this.tracked = tracked;

    this.root.hidden = false;
    const colour = colourFor(record.aircraft_class, inEmergency(record));
    this.title.textContent = aircraftLabel(record);
    this.title.style.color = colour;
    // The same colour as the title, so the class and the emergency state carry into the icon
    // rather than being decoration beside them: military stays amber, an emergency stays red.
    // The shape mirrors the globe, including its refusal to draw an arrow for an aircraft that
    // reported no track. Unrotated here: the heading is a number, and the Track row states it
    // to the degree, where a glyph in a header could only approximate it less legibly.
    paintCardIcon(this.icon, aircraftIconShape(record), colour);
    this.subtitle.textContent = [
      CLASS_LABELS[record.aircraft_class],
      record.type_designator ?? 'type unknown',
      record.icao24.toUpperCase(),
    ].join(' · ');

    const alert = emergencyText(record.emergency, record.squawk);
    this.alert.hidden = alert === null;
    this.alert.textContent = alert ?? '';

    this.fields.replaceChildren(
      ...rows([
        ['Registration', record.registration ?? NOT_IN_REGISTER],
        ['Type', record.type_designator ?? ABSENT],
        ['Class', CLASS_LABELS[record.aircraft_class]],
        ['Registered owner', ownerText(this.lookup)],
        // Named per record, not per layer, and the report age is already on the age line
        // above. Two providers on one aircraft means the freshest of them supplied what is
        // on screen and both saw it.
        ['Reported by', providerText(record)],
        // An attribute, never a display block: ADR 009. False means this provider's database
        // does not flag the airframe, which is not the same as proof it is off the
        // programme, so the card says "not flagged" rather than "no".
        ['FAA LADD', record.on_ladd ? 'on the programme' : NOT_FLAGGED],
        [
          'Altitude',
          altitudeText(
            record.geometric_altitude_m ?? record.barometric_altitude_m,
            record.on_ground,
          ),
        ],
        ['Ground speed', speedText(record.ground_speed_mps)],
        ['Track', bearingText(record.track_deg)],
        ['Squawk', record.squawk ?? ABSENT],
        ['Message source', record.message_source],
        ['Position', `${record.point.lon.toFixed(4)}, ${record.point.lat.toFixed(4)}`],
      ]),
    );

    this.paintOwnership();

    this.credit.textContent = [
      creditFor(this.attribution, record.source),
      typeof this.lookup === 'string' ? null : this.lookup.registry_attribution,
    ]
      .filter((line) => line !== null && line !== undefined && line !== '')
      .join(' · ');
    this.refreshAge();
    // Once a second: the age is the one thing on the card that changes while nothing
    // else does, and it has to be seen to change or it is not doing its job.
    this.ticker ??= setInterval(() => {
      this.refreshAge();
    }, 1000);
  }

  /**
   * Fetch the registry join for one aircraft and redraw when it lands.
   *
   * A failure never removes the card. It is already on screen with everything the feed
   * reported, and losing the owner is a far smaller loss than losing the aircraft. What the
   * failure does do is say so on the owner line: nothing retries, so a swallowed rejection
   * left the card reading "looking up" for as long as it stayed open.
   *
   * A resolved `null` is the server saying it is no longer holding this aircraft, which is a
   * normal answer rather than an error, and a different one again.
   */
  private requestDetail(icao24: string): void {
    this.awaiting = icao24;
    void this.options
      .fetchDetail(icao24)
      .then((detail) => {
        this.settle(icao24, detail ?? 'not-held');
      })
      .catch(() => {
        this.settle(icao24, 'unreachable');
      });
  }

  /** Take one lookup outcome, if it is still the one the open card asked for. */
  private settle(icao24: string, lookup: OwnerLookup): void {
    if (this.awaiting !== icao24 || this.tracked === null) {
      return;
    }
    this.lookup = lookup;
    this.show(this.tracked);
  }

  hide(): void {
    this.tracked = null;
    this.lookup = 'pending';
    this.awaiting = null;
    this.root.hidden = true;
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /**
   * The ownership spine, or the reason there is none.
   *
   * Every decision here lives in `ui/ownership.ts` and is tested there. This method only paints:
   * if it starts deciding anything, in particular anything involving a confidence, it has taken
   * over a judgement that belongs on the server.
   */
  private paintOwnership(): void {
    const detail = typeof this.lookup === 'string' ? null : this.lookup;
    // While the request is in flight there is nothing to say and nothing to correct, so the
    // section stays out of the way rather than flashing an absence that is about to be filled.
    if (detail === null) {
      this.ownership.hidden = true;
      return;
    }
    const owned = detail.ownership ?? null;
    const absent = absentReason(owned);
    this.ownership.hidden = false;
    if (owned === null || absent !== null) {
      this.ownershipNote.hidden = true;
      this.ownershipFields.replaceChildren(...rows([['Ownership', absent ?? NOT_ESTABLISHED]]));
      this.officers.replaceChildren();
      return;
    }

    // The qualifier before the content, so a reader meets "not established" before any name.
    const unproven = unprovenText(owned);
    this.ownershipNote.hidden = unproven === null;
    this.ownershipNote.textContent = unproven ?? '';
    this.ownershipFields.replaceChildren(...rows([...ownershipRows(owned)]));

    const blocks: HTMLElement[] = [];
    // A dated negative rather than a blank: "this register, as of this date, does not hold it".
    const unheld = unheldText(owned);
    if (unheld !== null) {
      const note = document.createElement('p');
      note.className = 'card-ownership-absent';
      note.textContent = unheld;
      blocks.push(note);
    }
    // What the register is, whenever it named somebody. True of every row, so it claims nothing
    // about this one, and it is what stops "BANK OF UTAH TRUSTEE" reading as a bank that owns an
    // aeroplane.
    if (unheld === null) {
      const caveat = document.createElement('p');
      caveat.className = 'card-ownership-absent';
      caveat.textContent = REGISTER_CAVEAT;
      blocks.push(caveat);
    }
    // The server's own words for making no match, on the muted line rather than in the Match
    // value. See `refusedText`.
    const refused = refusedText(owned);
    if (refused !== null) {
      const note = document.createElement('p');
      note.className = 'card-ownership-absent';
      note.textContent = refused;
      blocks.push(note);
    }
    const missing = officersAbsentText(owned);
    if (missing !== null) {
      const note = document.createElement('p');
      note.className = 'card-ownership-absent';
      note.textContent = missing;
      blocks.push(note);
    }
    for (const person of owned.officers) {
      const block = document.createElement('dl');
      block.className = 'card-fields card-officer';
      block.replaceChildren(...rows([...officerRows(person, owned.wealth_tier_reason)]));
      blocks.push(block);
    }
    this.officers.replaceChildren(...blocks);
  }

  private refreshAge(): void {
    if (this.tracked === null) {
      return;
    }
    const seconds = fixAgeSeconds(this.tracked);
    const severity = ageSeverity(seconds, this.feedInterval(this.tracked.layer));
    this.age.textContent = `Last fix ${formatAge(seconds)}`;
    // Bracketed because `DOMStringMap` is an index signature: dotted access on one is
    // a typo waiting to happen, which is what noPropertyAccessFromIndexSignature says.
    this.age.dataset['severity'] = severity;
  }

  /**
   * The cadence of the feed this aircraft came from, so the amber and red thresholds match
   * reality rather than a hardcoded guess.
   *
   * Matched on LAYER, not on the aircraft's source. Every aircraft reports its source as
   * the provider (`adsb.lol`) whichever endpoint found it, so a prefix match against feed
   * names always resolved to whichever endpoint the health list happened to mention first.
   * That made the 32-second military feed judged against the 8-second viewport cadence,
   * and every healthy military aircraft cycled fresh to amber to red on each poll. Layer
   * is the real discriminator: the store already tracks it per aircraft and FeedHealth
   * already publishes it.
   */
  private feedInterval(layer: string): number {
    const feed = store.feeds.find((candidate) => candidate.layer === layer);
    return feed?.poll_interval_seconds ?? DEFAULT_FEED_INTERVAL_SECONDS;
  }
}

/**
 * The licence credit for one record's source, or a bare naming of the source when the API
 * credited nothing against it. A record is never shown with its source unnamed.
 */
export function creditFor(attribution: readonly AttributionEntry[], source: string): string {
  const entry = attribution.find((candidate) => candidate.source === source);
  if (entry === undefined) {
    return `Source: ${source}`;
  }
  return `${entry.text} (${entry.licence})`;
}

function altitudeText(metres: number | null | undefined, onGround: boolean): string {
  if (onGround) {
    return 'On ground';
  }
  if (metres === null || metres === undefined) {
    return ABSENT;
  }
  const feet = Math.round(metres * METRES_TO_FEET);
  return `${Math.round(metres).toLocaleString('en-GB')} m (${feet.toLocaleString('en-GB')} ft)`;
}

function speedText(mps: number | null | undefined): string {
  if (mps === null || mps === undefined) {
    return ABSENT;
  }
  return `${Math.round(mps).toLocaleString('en-GB')} m/s (${String(Math.round(mps * MPS_TO_KNOTS))} kt)`;
}

/**
 * A bearing in whole degrees clockwise from true north, which is the only bearing
 * convention in this project. One function for an aircraft's track and a vessel's course:
 * they are the same measurement of the same thing.
 */
export function bearingText(degrees: number | null | undefined): string {
  if (degrees === null || degrees === undefined) {
    return ABSENT;
  }
  return `${String(Math.round(degrees))}° true`;
}

/**
 * How big a card head icon is drawn, in pixels.
 *
 * Larger than any mark on the globe, and the arithmetic matters rather than the number. These
 * are drawn as the selected variant (see `paintCardIcon`), whose view box is 160 units against
 * the plain variant's 96, so the silhouette itself is 60 per cent of the figure here and the
 * rest is the halo and its casing. At 56 that is a 34px silhouette, against 29px for the
 * globe's largest mark, the 48px selected aircraft. A 44px icon would have looked bigger than
 * anything on the globe and drawn a silhouette smaller than an unselected one, which is the
 * opposite of what a card with room on it should do for a viewer with poor vision.
 *
 * A test asserts it against the palette rather than trusting this comment.
 */
export const CARD_ICON_PX = 56;

/**
 * The card head icon, with everything about it that never changes already set.
 *
 * An `<img>` pointed at the `data:` URL `globe/icons.ts` builds, rather than inline SVG
 * markup. Three reasons, in order. The geometry is generated once in one module, so a card and
 * the globe cannot disagree about what a ship looks like. `iconImage` bakes `sizePx` into the
 * SVG's own width and height, so the element renders at its intrinsic size with no sizing CSS
 * at all. And an `img` src takes no HTML parsing, where dropping SVG markup into the card
 * would mean `innerHTML` on a computed string, which is what `no-unsanitized` exists to stop.
 *
 * `alt` is empty on purpose. The icon is a second rendering of what the title and subtitle
 * beside it already say in words, so it is decorative in the accessibility sense, and a screen
 * reader announcing "aircraft" before reading "Aircraft · Boeing 737" is noise rather than
 * help. The state it carries in its colour is on the card as text too: an emergency has its
 * own alert line, and the class is named in the subtitle and in the Class row.
 */
export function cardIconElement(): HTMLElement {
  const image = document.createElement('img');
  image.className = 'card-icon';
  image.setAttribute('alt', '');
  image.setAttribute('width', String(CARD_ICON_PX));
  image.setAttribute('height', String(CARD_ICON_PX));
  return image;
}

/**
 * Point a card head icon at one shape and one fill.
 *
 * **Always the selected variant, and the reason is the construction rather than a ratio.** The
 * globe's marks are built for the NASA GIBS basemap: a bright fill carries the shape over dark
 * ocean and a thick black casing carries it over bright cloud, so between them one mark works
 * on both halves of the world. A card panel is `#0e141b`, which is near enough black that the
 * casing all but disappears into it, so on a card the fill is working alone and a dark fill has
 * nothing behind it. That is why a stopped vessel's `#4d6373` measures 2.95:1 here against the
 * 3:1 WCAG 1.4.11 asks of a graphical object, while every other fill in the app clears it
 * comfortably. The selected variant adds a white ring at 15.66:1, so the weak case stops
 * depending on its own hue at all.
 *
 * It is also the correct mark rather than a patch: a card is only ever open for the selected
 * entity, so the contrast fix falls out of drawing the truthful thing.
 *
 * **Do not close that 2.95:1 by lightening `STOPPED_COLOUR`.** It is the tempting one-line fix
 * and it is the wrong one. That constant is a state colour shared with the globe, where it
 * marks every stopped vessel on the map, so moving it to satisfy a card check would silently
 * repaint the globe to fix something the globe does not have. The hue is fine where it is used
 * against cloud; what changed is the background behind it.
 *
 * `src` rather than a replaced element, because the aircraft card repaints on every fix and a
 * fresh `img` per fix would drop and re-decode the image. `iconImage` returns the identical
 * string for the same arguments, so an unchanged icon is one assignment the browser ignores.
 */
export function paintCardIcon(icon: HTMLElement, shape: IconShape, fill: string): void {
  icon.setAttribute('src', iconImage(shape, fill, true, CARD_ICON_PX));
}

/**
 * The silhouette for one aircraft, mirroring what the globe draws for the same record.
 *
 * `disc` when no track was reported, `plane` when one was, keyed on the same field the layer
 * keys on (`layers/aircraft.ts` reads `record.track_deg ?? null` and branches on it), so the
 * card and the globe never show two different shapes for one aircraft.
 *
 * The card icon does not rotate, and an earlier version of this used that to justify drawing
 * `plane` for every record on the grounds that an unrotated mark claims no heading. That was
 * wrong twice over. The silhouette is a swept plan-view aircraft, so it is an arrow whether or
 * not a transform is applied to it, and a reader who has just watched the same shape point at
 * real headings on the globe has every reason to read its nose as one. And it would have put
 * the card and the globe in disagreement about the very records where the data is thinnest,
 * which is the opposite of why these shapes are imported from one module in the first place.
 * Half of live records arrive without `track`, so this is the common case rather than an edge.
 */
export function aircraftIconShape(record: Aircraft): IconShape {
  return record.track_deg === null || record.track_deg === undefined ? 'disc' : 'plane';
}

/** A definition list body, shared by both cards. */
export function rows(pairs: readonly [string, string][]): HTMLElement[] {
  return pairs.flatMap(([name, value]) => {
    const term = document.createElement('dt');
    term.textContent = name;
    const detail = document.createElement('dd');
    detail.textContent = value;
    return [term, detail];
  });
}

/**
 * A node the card's own template just wrote, or a thrown error.
 *
 * Shared by both cards: each builds its markup in its own constructor, so a miss here is a
 * mistake in that template and the selector is what names it.
 */
export function mustFind(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`card template is missing ${selector}`);
  }
  return found;
}
