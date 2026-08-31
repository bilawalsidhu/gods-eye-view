/**
 * The place information card, for one row of the GeoNames gazetteer.
 *
 * Same docked side panel as the aircraft card in `card.ts` and the vessel card in
 * `vessel-card.ts`, same class names so it inherits their styling, and the definition-list
 * body, the credit line and the not-reported text are imported from `card.ts` rather than
 * restated.
 *
 * What it deliberately does not have, and why in each case.
 *
 * **No age line and no ticker.** Cities do not move, so there is nothing to go stale and a
 * fresh/amber/red badge would be inventing a liveness question this layer does not have. The
 * one date on the record is the day GeoNames last changed the row, and it sits in the
 * definition list as a plain date because that is what it is.
 *
 * **No follow hint.** Follow mode holds a mover the store is tracking. Nothing here moves.
 *
 * **No title colour.** The layer draws its labels in three weights and three greys by
 * population band (`globe/layers/cities.ts`), which is a legibility device for a map and
 * would encode nothing on a card. The title stays the card's own text colour, which is the
 * highest-contrast option available.
 *
 * **No country name and no region name.** The record carries an ISO 3166-1 alpha-2 country
 * code and a first-order administrative code, not names. Resolving either needs GeoNames'
 * separate `countryInfo.txt` and `admin1Codes.txt`, which this project does not fetch, and
 * the admin code is not even consistently a FIPS code: London GB carries `ENG`. So the codes
 * are shown as codes and labelled as codes. Same reasoning as the vessel card's flag field.
 *
 * **No local time.** It would need `Intl` against the IANA zone and a per-second repaint to
 * avoid being wrong, and this card exists to show a record rather than a clock. The zone id
 * is on the card, which is the fact the record actually carries.
 *
 * GeoNames is CC BY 4.0, and under that licence the credit is a condition rather than a
 * courtesy, which is why the footer is not optional and why the credit string the API serves
 * carries a link to the source and a link to the licence.
 *
 * The card needs its own root element, not any other card's. Each of these classes owns its
 * root's markup, so two of them on one element leaves the first holding detached nodes.
 */

import { ABSENT, cardIconElement, creditFor, hasText, paintCardIcon, rows } from './card';
import type { AttributionEntry, City } from '../types/entities';

/**
 * The fill for the place icon.
 *
 * Defined here rather than imported, because unlike the three mover cards there is nothing on
 * the globe to keep it in step with: cities are drawn as text labels, so the layer has no mark
 * and no mark colour, and there is nothing that can drift.
 *
 * The value is the city layer's own middle label grey, so the icon sits in the same palette as
 * the names it belongs to rather than borrowing a mover's hue. It is not the band colour for a
 * given city and must not become one: the three greys are a legibility device for a map, the
 * same reason this card's title takes no band colour either. 10.58:1 against the card panel.
 */
export const PLACE_COLOUR = '#b6c6d3';

/**
 * The attribution `source` the gazetteer is credited under, matching `SOURCE_NAME` in
 * `sources/geonames.py`.
 *
 * A constant here because `City` carries no `source` field: every row comes from one file
 * from one provider, so the contract leaves provenance to the layer's attribution rather
 * than repeating a string 34,099 times. `CITY_LAYER` in `globe/layers/cities.ts` is a
 * different string for a different job, the layer name the rail and `/api/capabilities`
 * use, so it is not reused here.
 */
export const CITY_SOURCE = 'geonames';

/**
 * A Map, not an object literal, for the same reason `card.ts` uses one for squawk codes: the
 * feature code comes off a bulk file and looking it up with `[]` on a plain object would let
 * a row reading `constructor` return something from Object.prototype.
 *
 * The fourteen codes that reach the domain, counted in the real file on 2026-08-23: PPL
 * 18,268, PPLA2 6,862, PPLA3 2,818, PPLA 2,419, PPLX 2,376, PPLA4 972, PPLC 241, PPLL 71,
 * PPLA5 18, PPLS 11, PPLG 9, PPLF 4, STLMT 2, PPLR 1. The other three in the file, PPLH,
 * PPLQ and PPLW, are historical, abandoned and destroyed places and are dropped and counted
 * in the adapter, so they never arrive here.
 */
const FEATURE_TEXT: ReadonlyMap<string, string> = new Map([
  ['PPL', 'Populated place'],
  ['PPLA', 'First-order administrative seat'],
  ['PPLA2', 'Second-order administrative seat'],
  ['PPLA3', 'Third-order administrative seat'],
  ['PPLA4', 'Fourth-order administrative seat'],
  ['PPLA5', 'Fifth-order administrative seat'],
  ['PPLC', 'National capital'],
  ['PPLF', 'Farm village'],
  ['PPLG', 'Seat of government'],
  ['PPLL', 'Populated locality'],
  ['PPLR', 'Religious populated place'],
  ['PPLS', 'Group of populated places'],
  ['PPLX', 'Section of a populated place'],
  ['STLMT', 'Israeli settlement'],
]);

/**
 * The kind of place, in words, with the provider's own code beside it.
 *
 * The code is kept because it is what the record says and what a reader would search for.
 * An unrecognised code prints alone rather than being guessed at: GeoNames can add one, and
 * a wrong plain-English label is worse than none.
 */
export function featureText(code: string): string {
  const words = FEATURE_TEXT.get(code);
  return words === undefined ? code : `${words} (${code})`;
}

/**
 * Population as the provider gives it.
 *
 * Zero is a not-available value rather than a measurement, the same trap as the AIS
 * sentinels: 3 of the 34,099 rows report 0, and no inhabited place in a gazetteer of
 * settlements has no inhabitants. It reads as absent rather than as "0 people".
 */
export function populationText(population: number): string {
  return population === 0 ? ABSENT : population.toLocaleString('en-GB');
}

