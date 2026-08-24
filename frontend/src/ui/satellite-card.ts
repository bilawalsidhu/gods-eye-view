/**
 * The satellite information card.
 *
 * Same docked side panel as the aircraft card in `card.ts` and the vessel card in
 * `vessel-card.ts`, same class names so it inherits their styling, and everything both of
 * those do the same way is imported from `card.ts` rather than restated: the age wording,
 * the fresh/amber/red thresholds, the definition-list body, the credit line and the
 * not-reported text.
 *
 * Three things make this card different from the two mover cards, and all three are
 * honesty rather than decoration.
 *
 * **The position is computed here, and the card says so.** An aircraft or a ship reports a
 * position and we relay it. A satellite reports nothing: the backend serves an orbital
 * element set and this browser runs SGP4 over it, so what is on screen is our arithmetic on
 * CelesTrak's orbit determination. A card that printed a satellite position the way it
 * prints an aircraft position would be claiming an observation nobody made. So the computed
 * position sits on its own line, labelled as computed, separate from the definition list,
 * which holds only what CelesTrak published.
 *
 * **The age shown is the age of the element set, not the age of the propagation.** The
 * propagation is always a millisecond old and saying so would be meaningless. What decides
 * whether the dot is anywhere near the object is how long ago the elements were fitted, and
 * an element set propagated a year past its epoch returns a clean success and a plausible
 * altitude (`globe/satellites/orbit.ts`). So the epoch age is the age line, and red lands
 * exactly where the propagator stops drawing the object.
 *
 * **CelesTrak grants no licence and the card must not invent one.** The credit is a
 * courtesy the provider asks for, which is what `app.py` ATTRIBUTIONS records, and the
 * record's own `source` is the host our copy came through rather than the origin. Both are
 * named. See `satelliteCreditText`.
 *
 * There is no follow hint and no title colour. Follow mode holds a mover the store is
 * tracking and a satellite is not in the store, so the hint would be a lie about an
 * affordance. The layer has exactly one hue, so a coloured title would encode nothing the
 * subtitle does not already say while reading at lower contrast than the card's own text.
 *
 * The card needs its own root element, not either mover card's. Each of these classes owns
 * its root's markup, so two of them on one element leaves the first holding detached nodes.
 */

// The one hue the satellite layer draws, imported rather than restated, so the card and the
// globe cannot drift apart on it. No bundle cost: the layer is already in the main bundle
// through `main.ts`.
import { SATELLITE_COLOUR } from '../globe/layers/satellites';
import {
  ABSENT,
  ageSeverity,
  cardIconElement,
  creditFor,
  formatAge,
  paintCardIcon,
  rows,
} from './card';
import type { AttributionEntry, Satellite } from '../types/entities';

/**
 * The attribution `source` CelesTrak's element sets are credited under.
 *
 * Not the same string as the record's own `source`, and that gap is the whole reason this
 * constant exists. `Satellite.source` is whichever host served our copy: `retlector`,
 * `satvisor` or `celestrak`, the three provider rows in `sources/celestrak.py`. The credit
 * is filed under `CelesTrak` in `app.py` ATTRIBUTIONS. So `creditFor(attribution,
 * record.source)` on its own answers `Source: retlector` for two of the three and drops the
 * origin credit entirely, which is the one credit the provider asks for.
 */
export const SATELLITE_ORIGIN_SOURCE = 'CelesTrak';

/**
 * How old an element set may be before the propagator refuses to draw it: 3.5 days.
 *
 * The same number as `STALE_EPOCH_AGE_MS` in `globe/satellites/orbit.ts`, held here as its
 * own constant rather than imported. That module pulls satellite.js in with it and a card
 * has no business putting an SGP4 implementation in the main bundle to read one number. A
 * test asserts the two are equal, so the copy cannot drift.
 */
export const STALE_ELEMENT_AGE_SECONDS = 3.5 * 24 * 60 * 60;

/**
 * The interval the amber and red thresholds are measured against.
 *
 * `ageSeverity` turns amber at twice its interval and red at four times, so a quarter of the
 * staleness limit puts red exactly on the point where the propagator stops drawing the
 * object: amber at 1 day 18 hours, red at 3.5 days. The card and the layer therefore agree
 * about what stale means rather than each holding its own opinion.
 */
export const ELEMENT_AGE_INTERVAL_SECONDS = STALE_ELEMENT_AGE_SECONDS / 4;

/** Revolutions per day to minutes per revolution. */
const MINUTES_PER_DAY = 1440;

const METRES_PER_KM = 1000;

