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

import { CLASS_LABELS, colourFor } from '../globe/palette';
import { store } from '../state/store';
import type { TrackedAircraft } from '../state/store';
import type { AttributionEntry, EmergencyState } from '../types/entities';
import { aircraftLabel, inEmergency } from '../domain/derive';

/** Fallback feed cadence, matching the backend default for adsb.lol in seconds. */
export const DEFAULT_FEED_INTERVAL_SECONDS = 8;

const METRES_TO_FEET = 3.28084;

/** Shared with the vessel card, which leads with knots rather than showing them second. */
export const MPS_TO_KNOTS = 1.94384;

/** What both cards print for a field the feed did not report. Never a zero, never a dash. */
export const ABSENT = 'not reported';

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

export interface InfoCardOptions {
  onClose: () => void;
}

export class InfoCard {
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly age: HTMLElement;
  private readonly fields: HTMLElement;
  private readonly credit: HTMLElement;
  private tracked: TrackedAircraft | null = null;
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
        <div>
          <h2 class="card-title"></h2>
          <p class="card-subtitle"></p>
        </div>
        <button type="button" class="card-close" aria-label="Close card, Escape">Close</button>
      </header>
      <p class="card-alert" role="alert" hidden></p>
      <p class="card-age" aria-live="polite"></p>
      <dl class="card-fields"></dl>
      <footer class="card-credit"></footer>`;

    this.title = mustFind(root, '.card-title');
    this.subtitle = mustFind(root, '.card-subtitle');
    this.alert = mustFind(root, '.card-alert');
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
    this.tracked = tracked;
    const record = tracked.aircraft;

    this.root.hidden = false;
    this.title.textContent = aircraftLabel(record);
    this.title.style.color = colourFor(record.aircraft_class, inEmergency(record));
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
        ['Registration', record.registration ?? 'not in registry'],
        ['Type', record.type_designator ?? ABSENT],
        ['Class', CLASS_LABELS[record.aircraft_class]],
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

    this.credit.textContent = creditFor(this.attribution, record.source);
    this.refreshAge();
    // Once a second: the age is the one thing on the card that changes while nothing
    // else does, and it has to be seen to change or it is not doing its job.
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