/**
 * Elevation, and the datum it is measured from.
 *
 * The datum is in the text because it is not this project's datum. Every other altitude here
 * is metres above the WGS84 ellipsoid; this is the provider's metres above mean sea level,
 * and the two differ by up to about 100 metres. The contract leaves `point.altitude_m` unset
 * rather than copying one into the other, so this card names the difference rather than
 * hiding it. Absent on 29,612 of 34,099 rows, and absent means absent.
 */
export function elevationText(metres: number | null | undefined): string {
  if (metres === null || metres === undefined) {
    return ABSENT;
  }
  return `${metres.toLocaleString('en-GB')} m above mean sea level`;
}

/**
 * A code field, where the provider writes an empty string for a missing value.
 *
 * `admin1_code` is empty on 25 rows rather than null, so a plain `?? ABSENT` renders a blank
 * value with a label above it and nothing to say why. Same class of trap as Digitraffic's
 * empty `destination`.
 */
export function codeText(code: string | null | undefined): string {
  return hasText(code) ? code : ABSENT;
}

/**
 * The transliterated name, shown only when it is not the name.
 *
 * It differs on 7,085 of 34,099 rows and both spellings are indexed for search, so it is
 * worth showing when it says something. A row reading "London / London" is noise. Null
 * rather than `ABSENT`, because a name that matches is not a missing field.
 */
export function asciiNameText(city: City): string | null {
  return city.ascii_name === city.name ? null : city.ascii_name;
}

/** The subtitle: what kind of place, in which country, under which GeoNames id. */
export function placeSubtitle(city: City): string {
  return [featureText(city.feature_code), city.country_code, `GeoNames ${city.geonames_id}`].join(
    ' · ',
  );
}

export interface PlaceCardOptions {
  onClose: () => void;
}

export class PlaceCard {
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly fields: HTMLElement;
  private readonly credit: HTMLElement;
  private city: City | null = null;
  private attribution: readonly AttributionEntry[] = [];
  private readonly root: HTMLElement;
  private readonly options: PlaceCardOptions;

  /**
   * Built with `createElement` rather than the `innerHTML` template the two mover cards use.
   *
   * Same markup and the same class names, so one stylesheet covers all of them. The
   * difference is that a card assembled node by node can be painted in the node test runner
   * against a fake element, the way `StatusBanner` and `AttributionPanel` already are, which
   * is how a mistake in this template fails a test rather than reaching a browser.
   */
  constructor(root: HTMLElement, options: PlaceCardOptions) {
    this.root = root;
    this.options = options;
    root.classList.add('card');
    root.setAttribute('aria-label', 'Selected place');

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
    // `disc`, from the same five silhouettes the globe draws, so the family is the module's
    // rather than a second style invented here. It is the one shape in the set that points
    // nowhere, which is right for a place: a city has no heading and no state, so this icon
    // labels the type and encodes nothing. Painted once, for the same reason.
    const icon = cardIconElement();
    paintCardIcon(icon, 'disc', PLACE_COLOUR);
    identity.append(icon, headings);
    const close = document.createElement('button');
    close.className = 'card-close';
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close card, Escape');
    close.textContent = 'Close';
    head.append(identity, close);

    this.fields = document.createElement('dl');
    this.fields.className = 'card-fields';
    this.credit = document.createElement('footer');
    this.credit.className = 'card-credit';

    root.append(head, this.fields, this.credit);

    close.addEventListener('click', () => {
      this.options.onClose();
    });
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.city !== null) {
        this.options.onClose();
      }
    });

    this.hide();
  }

  /**
   * Licence credits. Not optional on this card: CC BY 4.0 makes the GeoNames credit a
   * condition of using the data, so a card shown without it is a licence breach rather than
   * a missing nicety.
   */
  setAttribution(entries: readonly AttributionEntry[]): void {
    this.attribution = entries;
    if (this.city !== null) {
      this.show(this.city);
    }
  }

  /** Take one gazetteer row, or null to close the card. */
  show(city: City | null): void {
    if (city === null) {
      this.hide();
      return;
    }
    this.city = city;

    this.root.hidden = false;
    this.title.textContent = city.name;
    this.subtitle.textContent = placeSubtitle(city);

    const ascii = asciiNameText(city);
    // GeoNames' own transliteration rather than a mechanical one: Köln becomes Koeln, not
    // Koln. Both spellings resolve in search, so the second one is worth a row of its own
    // when there is a second one, and no row at all when the two are the same string.
    const transliterated: readonly [string, string][] =
      ascii === null ? [] : [['Transliterated', ascii]];
    this.fields.replaceChildren(
      ...rows([
        ['Name', city.name],
        ...transliterated,
        ['Place type', featureText(city.feature_code)],
        // Codes, labelled as codes. No country name and no region name is asserted: see the
        // module comment.
        ['Country code', city.country_code],
        // The provider's own field name, `admin1`, rather than "First-order administrative
        // division": the label column holds 16 characters and this is what a reader would
        // search GeoNames for.
        ['Admin 1 code', codeText(city.admin1_code)],
        ['Population', populationText(city.population)],
        ['Time zone', city.timezone],
        ['Elevation', elevationText(city.elevation_m)],
        ['Position', `${city.point.lon.toFixed(4)}, ${city.point.lat.toFixed(4)}`],
        // A bare date, printed as it arrived. There is no time and no zone anywhere in the
        // source file, so rendering it through a timestamp formatter would invent a midnight
        // GeoNames never published.
        ['Row updated', city.modification_date],
      ]),
    );

    this.credit.textContent = creditFor(this.attribution, CITY_SOURCE);
  }

  hide(): void {
    this.city = null;
    this.root.hidden = true;
  }
}
