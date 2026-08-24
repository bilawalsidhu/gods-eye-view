/**
 * The satellite card, logic and painting both.
 *
 * Painted against a fake element for the same reason the credits menu and the status banner
 * are: the runner has no document, and a real one would prove nothing this does not. What a
 * real browser proves is in `e2e/smoke.spec.ts`. Painting is covered here rather than left to
 * that suite because a template mistake in a card is a card that renders nothing, and the two
 * mover cards build their markup with `innerHTML`, which is exactly why theirs cannot be.
 *
 * The fake is duplicated in `place-card.test.ts` rather than shared. Lifting it into
 * `src/testing/` would be the tidier answer and is a change to a file three other agents are
 * in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ELEMENT_AGE_INTERVAL_SECONDS,
  EPOCH_UNREADABLE,
  NOT_DRAWN,
  SATELLITE_ORIGIN_SOURCE,
  STALE_ELEMENT_AGE_SECONDS,
  SatelliteCard,
  altitudeText,
  classificationText,
  elementAgeLine,
  elementAgeSeconds,
  elementAgeSeverity,
  orbitalPeriodText,
  positionLine,
  satelliteCreditText,
  satelliteSubtitle,
  satelliteTitle,
  utcText,
} from './satellite-card';
// The shared icon plumbing, imported so the assertion is against what `globe/icons.ts` actually
// generates rather than a string typed out here.
import { CARD_ICON_PX } from './card';
import { iconImage } from '../globe/icons';
import { SATELLITE_COLOUR } from '../globe/layers/satellites';
// The propagator's own staleness limit, imported here and nowhere in the shipped card: the
// card holds its own copy of the number so that satellite.js stays out of the main bundle,
// and this is the assertion that stops the copy drifting.
import { STALE_EPOCH_AGE_MS } from '../globe/satellites/orbit';
import { issElements, makeSatellite } from '../testing/satellite';
import type { AttributionEntry } from '../types/entities';

/** The credit as `app.py` publishes it, licence wording included, character for character. */
const CELESTRAK: AttributionEntry = {
  source: 'CelesTrak',
  text: 'Orbital element sets from CelesTrak',
  url: 'https://celestrak.org',
  licence: 'Not stated by the provider; credit is courtesy',
  // Single-source fixture, so no grouped-credit operators and no licence date.
  operators: [],
};

const CELESTRAK_CREDIT =
  'Orbital element sets from CelesTrak (Not stated by the provider; credit is courtesy)';

describe('STALE_ELEMENT_AGE_SECONDS', () => {
  it('is the same limit the propagator applies', () => {
    // The card calls an element set red exactly where the layer stops drawing the object. If
    // the two ever disagree the card is either crying wolf or reporting a drawn satellite
    // that is not on the globe.
    expect(STALE_ELEMENT_AGE_SECONDS).toBe(STALE_EPOCH_AGE_MS / 1000);
    expect(ELEMENT_AGE_INTERVAL_SECONDS).toBe(STALE_ELEMENT_AGE_SECONDS / 4);
  });
});

describe('elementAgeSeconds', () => {
  it('measures from the element set epoch', () => {
    const record = makeSatellite({ epoch: '2026-08-19T12:00:00Z' });
    expect(elementAgeSeconds(record, Date.parse('2026-08-19T13:00:00Z'))).toBe(3600);
  });

  it('reads the real recorded ISS epoch, fractional seconds and all', () => {
    // `+00:00` is the one suffix that breaks the propagator, so the fixture serialises a `Z`
    // and this is the card reading the same string back.
    const age = elementAgeSeconds(issElements(), Date.parse('2026-08-19T12:48:46.640Z'));
    expect(age).toBeCloseTo(0, 3);
  });

  it('answers null rather than NaN when the epoch will not parse', () => {
    // A NaN here would reach `formatAge` and paint "NaNs ago", which reads as a bug in the
    // copy rather than as an element set nothing can vouch for.
    expect(elementAgeSeconds(makeSatellite({ epoch: 'not a timestamp' }))).toBeNull();
  });
});

describe('elementAgeLine', () => {
  it('says the position is computed rather than observed', () => {
    expect(elementAgeLine(90)).toBe(
      'Element set fitted 1m 30s ago · position computed here, not observed',
    );
  });

  it('says so when the epoch could not be read', () => {
    expect(elementAgeLine(null)).toBe(EPOCH_UNREADABLE);
  });
});

