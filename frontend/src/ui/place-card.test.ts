/**
 * The place card, logic and painting both.
 *
 * Painted against a fake element for the same reason the credits menu and the status banner
 * are: the runner has no document, and a real one would prove nothing this does not. What a
 * real browser proves is in `e2e/smoke.spec.ts`.
 *
 * Most of what is asserted here is a refusal rather than a rendering. GeoNames gives us codes
 * where a reader wants names, an empty string where a reader wants a null, a zero where a
 * reader wants a population and a bare date where a reader wants a timestamp, and every one
 * of those turns into a plausible-looking wrong answer if it is passed straight through.
 *
 * The fake element is duplicated from `satellite-card.test.ts` rather than shared. Lifting it
 * into `src/testing/` would be the tidier answer and is a change to a file three other agents
 * are in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CITY_SOURCE,
  PlaceCard,
  asciiNameText,
  codeText,
  elevationText,
  featureText,
  placeSubtitle,
  PLACE_COLOUR,
  populationText,
} from './place-card';
import { CARD_ICON_PX } from './card';
import { iconImage } from '../globe/icons';
import { makeCity } from '../testing/city';
import type { AttributionEntry } from '../types/entities';

/**
 * The credit as `app.py` publishes it.
 *
 * Both links are in there deliberately: CC BY 4.0 asks for a link to the source and a link to
 * the licence, and the credit contract has one URL field, so the licence link rides in the
 * licence string.
 */
const GEONAMES: AttributionEntry = {
  source: 'geonames',
  text: 'City data from GeoNames, CC BY 4.0',
  url: 'https://www.geonames.org/',
  licence: 'CC BY 4.0, https://creativecommons.org/licenses/by/4.0/',
  // Single-source fixture, so no grouped-credit operators and no licence date.
  operators: [],
};

const GEONAMES_CREDIT =
  'City data from GeoNames, CC BY 4.0 (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/)';

describe('CITY_SOURCE', () => {
  it('matches the attribution the API files the gazetteer under', () => {
    // `City` carries no `source` field, so this constant is the only thing joining a city
    // record to its credit. A typo here is a card with no credit on it, which for CC BY 4.0
    // is a licence breach rather than a cosmetic miss.
    expect(GEONAMES.source).toBe(CITY_SOURCE);
  });
});

describe('featureText', () => {
  it('reads the common codes back in words and keeps the code', () => {
    // The five biggest by row count in the real file, plus the capital code.
    expect(featureText('PPL')).toBe('Populated place (PPL)');
    expect(featureText('PPLA2')).toBe('Second-order administrative seat (PPLA2)');
    expect(featureText('PPLA3')).toBe('Third-order administrative seat (PPLA3)');
    expect(featureText('PPLX')).toBe('Section of a populated place (PPLX)');
    expect(featureText('PPLC')).toBe('National capital (PPLC)');
  });

  it('covers the codes that are not PPL-prefixed', () => {
    // 2 rows, and the reason the contract does not constrain this field to a pattern.
    expect(featureText('STLMT')).toBe('Israeli settlement (STLMT)');
  });

  it('prints an unrecognised code rather than guessing at a meaning for it', () => {
    expect(featureText('PPLZ')).toBe('PPLZ');
    // A Map, so a value off a bulk file cannot reach Object.prototype.
    expect(featureText('constructor')).toBe('constructor');
  });
});

describe('populationText', () => {
  it('groups the provider figure', () => {
    expect(populationText(8_961_989)).toBe('8,961,989');
    expect(populationText(15_000)).toBe('15,000');
  });

  it('treats zero as not available rather than as no inhabitants', () => {
    // 3 of the 34,099 rows report 0. A gazetteer of settlements does not contain a
    // settlement with nobody in it, so 0 is the provider saying it does not know.
    expect(populationText(0)).toBe('not reported');
  });
});

describe('elevationText', () => {
  it('names mean sea level, because that is not this project datum', () => {
    // Every other altitude here is metres above the WGS84 ellipsoid and the two differ by up
    // to about 100 metres, so the datum has to be on the card.
    expect(elevationText(25)).toBe('25 m above mean sea level');
    // The lowest value in the real file. A negative elevation is legal.
    expect(elevationText(-34)).toBe('-34 m above mean sea level');
    expect(elevationText(3831)).toBe('3,831 m above mean sea level');
  });

  it('says nothing when the provider gave no elevation', () => {
    // Absent on 29,612 of 34,099 rows, which makes this the common case rather than the edge.
    expect(elevationText(null)).toBe('not reported');
    expect(elevationText(undefined)).toBe('not reported');
  });
});

describe('codeText', () => {
  it('passes a code through', () => {
    expect(codeText('ENG')).toBe('ENG');
  });

  it('treats the provider empty string as absent', () => {
    // `admin1_code` is empty rather than null on 25 rows, so `?? ABSENT` alone paints a label
    // with a blank beside it and nothing to say why.
    expect(codeText('')).toBe('not reported');
    expect(codeText(null)).toBe('not reported');
    expect(codeText(undefined)).toBe('not reported');
  });
});

