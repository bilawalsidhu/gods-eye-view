/**
 * The credits menu.
 *
 * These credits are licence conditions, not decoration. adsb.lol publishes under ODbL 1.0,
 * Fintraffic under CC BY with wording fixed by their terms of service, GeoNames under CC BY,
 * OpenStreetMap under ODbL, and NASA asks for a credit on GIBS imagery. The list comes from
 * `/api/capabilities` so a source added to the backend cannot ship without its credit.
 *
 * **Why it is a menu.** Twelve credits with their licence strings is 215 pixels of panel across
 * most of the bottom of the globe, and the globe is the product. What a licence requires is
 * that the credit is presented with the work, reachable and not buried: the accepted pattern
 * for a map is a visible affordance that opens the full list, which is what every mapping
 * library ships. So the affordance is always on screen and one click from every view, and
 * nothing is behind a hover, a scroll or a second page.
 *
 * **The affordance is an "i", and it is 44 pixels square.** Specified by Alexander Fanthome on
 * 2026-08-20: a small "i" in the bottom corner, clicking it shows the attribution. Small is
 * about how much of the globe it covers, not about how hard it is to hit or see: the glyph is
 * 20px on a 44px target, which is the minimum a pointer target should be. The count of sources
 * moves into the accessible name and the tooltip rather than onto the button, because the
 * resting state is the one control and nothing else.
 *
 * **A `<details>` element rather than a button and a panel.** It is open and closed by the
 * browser, is in the tab order, toggles on space and enter, announces its own expanded state
 * to a screen reader, and works with no JavaScript running at all. None of that is code we
 * then have to keep right.
 *
 * **Cesium's own credit line is hidden, and this menu is why.** Cesium renders a credit for
 * the imagery provider it is handed, as a "Data attribution" link in its own overlay at the
 * bottom left, which landed 17px from the "i" button: two controls opening the same one list,
 * on the globe that is the product. `style.css` hides it, and what makes that a duplicate
 * removed rather than a credit dropped is `GIBS_CREDIT_TEXT` below. One constant, rendered
 * here and handed to Cesium by `globe/viewer.ts`, so there is no version of this where a user
 * reads two different claims about who the imagery belongs to, and no version where hiding
 * Cesium's control hides a string this menu does not carry.
 *
 * That last part is asserted, not assumed. `e2e/smoke.spec.ts` reads every credit Cesium holds
 * out of the hidden container and its lightbox and requires each one to appear in this menu,
 * so handing Cesium a second imagery provider with a hand-typed credit fails the suite rather
 * than quietly dropping a licence condition.
 *
 * **A grouped credit needs two more things, and one of them is a blocker.** 183 transit credits
 * are served as 8 rows, which is only honest if a row can still name every owner behind it and
 * carry the date one of those licences demands. Etalab 2.0 governs 101 of the 258 transit feeds
 * and requires the date the information was last updated as well as the producer's name, so
 * until `as_of` is on screen the transit layer cannot be publicly displayed. That is why the
 * date is rendered on the row itself and never inside the disclosure below it.
 *
 * **A row is compliant, not a field, and that is a correction rather than a nuance.** The
 * backend docstrings used to promise that `text` was "a complete, compliant sentence on its
 * own". `docs/status.md` records that as false and unachievable for Etalab: the condition needs
 * a per-request date and `text` is built at import time, so no wording discharged it, and
 * naming all 67 producers in prose made the sentence 2,024 characters and still did not comply.
 * `text` is now 68 characters. So these licences are discharged by `text`, `url`, `operators`
 * and `as_of` **together**, and `operators` is load-bearing rather than a nicety.
 *
 * **Which makes collapsing them a judgement, so here it is.** `licence` stays visible beside
 * the sentence, because ODbL asks for the licence alongside the owners rather than the owners
 * alone. `as_of` is visible because a date inside a closed disclosure is not displayed and
 * Etalab asks for it to be. The owners are the one part behind a disclosure, on exactly the
 * argument this menu already rests on: a credit has to be presented with the work, reachable
 * and not buried, which is a visible affordance that opens the full list rather than a wall of
 * text. 181 owner names open at rest is the panel across the bottom of the globe that the "i"
 * was built to remove. The summary names the count and the fact that terms are behind it, so
 * nothing is a mystery control, and nothing is behind a hover, a scroll or a second page.
 *
 * **Sixty names are one line of text, not sixty rows.** The operators are an inline run of
 * links separated by commas inside one collapsed `<details>`, so a grouped row costs one 44px
 * summary whether it stands for one owner or 67. Rendering them as one element each would have
 * put 181 rows in that panel. Measured live: the open menu is 432px tall with all six grouped
 * rows in it, and stays 432px with the 67-owner row expanded, because the list scrolls inside
 * its own cap rather than growing.
 *
 * **Each operator's link is its own terms, not its homepage.** That is what
 * `CreditedOperatorEntry.url` carries, and it is what makes the CC-BY condition on 35 of those
 * feeds hold: the licence link is not optional and a shared row-level link cannot stand for 35
 * different ones. Naming the owner and linking its terms is the pattern OpenStreetMap's own
 * credit uses.
 */