describe('elementAgeSeverity', () => {
  it('stays fresh inside two intervals', () => {
    expect(elementAgeSeverity(0)).toBe('fresh');
    expect(elementAgeSeverity(ELEMENT_AGE_INTERVAL_SECONDS * 2)).toBe('fresh');
  });

  it('turns amber past two intervals', () => {
    expect(elementAgeSeverity(ELEMENT_AGE_INTERVAL_SECONDS * 2 + 1)).toBe('amber');
  });

  it('turns red exactly where the propagator stops drawing the object', () => {
    expect(elementAgeSeverity(STALE_ELEMENT_AGE_SECONDS)).toBe('amber');
    expect(elementAgeSeverity(STALE_ELEMENT_AGE_SECONDS + 1)).toBe('red');
  });

  it('treats an unreadable epoch as red', () => {
    expect(elementAgeSeverity(null)).toBe('red');
  });
});

describe('classificationText', () => {
  it('reads the three published codes back in words', () => {
    expect(classificationText('U')).toBe('Unclassified');
    expect(classificationText('C')).toBe('Classified');
    expect(classificationText('S')).toBe('Secret');
  });

  it('prints an unrecognised code rather than guessing at it', () => {
    expect(classificationText('X')).toBe('X');
    // A Map, so a field off the wire cannot reach Object.prototype.
    expect(classificationText('constructor')).toBe('constructor');
  });
});

describe('orbitalPeriodText', () => {
  it('derives the period from the broadcast mean motion', () => {
    // The real recorded ISS element set: 15.4951252 revolutions a day is a 92.9 minute orbit.
    expect(orbitalPeriodText(issElements().mean_motion)).toBe('92.9 min (15.4951 rev/day)');
  });

  it('says nothing rather than printing an infinite period', () => {
    // The contract refuses a mean motion at or below zero because SGP4 cannot propagate one.
    // A zero arriving anyway would render as "Infinity min" without this.
    expect(orbitalPeriodText(0)).toBe('not reported');
    expect(orbitalPeriodText(-1)).toBe('not reported');
    expect(orbitalPeriodText(NaN)).toBe('not reported');
  });
});

describe('altitudeText', () => {
  it('reads in kilometres and names the datum', () => {
    expect(altitudeText(421_300)).toBe('421 km above the ellipsoid');
    // Geostationary, grouped, because 35786 km is harder to read than 35,786 km.
    expect(altitudeText(35_786_000)).toBe('35,786 km above the ellipsoid');
  });
});

describe('positionLine', () => {
  it('leads with the word computed and puts longitude first', () => {
    expect(positionLine({ lon: -0.1257, lat: 51.5085, altitudeM: 421_300 })).toBe(
      'Computed position -0.1257, 51.5085 · 421 km above the ellipsoid',
    );
  });

  it('says the object is not drawn rather than holding the last position', () => {
    // Null is a normal answer: an element set past 3.5 days is held back deliberately and
    // SGP4 refuses a decayed one. Keeping the last position on screen would be the lie.
    expect(positionLine(null)).toBe(NOT_DRAWN);
  });
});

describe('utcText', () => {
  it('renders a contract timestamp as UTC and says UTC', () => {
    expect(utcText('2026-08-19T12:48:46.640160Z')).toBe('2026-08-19 12:48 UTC');
    expect(utcText('2026-08-19T13:00:00Z')).toBe('2026-08-19 13:00 UTC');
  });

  it('prints an unparseable string as it arrived', () => {
    expect(utcText('whenever')).toBe('whenever');
  });
});

describe('satelliteTitle', () => {
  it('uses the published name', () => {
    expect(satelliteTitle(issElements())).toBe('ISS (ZARYA)');
  });

  it('falls back to the catalogue number for an analyst object with no name', () => {
    // The 80000 series carries no name at all, and a card headed "not reported" names
    // nothing. The Name row below still reads absent; this is the identity, not a default.
    expect(satelliteTitle(makeSatellite({ norad_cat_id: 80_042, object_name: null }))).toBe(
      'NORAD 80042',
    );
  });
});

describe('satelliteSubtitle', () => {
  it('names the catalogue number and the international designator', () => {
    expect(satelliteSubtitle(issElements())).toBe('NORAD 25544 · 1998-067A');
  });

  it('drops the designator rather than inventing a placeholder for it', () => {
    expect(satelliteSubtitle(makeSatellite({ norad_cat_id: 80_042, object_id: null }))).toBe(
      'NORAD 80042',
    );
  });
});

describe('the subtitle', () => {
  it('says nothing that does not vary between records', () => {
    // The word "Satellite" was the same string on every one of them, and it wrapped the header
    // onto a third line to repeat what the icon, the root's accessible name and four rows below
    // already say. The catalogue number and the designator both vary; that is the test.
    expect(satelliteSubtitle(issElements())).not.toContain('Satellite');
    expect(satelliteSubtitle(issElements())).toContain('25544');
  });
});

