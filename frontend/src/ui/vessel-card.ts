/**
 * The vessel information card.
 *
 * Same shape as the aircraft card in `card.ts`: a docked side panel, everything on it
 * either reported by the feed or derived from it, and the age of the last fix always on
 * screen so a frozen feed cannot look live. Everything both cards do the same way is
 * imported from there rather than restated: the age formatting, the fresh/amber/red
 * thresholds, the bearing wording, the definition-list body, the credit line and the
 * not-reported text.
 *
 * Two rules govern what this shows, and both come from ADR 010.
 *
 * **The provider and the report age are on the card**, next to each other, because a
 * merged record whose provider you cannot see is unauditable and because recency is what
 * resolved the merge in the first place.
 *
 * **The provider named is the one the record carries.** `Vessel.source` is a single
 * provider, the one whose report won on recency in `services/union.py`. The full list of
 * providers that saw a given ship stays server side on `MergedRecord.sightings` and is not
 * serialised, so where two providers saw the same vessel this card can only name the one
 * that supplied the position. Naming the others from `/api/layers` provider coverage would
 * be a guess about this ship from a fact about the layer, which is the opposite of what the
 * ADR is asking for. Closing it properly means the backend serialising the sighting list.
 *
 * The card needs its own root element, not the aircraft card's. Each of these classes owns
 * its root's markup, so two of them on one element leaves the first holding detached nodes.
 */

import { FOLLOW_HINT } from '../globe/follow';
// The two state colours the globe already paints a hull in, imported rather than restated. A
// colour is a shared design token and a second copy of one drifts the moment either moves, so
// this is the card and the globe reading the same constant. It costs no bundle weight: the
// layer is already in the main bundle through `main.ts`.
import type { IconShape } from '../globe/icons';
import { STOPPED_COLOUR, UNDER_WAY_COLOUR } from '../globe/layers/vessels';
import { store } from '../state/store';
import type { TrackedVessel } from '../state/store';
import { flagMid, isUnderWay, shipTypeLabel, vesselLabel } from '../domain/vessel';
import type { Vessel } from '../domain/vessel';
import {
  ABSENT,
  MPS_TO_KNOTS,
  ageSeverity,
  bearingText,
  cardIconElement,
  creditFor,
  formatAge,
  mustFind,
  paintCardIcon,
  rows,
} from './card';
import type { AttributionEntry } from '../types/entities';

/**
 * Fallback vessel cadence in seconds, matching `VESSEL_UNION_MIN_INTERVAL_SECONDS` in
 * `src/tracker/app.py`.
 *
 * Sixty rather than the aircraft card's eight. Fintraffic caches for a minute and AISHub
 * answers an over-frequent call with an empty body, so the union cannot cycle faster, and
 * judging a ship against an eight-second cadence would paint the whole fleet red.
 */
export const DEFAULT_VESSEL_FEED_INTERVAL_SECONDS = 60;

/**
 * Seconds since the position fix, measured without trusting the browser clock against the
 * server's.
 *
 * Digitraffic's default query window is 24 hours, so `position_age_s` can legitimately be
 * tens of thousands of seconds. That is a stale position and the card says so; it is not a
 * fault, and it is exactly the number ADR 010 wants visible.
 */
export function vesselFixAgeSeconds(tracked: TrackedVessel, nowMs: number = Date.now()): number {
  return tracked.vessel.position_age_s + (nowMs - tracked.receivedAtMs) / 1000;
}

/**
 * Speed in knots first, because that is the unit every mariner and every AIS receiver
 * actually uses. The contract stores metres per second, so both are shown.
 */
export function speedText(mps: number | null | undefined): string {
  if (mps === null || mps === undefined) {
    return ABSENT;
  }
  return `${(mps * MPS_TO_KNOTS).toFixed(1)} kt (${mps.toFixed(1)} m/s)`;
}

/**
 * The flag field.
 *
 * It names the MID, which is a fact off the MMSI, and it does not name a country, because
 * resolving a MID to a flag state needs the published ITU table and that lands with the
 * phase 5 registry work. No default and no guess: an unresolved flag says it is
 * unresolved.
 */