import type { AttributionEntry } from '../types/entities';

/**
 * The basemap credit, in one place because two things render it.
 *
 * `globe/viewer.ts` hands this to Cesium as the imagery provider's own `Credit`, and the
 * baseline list below carries it for the menu. Two hand-typed copies of the same credit is
 * how a user ends up reading two different claims about who the imagery belongs to, so
 * there is one copy and both sites import it. A test asserts the baseline still carries it.
 */
export const GIBS_CREDIT_TEXT = 'Imagery courtesy of NASA EOSDIS GIBS';

/**
 * The cloud layer's credit, which names the satellites rather than only the service.
 *
 * Its own string rather than a second use of the basemap's, because it is not the same
 * imagery and saying so is the point of a credit. The basemap is NASA's own VIIRS mosaic;
 * the clouds are NOAA's two GOES spacecraft and JMA's Himawari, reprojected and published by
 * GIBS. `globe/layers/clouds.ts` hands this to Cesium for all three sheets, and Cesium shows
 * one line for three identical credits.
 */
export const CLOUD_CREDIT_TEXT =
  'Cloud imagery from NOAA GOES and JMA Himawari via NASA EOSDIS GIBS';

/**
 * Shown before the capabilities call answers, and kept if it never does.
 *
 * Deliberately duplicated from the backend for these two only: the GIBS basemap renders
 * straight from NASA without our API being reachable at all, so its credit cannot depend
 * on our API being up, and the aircraft layer must never be visible uncredited.
 */
export const BASELINE_CREDITS: readonly AttributionEntry[] = [
  {
    source: 'adsb.lol',
    text: 'Aircraft data from adsb.lol',
    url: 'https://adsb.lol',
    licence: 'ODbL 1.0',
    // Empty: these are single-source rows. `operators` and `as_of` exist for a *grouped*
    // credit, where one row stands for many owners and a licence such as Etalab 2.0
    // requires the date the information was last updated. The backend leaves both empty
    // on an ordinary row, and `text` is a compliant sentence on its own either way.
    operators: [],
  },
  {
    source: 'NASA GIBS',
    text: GIBS_CREDIT_TEXT,
    url: 'https://gibs.earthdata.nasa.gov',
    licence: 'Public domain, attribution requested',
    // Empty: these are single-source rows. `operators` and `as_of` exist for a *grouped*
    // credit, where one row stands for many owners and a licence such as Etalab 2.0
    // requires the date the information was last updated. The backend leaves both empty
    // on an ordinary row, and `text` is a compliant sentence on its own either way.
    operators: [],
  },
];

/**
 * Sources the browser reaches on its own, which the API therefore cannot credit.
 *
 * The cloud layer asks NASA for tiles directly and never touches our backend, so
 * `/api/capabilities` has no way to know it is on screen and no business claiming it is.
 * Appended to whatever the API serves rather than replacing it, because the licence
 * condition is that the credit is shown wherever the imagery is, and the imagery is here.
 */
const CLIENT_CREDITS: readonly AttributionEntry[] = [
  {
    source: 'NASA GIBS clouds',
    text: CLOUD_CREDIT_TEXT,
    url: 'https://gibs.earthdata.nasa.gov',
    licence: 'Public domain, attribution requested',
    // Empty: these are single-source rows. `operators` and `as_of` exist for a *grouped*
    // credit, where one row stands for many owners and a licence such as Etalab 2.0
    // requires the date the information was last updated. The backend leaves both empty
    // on an ordinary row, and `text` is a compliant sentence on its own either way.
    operators: [],
  },
];

/**
 * Which credits to render.
 *
 * An empty list from the API is treated as an API that has not answered rather than as a
 * deployment with no sources: something is on the globe, so something has to be credited.
 *
 * The client-side credits are merged on top of either, matched on their text so a backend
 * that starts serving one of them does not put it on screen twice.
 */
export function creditsToShow(entries: readonly AttributionEntry[]): readonly AttributionEntry[] {
  const served = entries.length > 0 ? entries : BASELINE_CREDITS;
  const absent = CLIENT_CREDITS.filter((credit) =>
    served.every((entry) => entry.text !== credit.text),
  );
  return absent.length === 0 ? served : [...served, ...absent];
}

/**
 * What the closed control shows: one letter.
 *
 * The whole visible resting state of the credits, by design. Everything that says what it is
 * lives in {@link creditsLabel}, which becomes the accessible name and the tooltip.
 */
export const CREDITS_GLYPH = 'i';

/**
 * The accessible name and tooltip on the closed control.
 *
 * An "i" on its own tells a sighted user roughly what to expect and tells a screen reader
 * nothing at all, so the control carries this as its label. The count is here rather than on
 * the button so that the button stays one glyph: it says there is a list and how long it is,
 * which is what stops it reading as a mystery control.
 */
export function creditsLabel(entries: readonly AttributionEntry[]): string {
  return `Data sources and licences (${String(creditsToShow(entries).length)})`;
}