/** What the card prints when this object has no computed position this tick. */
export const NOT_DRAWN = 'No computed position: this object is not being drawn.';

/** What the card prints when the served epoch string will not parse. */
export const EPOCH_UNREADABLE = 'Element set epoch could not be read.';

/**
 * One propagated position, in the units the propagator produces.
 *
 * Longitude and latitude in degrees, WGS84, and the altitude in metres above the WGS84
 * ellipsoid, which is what `eciToGeodetic` returns and what this project's altitude rule
 * asks for.
 */
export interface SatellitePosition {
  lon: number;
  lat: number;
  altitudeM: number;
}

/**
 * Seconds between the element set's epoch and now, or null when the epoch will not parse.
 *
 * The browser clock against the server's string, which is what the two mover cards go out of
 * their way to avoid, and it is right here: `SatelliteEngine.positionsAt` makes exactly the
 * same comparison to decide whether to draw the object at all
 * (`globe/satellites/orbit.ts`). Measuring it any other way would let the card call an
 * element set fresh while the propagator was refusing to draw it.
 */
export function elementAgeSeconds(record: Satellite, nowMs: number = Date.now()): number | null {
  const epochMs = Date.parse(record.epoch);
  return Number.isNaN(epochMs) ? null : (nowMs - epochMs) / 1000;
}

/**
 * The age line, which says which age it is reporting.
 *
 * "Fitted" rather than "reported", and the second clause rather than nothing at all. Without
 * it a reader has every reason to read this the way they read the aircraft card's line, as
 * the age of a fix somebody took.
 */
export function elementAgeLine(seconds: number | null): string {
  if (seconds === null) {
    return EPOCH_UNREADABLE;
  }
  return `Element set fitted ${formatAge(seconds)} · position computed here, not observed`;
}

/**
 * How worried to be about an element set of this age.
 *
 * An epoch that will not parse is red rather than absent: the propagator reads the epoch off
 * the initialised satrec, so a string this card cannot read is an element set whose age
 * nothing here can vouch for.
 */
export function elementAgeSeverity(seconds: number | null): 'fresh' | 'amber' | 'red' {
  return seconds === null ? 'red' : ageSeverity(seconds, ELEMENT_AGE_INTERVAL_SECONDS);
}

/**
 * A Map, not an object literal.
 *
 * The classification comes off the wire, so looking it up with `in` or `[]` on a plain
 * object would let a record reading `constructor` or `__proto__` return something from
 * Object.prototype. Same reasoning as `SQUAWK_TEXT` in `card.ts`.
 */
const CLASSIFICATION_TEXT: ReadonlyMap<string, string> = new Map([
  ['U', 'Unclassified'],
  ['C', 'Classified'],
  ['S', 'Secret'],
]);

/** The classification in words, or the raw code when it is not one of the three. */
export function classificationText(code: string): string {
  return CLASSIFICATION_TEXT.get(code) ?? code;
}

/**
 * The orbital period, derived from the broadcast mean motion.
 *
 * Arithmetic on a published value rather than an inference, so it is shown plainly and the
 * value it came from is shown beside it. Nothing else is derived here: apogee and perigee
 * would need the semi-major axis and Earth's gravitational parameter, which is orbital
 * mechanics in a card, and the rest of the element set (right ascension, argument of
 * pericenter, mean anomaly, B*) are propagator inputs rather than facts a reader can use.
 *
 * The contract refuses a mean motion at or below zero, because SGP4 cannot propagate one.
 * The guard is here anyway: a zero would render as an infinite period rather than as an
 * error, which is the failure mode this project treats as worse than a crash.
 */
export function orbitalPeriodText(meanMotion: number): string {
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) {
    return ABSENT;
  }
  const minutes = MINUTES_PER_DAY / meanMotion;
  return `${minutes.toFixed(1)} min (${meanMotion.toFixed(4)} rev/day)`;
}

/** Altitude in kilometres, because a satellite altitude in metres is six digits of noise. */
export function altitudeText(metres: number): string {
  const km = Math.round(metres / METRES_PER_KM);
  return `${km.toLocaleString('en-GB')} km above the ellipsoid`;
}

/**
 * The computed position line, or the reason there is not one.
 *
 * Longitude first, matching every contract in this project and both mover cards. "Computed"
 * leads the line because that qualifier is the whole point of putting the position here
 * rather than in the definition list with the published elements.
 */