describe('satelliteCreditText', () => {
  it('carries the provider licence position through unedited', () => {
    // CelesTrak grants nothing and asks for a courtesy credit. The card must not upgrade
    // that into a licence, so the string the API serves is the string that is painted.
    expect(satelliteCreditText([CELESTRAK], SATELLITE_ORIGIN_SOURCE)).toBe(CELESTRAK_CREDIT);
    expect(satelliteCreditText([CELESTRAK], SATELLITE_ORIGIN_SOURCE)).toContain(
      'Not stated by the provider',
    );
  });

  it('treats the record source celestrak as the origin, not as a mirror', () => {
    // `Satellite.source` is lowercase `celestrak` while the credit is filed under
    // `CelesTrak`, so a case-sensitive comparison would paint "served through celestrak".
    expect(satelliteCreditText([CELESTRAK], 'celestrak')).toBe(CELESTRAK_CREDIT);
  });

  it('names the mirror the copy came through as well as the origin', () => {
    // Two of the three provider rows are republishers of CelesTrak. Crediting only the
    // record's own source would drop the origin credit; crediting only the origin would
    // hide where the bytes actually came from.
    expect(satelliteCreditText([CELESTRAK], 'retlector')).toBe(
      `${CELESTRAK_CREDIT} · served through retlector`,
    );
    expect(satelliteCreditText([CELESTRAK], 'satvisor')).toBe(
      `${CELESTRAK_CREDIT} · served through satvisor`,
    );
  });

  it('names the origin with no licence claim when the API credited nothing', () => {
    expect(satelliteCreditText([], 'retlector')).toBe(
      'Source: CelesTrak · served through retlector',
    );
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

describe('SatelliteCard', () => {
  let root: FakeElement;
  let card: SatelliteCard;
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
    vi.useFakeTimers();
    // An hour after the recorded ISS epoch, so every age on the card is a known number.
    vi.setSystemTime(Date.parse('2026-08-19T13:48:46.640Z'));
    closed = 0;
    root = new FakeElement('aside');
    card = new SatelliteCard(asElement(root), {
      onClose: () => {
        closed += 1;
      },
    });
  });

  afterEach(() => {
    card.hide();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('names itself for a screen reader and starts hidden', () => {
    expect(root.classes.has('card')).toBe(true);
    expect(root.attributes['aria-label']).toBe('Selected satellite');
    expect(root.hidden).toBe(true);
  });

  it('gives the close button an accessible name that says how to use the keyboard', () => {
    const close = root.find('card-close');
    expect(close.attributes['aria-label']).toBe('Close card, Escape');
    expect(close.attributes['type']).toBe('button');
    expect(close.textContent).toBe('Close');
  });

  it('heads the card with the silhouette the globe draws, in the layer own hue', () => {
    // Straight out of `globe/icons.ts`, so the card and the globe cannot disagree about what a
    // satellite looks like, and in `SATELLITE_COLOUR` so it is the same object either way.
    const icon = root.find('card-icon');

    expect(icon.attributes['src']).toBe(iconImage('diamond', SATELLITE_COLOUR, true, CARD_ICON_PX));
    // Decorative: the title and subtitle beside it already say this is a satellite.
    expect(icon.attributes['alt']).toBe('');
  });

  it('paints the icon before any record arrives, because nothing about it varies', () => {
    // One hue for the whole catalogue and no per-satellite classification, so an icon that
    // changed with the selection would claim a distinction the data does not make. Painted in
    // the constructor, which is why it is already there on a card that has never been shown.
    expect(root.hidden).toBe(true);
    expect(root.find('card-icon').attributes['src']).toContain('data:image/svg+xml,');
  });

  it('keeps the icon through a selection change', () => {
    card.show(issElements());
    const first = root.find('card-icon').attributes['src'];
    card.show(makeSatellite());

    expect(root.find('card-icon').attributes['src']).toBe(first);
  });

  it('marks the two lines that change on their own as live regions', () => {
    expect(root.find('card-age').attributes['aria-live']).toBe('polite');
    expect(root.find('card-position').attributes['aria-live']).toBe('polite');
  });

  it('paints the element set the backend served', () => {
    card.show(issElements());

    expect(root.hidden).toBe(false);
    expect(root.find('card-title').textContent).toBe('ISS (ZARYA)');
    expect(root.find('card-subtitle').textContent).toBe('NORAD 25544 · 1998-067A');
    expect(pairs(root)).toStrictEqual([
      ['Name', 'ISS (ZARYA)'],
      ['Catalogue number', 'NORAD 25544'],
      ['Designator', '1998-067A'],
      ['Classification', 'Unclassified'],
      ['Element epoch', '2026-08-19 12:48 UTC'],
      ['Copy fetched', '2026-08-19 13:00 UTC'],
      ['Orbital period', '92.9 min (15.4951 rev/day)'],
      ['Inclination', '51.63°'],
      ['Eccentricity', '0.000766'],
      ['CelesTrak group', 'stations'],
      ['Served through', 'celestrak'],
    ]);
  });

  it('keeps the epoch and the fetch time as separate facts', () => {
    // How current the orbit determination is, against how current our copy of it is. Only
    // the first one decides whether the computed position is worth drawing.
    card.show(issElements({ fetched_at: '2026-08-19T13:40:00Z' }));
    expect(rowValue(root, 'Element epoch')).toBe('2026-08-19 12:48 UTC');
    expect(rowValue(root, 'Copy fetched')).toBe('2026-08-19 13:40 UTC');
  });

  it('reports the age of the element set, not the age of the propagation', () => {
    card.show(issElements());
    const age = root.find('card-age');
    expect(age.textContent).toBe(
      'Element set fitted 1h 0m ago · position computed here, not observed',
    );
    expect(age.dataset['severity']).toBe('fresh');
  });

  it('turns the age line red once the propagator would stop drawing the object', () => {
    card.show(issElements({ epoch: '2026-08-15T00:00:00Z' }));
    expect(root.find('card-age').dataset['severity']).toBe('red');
  });

  it('reruns the age line on its own once a second', () => {
    card.show(issElements());
    vi.advanceTimersByTime(120_000);
    expect(root.find('card-age').textContent).toBe(
      'Element set fitted 1h 2m ago · position computed here, not observed',
    );
  });

  it('says the object is not drawn until a position arrives', () => {
    card.show(issElements());
    expect(root.find('card-position').textContent).toBe(NOT_DRAWN);
  });

  it('paints a computed position without rebuilding the element set rows', () => {
    card.show(issElements());
    const before = root.find('card-fields');
    card.setPosition({ lon: -0.1257, lat: 51.5085, altitudeM: 421_300 });
    expect(root.find('card-position').textContent).toBe(
      'Computed position -0.1257, 51.5085 · 421 km above the ellipsoid',
    );
    // The same node, not a rebuilt one: the position ticks with the propagation and the
    // published elements do not.
    expect(root.find('card-fields')).toBe(before);
  });

  it('drops back to saying nothing is drawn when the propagator stops answering', () => {
    card.show(issElements());
    card.setPosition({ lon: 1, lat: 2, altitudeM: 400_000 });
    card.setPosition(null);
    expect(root.find('card-position').textContent).toBe(NOT_DRAWN);
  });

  it('leaves the name row absent for an object CelesTrak did not name', () => {
    card.show(makeSatellite({ norad_cat_id: 80_042, object_name: null, object_id: null }));
    expect(root.find('card-title').textContent).toBe('NORAD 80042');
    expect(rowValue(root, 'Name')).toBe('not reported');
    expect(rowValue(root, 'Designator')).toBe('not reported');
  });

  it('credits CelesTrak and names the mirror the copy came through', () => {
    card.setAttribution([CELESTRAK]);
    card.show(makeSatellite({ source: 'retlector' }));
    expect(root.find('card-credit').textContent).toBe(
      `${CELESTRAK_CREDIT} · served through retlector`,
    );
  });

  it('repaints an open card when the credits arrive after the selection', () => {
    card.show(makeSatellite({ source: 'celestrak' }));
    expect(root.find('card-credit').textContent).toBe('Source: CelesTrak');
    card.setAttribution([CELESTRAK]);
    expect(root.find('card-credit').textContent).toBe(CELESTRAK_CREDIT);
  });

  it('does not repaint a closed card when the credits arrive', () => {
    card.setAttribution([CELESTRAK]);
    expect(root.hidden).toBe(true);
    expect(root.find('card-credit').textContent).toBe('');
  });

  it('closes on the close button', () => {
    card.show(issElements());
    root.find('card-close').fire('click');
    expect(closed).toBe(1);
  });

  it('closes on Escape only while something is selected', () => {
    for (const listener of keydown) {
      listener({ key: 'Escape' });
    }
    expect(closed).toBe(0);

    card.show(issElements());
    for (const listener of keydown) {
      listener({ key: 'Escape' });
    }
    expect(closed).toBe(1);
  });

  it('ignores every other key', () => {
    card.show(issElements());
    for (const listener of keydown) {
      listener({ key: 'e' });
    }
    expect(closed).toBe(0);
  });

  it('hides on a null selection and stops the ticker', () => {
    card.show(issElements());
    card.show(null);
    expect(root.hidden).toBe(true);
    expect(root.find('card-position').textContent).toBe(NOT_DRAWN);
    // Nothing left running: a card that kept ticking would keep rewriting the age of an
    // element set nobody is looking at.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts one ticker across repeated selections', () => {
    card.show(issElements());
    card.show(makeSatellite());
    card.show(issElements());
    expect(vi.getTimerCount()).toBe(1);
  });
});