/**
 * When the data behind a grouped credit was last updated, as a date rather than a clock.
 *
 * Etalab 2.0 asks for "the date the information was last updated", which is a fact about the
 * vehicles on screen and not about when the page loaded or when the build shipped. It moves
 * every few minutes, because the transit store holds 240 seconds of vehicles and the adapter
 * accepts reports up to 300 seconds old, and that is correct for a live feed rather than a sign
 * of something churning.
 *
 * UTC and explicit about it, matching `satellite-card.ts`. A locale-formatted local time would
 * read more naturally and would be ambiguous in exactly the case that matters: a credit read in
 * one timezone about data timestamped in another.
 */
export function lastUpdatedText(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * What the closed operators disclosure says.
 *
 * The count is on the summary rather than hidden behind it, for the same reason the "i" carries
 * its count in its accessible name: a disclosure that does not say how much is behind it reads
 * as a mystery control. "and their terms" is there because the links inside are terms rather
 * than homepages, so a user who wants a licence knows this is where it is.
 */
export function operatorsLabel(count: number): string {
  return count === 1 ? '1 operator and its terms' : `${String(count)} operators and their terms`;
}

/** Append a fresh element and hand it back, for a caller that supplied a bare root. */
function make(root: HTMLElement, tag: 'div' | 'ul'): HTMLElement {
  const node = document.createElement(tag);
  root.append(node);
  return node;
}

export class AttributionPanel {
  private readonly summary: HTMLElement;
  private readonly list: HTMLElement;

  constructor(root: HTMLElement) {
    root.classList.add('credits');
    // The markup in index.html already carries both, so the credits are on screen from the
    // first frame rather than from the first module evaluation. Created here only for a
    // caller that hands over a bare element.
    this.summary = root.querySelector('summary') ?? make(root, 'div');
    this.list = root.querySelector('ul') ?? make(root, 'ul');
    this.list.classList.add('credits-list');
    this.render(BASELINE_CREDITS);
  }

  render(entries: readonly AttributionEntry[]): void {
    const shown = creditsToShow(entries);
    // The glyph never changes; the name and the tooltip carry what it is and how many.
    this.summary.textContent = CREDITS_GLYPH;
    const label = creditsLabel(entries);
    this.summary.setAttribute('aria-label', label);
    this.summary.title = label;
    this.list.replaceChildren(...shown.map((entry) => creditRow(entry)));
  }
}

/** An external link, opened away from the globe and told nothing about where it came from. */
function externalLink(href: string, text: string, title?: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noreferrer';
  link.target = '_blank';
  link.textContent = text;
  if (title !== undefined) {
    link.title = title;
  }
  return link;
}

/**
 * One credit, in the order the licences need it.
 *
 * The sentence and its licence first and always, then the date if there is one, then the owners
 * behind a disclosure if there are any. A row with neither renders exactly as it did before this
 * function grew, which is what protects the two verbatim mandates: King County Metro requires its
 * sentence prominently displayed and the City of Hamilton reserves the right to require removal,
 * both have their own single-source rows, and nothing here reaches a row with no operators and no
 * date.
 */
function creditRow(entry: AttributionEntry): HTMLElement {
  const item = document.createElement('li');
  const licence = document.createElement('span');
  licence.className = 'attribution-licence';
  licence.textContent = ` (${entry.licence})`;
  item.append(externalLink(entry.url, entry.text), licence);

  if (entry.as_of !== undefined && entry.as_of !== null) {
    const updated = document.createElement('time');
    updated.className = 'attribution-licence';
    updated.setAttribute('datetime', entry.as_of);
    updated.textContent = ` · information last updated ${lastUpdatedText(entry.as_of)}`;
    item.append(updated);
  }

  // `?? []` on a field the contract marks required, deliberately. This panel throwing means
  // *every* credit disappears from the globe rather than one row losing its owner list, so the
  // failure mode of trusting the type here is the licence breach this whole file exists to
  // prevent. Degrading to `text` plus `licence` is compliant on its own, which is what makes
  // the fallback a real answer rather than a swallowed error.
  // The rule is right about the type and wrong about the risk: `operators` is required, and a
  // backend mid-rollout that omits it would throw here and take *every* credit off the globe.
  // This is damage limitation and not a compliant state: since a row rather than a field is
  // what discharges these licences, a grouped row that lost its owners is under-credited. Every
  // other credit surviving is the better of two bad outcomes, not a good one.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const operators = entry.operators ?? [];
  if (operators.length > 0) {
    const group = document.createElement('details');
    const label = document.createElement('summary');
    label.textContent = operatorsLabel(operators.length);
    const names = document.createElement('div');
    // Commas as text between the links rather than an element each: `Element.append` takes
    // strings, so 101 owners cost 101 elements instead of 202 and read as a credit line rather
    // than a directory.
    names.append(
      ...operators.flatMap((operator, index) => {
        const link = externalLink(operator.url, operator.name, `Terms for ${operator.name}`);
        return index === 0 ? [link] : [', ', link];
      }),
    );
    group.append(label, names);
    item.append(group);
  }
  return item;
}