export function positionLine(position: SatellitePosition | null): string {
  if (position === null) {
    return NOT_DRAWN;
  }
  const lon = position.lon.toFixed(4);
  const lat = position.lat.toFixed(4);
  return `Computed position ${lon}, ${lat} · ${altitudeText(position.altitudeM)}`;
}

/**
 * A timestamp from the contract, rendered as UTC and marked as UTC.
 *
 * Both timestamps on this record are timezone-aware UTC by contract, and a reader comparing
 * an epoch against a fetch time needs them in one zone. A string that will not parse is
 * printed as it arrived rather than swallowed: it is what the server sent.
 */
export function utcText(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * What the card calls this object.
 *
 * The catalogue number when there is no name, because analyst objects in the 80000 series
 * carry none at all and a card headed "not reported" names nothing. That is the identity of
 * the object standing in for its title, not a default filling an empty field: the Name row
 * in the definition list still reads absent.
 */
export function satelliteTitle(record: Satellite): string {
  return record.object_name ?? `NORAD ${record.norad_cat_id}`;
}

/**
 * The credit, naming the origin and the host our copy came through.
 *
 * Two facts, and neither substitutes for the other. CelesTrak determined the orbit and asks
 * for the credit; it grants no licence, which the `licence` string the API serves says in as
 * many words, so `creditFor` carrying that string through unedited is what keeps this card
 * from claiming a grant nobody made. The republisher is named because that is where the
 * bytes came from, and it is named without a licence claim of its own, because none of the
 * three mirrors publishes one either.
 */
export function satelliteCreditText(
  attribution: readonly AttributionEntry[],
  source: string,
): string {
  const origin = creditFor(attribution, SATELLITE_ORIGIN_SOURCE);
  if (source.toLowerCase() === SATELLITE_ORIGIN_SOURCE.toLowerCase()) {
    return origin;
  }
  return `${origin} · served through ${source}`;
}

/**
 * The subtitle: the catalogue number, and the designator when there is one.
 *
 * It used to lead with the literal word "Satellite" and that word is now gone, because it was
 * the one subtitle segment in the app that carried no information. The aircraft card leads with
 * the class and the vessel card with the ship type, both of which vary per record; this layer
 * has no per-object classification, so "Satellite" was the same string on all 669 of them. It
 * also cost the two lines it took: at the card's width the head has about 216px for the
 * headings and `Satellite · NORAD 25544 · 1998-067A` needs roughly 230, so it wrapped the
 * header onto a third line to say something the icon, the accessible name on the root and four
 * of the rows below already say.
 */
export function satelliteSubtitle(record: Satellite): string {
  const parts = [`NORAD ${record.norad_cat_id}`];
  if (record.object_id !== null && record.object_id !== undefined) {
    parts.push(record.object_id);
  }
  return parts.join(' · ');
}

export interface SatelliteCardOptions {
  onClose: () => void;
}

export class SatelliteCard {
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly age: HTMLElement;
  private readonly position: HTMLElement;
  private readonly fields: HTMLElement;
  private readonly credit: HTMLElement;
  private record: Satellite | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private attribution: readonly AttributionEntry[] = [];
  private readonly root: HTMLElement;
  private readonly options: SatelliteCardOptions;

  /**
   * Built with `createElement` rather than the `innerHTML` template the two mover cards use.
   *
   * Same markup and the same class names, so one stylesheet covers all three. The difference
   * is that a card assembled node by node can be painted in the node test runner against a
   * fake element, the way `StatusBanner` and `AttributionPanel` already are, which is how a
   * mistake in this template fails a test rather than reaching a browser. The two mover
   * cards' rendering is only covered by the Playwright suite for exactly this reason.
   */
  constructor(root: HTMLElement, options: SatelliteCardOptions) {
    this.root = root;
    this.options = options;
    root.classList.add('card');
    root.setAttribute('aria-label', 'Selected satellite');

    const head = document.createElement('header');
    head.className = 'card-head';
    const identity = document.createElement('div');
    identity.className = 'card-identity';
    const headings = document.createElement('div');
    headings.className = 'card-headings';
    this.title = document.createElement('h2');
    this.title.className = 'card-title';
    this.subtitle = document.createElement('p');
    this.subtitle.className = 'card-subtitle';
    headings.append(this.title, this.subtitle);
    // Painted once here rather than on every `show`, because unlike the two mover cards
    // nothing about this icon depends on the record. The layer has one hue for the whole
    // catalogue and there is no per-satellite classification to encode, so an icon that
    // changed with the selection would be claiming a distinction the data does not make.
    const icon = cardIconElement();
    paintCardIcon(icon, 'diamond', SATELLITE_COLOUR);
    identity.append(icon, headings);
    const close = document.createElement('button');
    close.className = 'card-close';
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close card, Escape');
    close.textContent = 'Close';
    head.append(identity, close);

    this.age = document.createElement('p');
    this.age.className = 'card-age';
    this.age.setAttribute('aria-live', 'polite');

    // Its own line rather than a row in the definition list below, because it is the one
    // thing on this card that this browser worked out rather than read.
    this.position = document.createElement('p');
    this.position.className = 'card-position';
    this.position.setAttribute('aria-live', 'polite');

    this.fields = document.createElement('dl');
    this.fields.className = 'card-fields';
    this.credit = document.createElement('footer');
    this.credit.className = 'card-credit';

    root.append(head, this.age, this.position, this.fields, this.credit);

    close.addEventListener('click', () => {
      this.options.onClose();
    });
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.record !== null) {
        this.options.onClose();
      }
    });

    this.hide();
  }

  /** Licence credits, used to name the terms this element set arrived under. */
  setAttribution(entries: readonly AttributionEntry[]): void {
    this.attribution = entries;
    if (this.record !== null) {
      this.show(this.record);
    }
  }

  /**
   * Take one element set, or null to close the card.
   *
   * Called on a selection change rather than on a tick: an element set is refetched every
   * half hour, so nothing in the definition list moves in between. The position is a
   * separate call for the opposite reason.
   */
  show(record: Satellite | null): void {
    if (record === null) {
      this.hide();
      return;
    }
    this.record = record;

    this.root.hidden = false;
    this.title.textContent = satelliteTitle(record);
    this.subtitle.textContent = satelliteSubtitle(record);

    this.fields.replaceChildren(
      ...rows([
        // Absent, not the title's fallback: analyst objects in the 80000 series carry no
        // name and the card must not read as though CelesTrak published one.
        ['Name', record.object_name ?? ABSENT],
        ['Catalogue number', `NORAD ${record.norad_cat_id}`],
        // "Designator" rather than "International designator": the label column is 10rem,
        // sized to hold 16 characters at 16px without wrapping (`style.css`), and the value
        // itself, 1998-067A, is what a reader recognises.
        ['Designator', record.object_id ?? ABSENT],
        ['Classification', classificationText(record.classification_type)],
        // Two timestamps that must not be confused, which is why both are here. The epoch is
        // when the orbit was determined and it is what decides whether the computed position
        // is worth anything. The fetch is how current our copy of that determination is.
        ['Element epoch', utcText(record.epoch)],
        ['Copy fetched', utcText(record.fetched_at)],
        ['Orbital period', orbitalPeriodText(record.mean_motion)],
        ['Inclination', `${record.inclination_deg.toFixed(2)}°`],
        ['Eccentricity', record.eccentricity.toFixed(6)],
        // Provenance, and the reason two overlapping groups cannot double-count an object:
        // the store is keyed on the catalogue number, not on the group.
        ['CelesTrak group', record.group],
        // The host that served our copy, which is not the same fact as the origin credit in
        // the footer. Two of the three are mirrors of CelesTrak rather than CelesTrak.
        ['Served through', record.source],
      ]),
    );

    this.credit.textContent = satelliteCreditText(this.attribution, record.source);
    this.refreshAge();
    // Once a second: the age is the one thing on the card that changes while nothing else
    // does, and it has to be seen to change or it is not doing its job.
    this.ticker ??= setInterval(() => {
      this.refreshAge();
    }, 1000);
  }

  /**
   * Take one computed position, or null when the propagator is not drawing this object.
   *
   * Separate from `show` so a per-tick position costs one text write rather than rebuilding
   * eleven definition-list rows every frame. Null is not an error: an element set past 3.5
   * days is held back deliberately and SGP4 refuses a decayed one, and in both cases the
   * card should say there is no position rather than keep showing the last one.
   */
  setPosition(position: SatellitePosition | null): void {
    this.position.textContent = positionLine(position);
  }

  hide(): void {
    this.record = null;
    this.root.hidden = true;
    this.position.textContent = positionLine(null);
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private refreshAge(): void {
    if (this.record === null) {
      return;
    }
    const seconds = elementAgeSeconds(this.record);
    this.age.textContent = elementAgeLine(seconds);
    // Bracketed because `DOMStringMap` is an index signature: dotted access on one is a typo
    // waiting to happen, which is what noPropertyAccessFromIndexSignature says.
    this.age.dataset['severity'] = elementAgeSeverity(seconds);
  }
}