describe('asciiNameText', () => {
  it('says nothing when the transliteration is the name', () => {
    // True on 27,014 of 34,099 rows, so a row reading "London / London" would be the norm.
    expect(asciiNameText(makeCity())).toBeNull();
  });

  it('carries the provider transliteration when it differs', () => {
    // GeoNames' own, not a mechanical one: Köln becomes Koeln rather than Koln, and both
    // spellings are indexed for search.
    expect(asciiNameText(makeCity({ name: 'Köln', ascii_name: 'Koeln' }))).toBe('Koeln');
  });
});

describe('placeSubtitle', () => {
  it('names the kind of place, the country code and the merge key', () => {
    expect(placeSubtitle(makeCity())).toBe('National capital (PPLC) · GB · GeoNames 2643743');
  });
});

type Listener = (event: unknown) => void;

/** Enough of an element to paint a card into and read it back. */
class FakeElement {
  readonly tag: string;
  readonly children: FakeElement[] = [];
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string): void => {
      this.classes.add(name);
    },
  };
  readonly attributes: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  className = '';
  textContent = '';
  hidden = false;

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  addEventListener(type: string, listener: Listener): void {
    const held = this.listeners.get(type);
    if (held === undefined) {
      this.listeners.set(type, [listener]);
      return;
    }
    held.push(listener);
  }

  fire(type: string): void {
    const held = this.listeners.get(type) ?? [];
    for (const listener of held) {
      listener({});
    }
  }

  /** The first descendant carrying this class, or a thrown error naming the class. */
  find(className: string): FakeElement {
    const found = this.search(className);
    if (found === null) {
      throw new Error(`no .${className} in the painted card`);
    }
    return found;
  }

  /** Every descendant with this tag, in document order. */
  all(tag: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (child.tag === tag) {
        found.push(child);
      }
      found.push(...child.all(tag));
    }
    return found;
  }

  private search(className: string): FakeElement | null {
    for (const child of this.children) {
      if (child.className === className) {
        return child;
      }
      const deeper = child.search(className);
      if (deeper !== null) {
        return deeper;
      }
    }
    return null;
  }
}

function asElement(fake: FakeElement): HTMLElement {
  return fake as unknown as HTMLElement;
}

/** The definition list read back as label-and-value pairs. */
function pairs(root: FakeElement): [string, string][] {
  const list = root.find('card-fields');
  const terms = list.all('dt');
  const details = list.all('dd');
  return terms.map((term, index) => [term.textContent, details[index]?.textContent ?? '']);
}

function rowValue(root: FakeElement, label: string): string | undefined {
  return pairs(root).find(([name]) => name === label)?.[1];
}