export function flagText(vessel: Vessel): string {
  return `not resolved (MMSI MID ${flagMid(vessel)})`;
}

/**
 * The navigational status, marked as broadcast.
 *
 * The qualifier is not decoration. This is what the master set on the transponder, and it
 * disagrees with the vessel's behaviour often enough that the card shows the speed beside
 * it and lets the reader see the disagreement.
 */
export function navStatusText(status: Vessel['navigational_status']): string {
  if (status === null || status === undefined) {
    return ABSENT;
  }
  const words = status.replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (as broadcast)`;
}

const MONTHS: ReadonlyMap<number, string> = new Map([
  [1, 'Jan'],
  [2, 'Feb'],
  [3, 'Mar'],
  [4, 'Apr'],
  [5, 'May'],
  [6, 'Jun'],
  [7, 'Jul'],
  [8, 'Aug'],
  [9, 'Sep'],
  [10, 'Oct'],
  [11, 'Nov'],
  [12, 'Dec'],
]);

/**
 * The estimated time of arrival, which is never rendered as a date.
 *
 * The AIS field is 20 packed bits holding month, day, hour and minute and it carries no
 * year at all, so the card says so rather than letting a reader assume one. A month
 * outside the table degrades to its number instead of being dropped.
 */
export function etaText(eta: Vessel['eta']): string {
  if (eta === null || eta === undefined) {
    return ABSENT;
  }
  const month = MONTHS.get(eta.month) ?? String(eta.month);
  const time = `${String(eta.hour).padStart(2, '0')}:${String(eta.minute).padStart(2, '0')}`;
  return `${String(eta.day)} ${month}, ${time} (no year broadcast)`;
}

/**
 * The hull colour for one vessel: the globe's own two state colours, and no third one.
 *
 * A function rather than an expression at the call site, so the mapping can be asserted
 * without a document. It is the one card icon that encodes a state rather than labelling a
 * type, which makes it the one worth testing on its own: if this flattened to a single hue,
 * every card would look the same and nothing would fail.
 *
 * `isUnderWay` reads the speed and the course rather than the broadcast navigational status,
 * for the reason `domain/vessel.ts` gives: the status is typed in by the master and the speed
 * is a measurement. So a ship set to "moored" and making way reads as under way here, which is
 * the same answer the globe gives for the same ship.
 */
export function vesselIconFill(vessel: Vessel): string {
  return isUnderWay(vessel) ? UNDER_WAY_COLOUR : STOPPED_COLOUR;
}

/**
 * The silhouette for one vessel, mirroring what the globe draws for the same record.
 *
 * `block` when no course over ground was reported, `ship` when one was, keyed on the same field
 * the layer keys on (`layers/vessels.ts` reads `record.course_over_ground_deg ?? null`), so the
 * card and the globe never show two different shapes for one ship.
 *
 * Not a rotation question. The hull is a directional shape whether or not a transform is
 * applied, and 110 of 1,058 live records carry the 360.0 not-available course that the adapter
 * maps to null, so drawing a bow direction for those would be inventing a course from a
 * sentinel. The course itself is stated to the degree in the Course over ground row.
 */
export function vesselIconShape(vessel: Vessel): IconShape {
  const course = vessel.course_over_ground_deg;
  return course === null || course === undefined ? 'block' : 'ship';
}

export interface VesselCardOptions {
  onClose: () => void;
}

export class VesselCard {
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly age: HTMLElement;
  private readonly fields: HTMLElement;
  private readonly credit: HTMLElement;
  private tracked: TrackedVessel | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private attribution: readonly AttributionEntry[] = [];
  private readonly root: HTMLElement;
  private readonly options: VesselCardOptions;

  constructor(root: HTMLElement, options: VesselCardOptions) {
    this.root = root;
    this.options = options;
    root.classList.add('card');
    root.setAttribute('aria-label', 'Selected vessel');
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
      <p class="card-age" aria-live="polite"></p>
      <dl class="card-fields"></dl>
      <footer class="card-credit"></footer>`;

    this.title = mustFind(root, '.card-title');
    this.subtitle = mustFind(root, '.card-subtitle');
    // Built here rather than written into the template above, so the element never exists
    // without a `src` on it. `show` paints it before the card is ever unhidden.
    this.icon = cardIconElement();
    mustFind(root, '.card-identity').prepend(this.icon);
    mustFind(root, '.card-hint').textContent = FOLLOW_HINT;
    this.age = mustFind(root, '.card-age');
    this.fields = mustFind(root, '.card-fields');
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

  /** Licence credits, used to name the licence this vessel's data arrived under. */
  setAttribution(entries: readonly AttributionEntry[]): void {
    this.attribution = entries;
    if (this.tracked !== null) {
      this.show(this.tracked);
    }
  }

  show(tracked: TrackedVessel | null): void {
    if (tracked === null) {
      this.hide();
      return;
    }
    this.tracked = tracked;
    const record = tracked.vessel;

    this.root.hidden = false;
    this.title.textContent = vesselLabel(record);
    // The globe's own two state colours, so a moored ship reads moored on the card as well.
    // It is a state rather than a label, so it gets the same care as the text: the
    // navigational status and the speed are both rows below, and neither depends on the hue.
    // The shape mirrors the globe too, including its refusal to draw a bow direction for a
    // ship that reported no course.
    paintCardIcon(this.icon, vesselIconShape(record), vesselIconFill(record));
    this.subtitle.textContent = [
      shipTypeLabel(record.ship_type) ?? 'type unknown',
      `MMSI ${record.mmsi}`,
    ].join(' · ');

    this.fields.replaceChildren(
      ...rows([
        ['Name', record.name ?? ABSENT],
        ['Type', shipTypeLabel(record.ship_type) ?? ABSENT],
        ['Speed over ground', speedText(record.speed_over_ground_mps)],
        ['Flag', flagText(record)],
        ['Course over ground', bearingText(record.course_over_ground_deg)],
        // Separate from the course on purpose: the heading is where the bow points, and a
        // vessel in a tideway carries one well off its track.
        ['Heading', bearingText(record.true_heading_deg)],
        ['Navigational status', navStatusText(record.navigational_status)],
        ['Call sign', record.call_sign ?? ABSENT],
        ['Destination', record.destination ?? ABSENT],
        ['ETA', etaText(record.eta)],
        ['Position', `${record.point.lon.toFixed(4)}, ${record.point.lat.toFixed(4)}`],
      ]),
    );

    this.credit.textContent = creditFor(this.attribution, record.source);
    this.refreshAge();
    // Once a second: the age is the one thing on the card that changes while nothing else
    // does, and it has to be seen to change or it is not doing its job.
    this.ticker ??= setInterval(() => {
      this.refreshAge();
    }, 1000);
  }

  hide(): void {
    this.tracked = null;
    this.root.hidden = true;
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private refreshAge(): void {
    if (this.tracked === null) {
      return;
    }
    const seconds = vesselFixAgeSeconds(this.tracked);
    // Provider and age in one line, per ADR 010: which network saw this ship, and how
    // stale its report is, are the same question.
    this.age.textContent = `Last fix ${formatAge(seconds)} · ${this.tracked.vessel.source}`;
    // Bracketed because `DOMStringMap` is an index signature.
    this.age.dataset['severity'] = ageSeverity(seconds, this.feedInterval());
  }

  /**
   * The cadence of the vessel feed, so the amber and red thresholds match reality rather
   * than a hardcoded guess.
   *
   * Matched on the layer, not on the record's provider. The layer is one union of several
   * providers polled on one cycle, so the cycle is the layer's and no provider has a
   * cadence of its own to compare against.
   */
  private feedInterval(): number {
    const feed = store.feeds.find((candidate) => candidate.layer === 'vessels');
    return feed?.poll_interval_seconds ?? DEFAULT_VESSEL_FEED_INTERVAL_SECONDS;
  }
}