describe('PlaceCard', () => {
  let root: FakeElement;
  let card: PlaceCard;
  let closed: number;
  let keydown: Listener[];

  beforeEach(() => {
    keydown = [];
    vi.stubGlobal('document', {
      createElement: (tag: string): FakeElement => new FakeElement(tag),
      addEventListener: (type: string, listener: Listener): void => {
        if (type === 'keydown') {
          keydown.push(listener);
        }
      },
    });
    closed = 0;
    root = new FakeElement('aside');
    card = new PlaceCard(asElement(root), {
      onClose: () => {
        closed += 1;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names itself for a screen reader and starts hidden', () => {
    expect(root.classes.has('card')).toBe(true);
    expect(root.attributes['aria-label']).toBe('Selected place');
    expect(root.hidden).toBe(true);
  });

  it('gives the close button an accessible name that says how to use the keyboard', () => {
    const close = root.find('card-close');
    expect(close.attributes['aria-label']).toBe('Close card, Escape');
    expect(close.attributes['type']).toBe('button');
    expect(close.textContent).toBe('Close');
  });

  it('heads the card with a disc from the same five silhouettes the globe draws', () => {
    // `disc` is the one shape in the set that points nowhere, which is right for a place: a
    // city has no heading and no state, so this labels the type and encodes nothing.
    const icon = root.find('card-icon');

    expect(icon.attributes['src']).toBe(iconImage('disc', PLACE_COLOUR, true, CARD_ICON_PX));
    expect(icon.attributes['alt']).toBe('');
  });

  it('takes the city layer own label grey rather than borrowing a mover hue', () => {
    // A saturated hue here would read as a state this record does not have, and every mover
    // colour in the app already means something.
    expect(PLACE_COLOUR).toBe('#b6c6d3');
    expect(root.find('card-icon').attributes['src']).toContain(encodeURIComponent(PLACE_COLOUR));
  });

  it('keeps one icon across selections, because no city changes it', () => {
    card.show(makeCity());
    const first = root.find('card-icon').attributes['src'];
    card.show(makeCity({ geonames_id: 1, name: 'Ely', population: 20_112 }));

    expect(root.find('card-icon').attributes['src']).toBe(first);
  });

  it('paints the real London row from the gazetteer', () => {
    card.show(makeCity());

    expect(root.hidden).toBe(false);
    expect(root.find('card-title').textContent).toBe('London');
    expect(root.find('card-subtitle').textContent).toBe(
      'National capital (PPLC) · GB · GeoNames 2643743',
    );
    expect(pairs(root)).toStrictEqual([
      ['Name', 'London'],
      ['Place type', 'National capital (PPLC)'],
      ['Country code', 'GB'],
      ['Admin 1 code', 'ENG'],
      ['Population', '8,961,989'],
      ['Time zone', 'Europe/London'],
      ['Elevation', '25 m above mean sea level'],
      ['Position', '-0.1257, 51.5085'],
      ['Row updated', '2026-08-18'],
    ]);
  });

  it('adds a transliteration row only when there is a second spelling', () => {
    card.show(makeCity({ name: 'Köln', ascii_name: 'Koeln' }));
    expect(rowValue(root, 'Transliterated')).toBe('Koeln');

    card.show(makeCity());
    expect(rowValue(root, 'Transliterated')).toBeUndefined();
  });

  it('puts longitude first, the way every contract here does', () => {
    // Both values are on screen and both are plausible latitudes for a European city, so a
    // flip here returns a valid answer about the wrong place and nobody notices.
    card.show(makeCity({ point: { lon: 24.93545, lat: 60.16952, altitude_m: null } }));
    expect(rowValue(root, 'Position')).toBe('24.9354, 60.1695');
  });

  it('prints the modification date as the bare date the file holds', () => {
    // No time and no zone anywhere in `cities15000.txt`, so a timestamp formatter here would
    // invent a midnight GeoNames never published.
    card.show(makeCity({ modification_date: '2006-01-15' }));
    expect(rowValue(root, 'Row updated')).toBe('2006-01-15');
  });

  it('leaves the rows the provider left empty empty', () => {
    card.show(makeCity({ admin1_code: '', elevation_m: null, population: 0 }));
    expect(rowValue(root, 'Admin 1 code')).toBe('not reported');
    expect(rowValue(root, 'Elevation')).toBe('not reported');
    expect(rowValue(root, 'Population')).toBe('not reported');
  });

  it('asserts no country name and no region name', () => {
    // Resolving either code needs a GeoNames file this project does not fetch, and the admin
    // code is not consistently a FIPS code either: London GB carries ENG.
    card.show(makeCity());
    const painted = pairs(root)
      .map(([name, value]) => `${name}: ${value}`)
      .join(' | ');
    expect(painted).not.toContain('United Kingdom');
    expect(painted).not.toContain('England');
  });

  it('carries the CC BY 4.0 credit, which is a licence condition rather than a courtesy', () => {
    card.setAttribution([GEONAMES]);
    card.show(makeCity());
    expect(root.find('card-credit').textContent).toBe(GEONAMES_CREDIT);
    expect(root.find('card-credit').textContent).toContain(
      'https://creativecommons.org/licenses/by/4.0/',
    );
  });

  it('names the source even before the credits arrive', () => {
    // A card with an unnamed source is worse than a card with a bare one.
    card.show(makeCity());
    expect(root.find('card-credit').textContent).toBe('Source: geonames');
  });

  it('repaints an open card when the credits arrive after the selection', () => {
    card.show(makeCity());
    card.setAttribution([GEONAMES]);
    expect(root.find('card-credit').textContent).toBe(GEONAMES_CREDIT);
  });

  it('does not repaint a closed card when the credits arrive', () => {
    card.setAttribution([GEONAMES]);
    expect(root.hidden).toBe(true);
    expect(root.find('card-credit').textContent).toBe('');
  });

  it('closes on the close button', () => {
    card.show(makeCity());
    root.find('card-close').fire('click');
    expect(closed).toBe(1);
  });

  it('closes on Escape only while something is selected', () => {
    for (const listener of keydown) {
      listener({ key: 'Escape' });
    }
    expect(closed).toBe(0);

    card.show(makeCity());
    for (const listener of keydown) {
      listener({ key: 'Escape' });
    }
    expect(closed).toBe(1);
  });

  it('ignores every other key', () => {
    card.show(makeCity());
    for (const listener of keydown) {
      listener({ key: 'p' });
    }
    expect(closed).toBe(0);
  });

  it('hides on a null selection', () => {
    card.show(makeCity());
    card.show(null);
    expect(root.hidden).toBe(true);
  });

  it('runs no timer, because a city does not go stale', () => {
    // The mover cards tick once a second to keep a fix age honest. There is no fix here and
    // nothing moves, so a ticker would be work done to display a number that cannot change.
    vi.useFakeTimers();
    card.show(makeCity());
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
