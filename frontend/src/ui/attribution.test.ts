/**
 * The credits menu.
 *
 * These are licence conditions rather than decoration, so what is asserted here is that the
 * conditions survive: the list is never empty, the basemap credit is the same string Cesium
 * is handed, every entry keeps its own licence text, and the closed menu says how many
 * sources are behind it so the affordance is not a mystery button.
 *
 * Painted against a fake element for the same reason the layer rail is: the runner has no
 * document, and a real one would prove nothing this does not. What a real browser proves is
 * in `e2e/smoke.spec.ts`, which opens the menu and reads the links.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AttributionPanel,
  BASELINE_CREDITS,
  CLOUD_CREDIT_TEXT,
  CREDITS_GLYPH,
  GIBS_CREDIT_TEXT,
  creditsLabel,
  creditsToShow,
  lastUpdatedText,
  operatorsLabel,
} from './attribution';
import type { AttributionEntry } from '../types/entities';

const FINTRAFFIC: AttributionEntry = {
  source: 'Fintraffic',
  // The provider's exact wording, fixed by their terms of service. Never paraphrased.
  text: 'Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
  url: 'https://www.digitraffic.fi/en/terms-of-service/',
  licence: 'CC BY 4.0',
  // Single-source fixture, so no grouped-credit operators and no licence date.
  operators: [],
};

const GEONAMES: AttributionEntry = {
  source: 'geonames',
  text: 'City data from GeoNames, CC BY 4.0',
  url: 'https://www.geonames.org',
  licence: 'CC BY 4.0',
  // Single-source fixture, so no grouped-credit operators and no licence date.
  operators: [],
};

/**
 * The client-side cloud credit, as the panel renders it.
 *
 * Written out here rather than imported as a whole entry, so a change to its wording or its
 * licence line has to be made deliberately in two places rather than silently in one.
 */
const CLOUDS: AttributionEntry = {
  source: 'NASA GIBS clouds',
  text: CLOUD_CREDIT_TEXT,
  url: 'https://gibs.earthdata.nasa.gov',
  licence: 'Public domain, attribution requested',
  // Single-source fixture, so no grouped-credit operators and no licence date.
  operators: [],
};

class FakeElement {
  readonly tag: string;
  readonly children: (FakeElement | string)[] = [];
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string): void => {
      this.classes.add(name);
    },
  };
  readonly attributes: Record<string, string> = {};
  className = '';
  textContent = '';
  title = '';
  href = '';
  rel = '';
  target = '';

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  /** Child elements only, with the text between them dropped. */
  get elements(): FakeElement[] {
    return this.children.filter((child): child is FakeElement => typeof child !== 'string');
  }

  /** Everything a reader would see in this subtree, text nodes included. */
  get rendered(): string {
    return this.children
      .map((child) => (typeof child === 'string' ? child : child.textContent + child.rendered))
      .join('');
  }

  /** Enough of a selector for the two tag lookups the panel makes. */
  querySelector(tag: string): FakeElement | null {
    for (const child of this.elements) {
      if (child.tag === tag) {
        return child;
      }
      const deeper = child.querySelector(tag);
      if (deeper !== null) {
        return deeper;
      }
    }
    return null;
  }

  /** Every descendant with this tag, in document order. */
  all(tag: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.elements) {
      if (child.tag === tag) {
        found.push(child);
      }
      found.push(...child.all(tag));
    }
    return found;
  }
}

function asElement(fake: FakeElement): HTMLElement {
  return fake as unknown as HTMLElement;
}

/** The markup index.html ships: a summary and a list, already in place. */
function markup(): FakeElement {
  const root = new FakeElement('details');
  root.append(new FakeElement('summary'), new FakeElement('ul'));
  return root;
}

describe('creditsToShow', () => {
  it('falls back to the baseline when the API has not answered', () => {
    // Something is on the globe from the first frame, so something has to be credited. An
    // empty list from the API is an API that has not answered, not a deployment with no
    // sources.
    expect(creditsToShow([]).map((entry) => entry.text)).toStrictEqual([
      ...BASELINE_CREDITS.map((entry) => entry.text),
      CLOUD_CREDIT_TEXT,
    ]);
  });

  it('uses the API list when there is one, rather than adding to the baseline', () => {
    expect(creditsToShow([FINTRAFFIC])).toStrictEqual([FINTRAFFIC, CLOUDS]);
  });

  it('carries the cloud credit whatever the API serves, because the API cannot know', () => {
    // The cloud tiles go from NASA straight to the browser and our backend never sees them,
    // so `/api/capabilities` has no way to credit that layer and no business claiming to.
    // Cesium is handed this string by `globe/layers/clouds.ts`, and the e2e suite fails if a
    // credit Cesium holds is missing from this menu.
    expect(creditsToShow([FINTRAFFIC, GEONAMES]).map((entry) => entry.text)).toContain(
      CLOUD_CREDIT_TEXT,
    );
  });

  it('does not show the cloud credit twice if the API starts serving it too', () => {
    const served: AttributionEntry = { ...CLOUDS, source: 'nasa-gibs-clouds' };
    expect(creditsToShow([served])).toStrictEqual([served]);
  });
});

describe('creditsLabel', () => {
  it('says what the control is and counts what is behind it', () => {
    // A lone "i" tells a screen reader nothing, so this is the control's accessible name and
    // its tooltip. The count is here rather than on the button so the button stays one glyph.
    // Three, not two: the cloud layer's credit is added by the browser, because the API
    // cannot see a layer that never touches it.
    expect(creditsLabel([FINTRAFFIC, GEONAMES])).toBe('Data sources and licences (3)');
  });

  it('counts the baseline when the API has not answered', () => {
    expect(creditsLabel([])).toBe('Data sources and licences (3)');
  });
});

describe('BASELINE_CREDITS', () => {
  it('carries the basemap credit Cesium is handed, character for character', () => {
    // Two hand-typed copies of one credit is how a user ends up reading two different claims
    // about who the imagery belongs to. `globe/viewer.ts` imports this same constant.
    const gibs = BASELINE_CREDITS.find((entry) => entry.source === 'NASA GIBS');
    expect(gibs?.text).toBe(GIBS_CREDIT_TEXT);
  });

  it('credits the aircraft feed, which ODbL 1.0 requires wherever its data is shown', () => {
    const adsb = BASELINE_CREDITS.find((entry) => entry.source === 'adsb.lol');
    expect(adsb?.licence).toBe('ODbL 1.0');
    expect(adsb?.url).toBe('https://adsb.lol');
  });
});

describe('AttributionPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (tag: string): FakeElement => new FakeElement(tag),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the baseline before the API answers', () => {
    const root = markup();
    new AttributionPanel(asElement(root));

    expect(root.querySelector('summary')?.textContent).toBe(CREDITS_GLYPH);
    expect(root.all('li')).toHaveLength(3);
  });

  it('names the control for anyone who cannot see the glyph', () => {
    const root = markup();
    const panel = new AttributionPanel(asElement(root));

    panel.render([FINTRAFFIC, GEONAMES]);

    const summary = root.querySelector('summary');
    // The visible state is one letter. Everything that says what it is lives here and in the
    // tooltip, and both carry the count so it does not read as a mystery control.
    expect(summary?.textContent).toBe('i');
    expect(summary?.attributes['aria-label']).toBe('Data sources and licences (3)');
    expect(summary?.title).toBe('Data sources and licences (3)');
  });

  it('replaces the list rather than appending to it', () => {
    const root = markup();
    const panel = new AttributionPanel(asElement(root));

    panel.render([FINTRAFFIC, GEONAMES]);

    // Appending would show the baseline twice over, which is the bug the e2e suite also
    // guards: a credit rendered twice is a licence honoured once and a panel twice the size.
    expect(root.all('li')).toHaveLength(3);
    expect(root.querySelector('summary')?.attributes['aria-label']).toBe(
      'Data sources and licences (3)',
    );
  });

  it('renders every credit as a link to the source with its own licence beside it', () => {
    const root = markup();
    const panel = new AttributionPanel(asElement(root));

    panel.render([FINTRAFFIC]);

    const link = root.all('a')[0];
    // CC BY wants the credit and a link to the source, and Fintraffic fixes the wording in
    // its terms of service, so this string is reproduced rather than composed.
    expect(link?.textContent).toBe('Source: Fintraffic / digitraffic.fi, license CC 4.0 BY');
    expect(link?.href).toBe('https://www.digitraffic.fi/en/terms-of-service/');
    expect(link?.rel).toBe('noreferrer');
    expect(root.all('span')[0]?.textContent).toBe(' (CC BY 4.0)');
  });

  it('keeps the baseline on screen when the API answers with nothing', () => {
    const root = markup();
    const panel = new AttributionPanel(asElement(root));

    panel.render([]);

    expect(root.all('a')[0]?.textContent).toBe('Aircraft data from adsb.lol');
  });

  it('builds its own summary and list when handed a bare element', () => {
    // The panel is constructed against the markup in index.html, so the credits exist from
    // the first frame. A caller with a bare div still gets a working menu.
    const bare = new FakeElement('div');
    new AttributionPanel(asElement(bare));

    const tags = bare.elements.map((child) => child.tag);
    expect(tags).toStrictEqual(['div', 'ul']);
    expect(bare.elements.at(0)?.textContent).toBe(CREDITS_GLYPH);
  });
});

describe('the credits menu is the whole obligation', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (tag: string): FakeElement => new FakeElement(tag),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders every credit the API served, matched to nothing', () => {
    const root = markup();
    const panel = new AttributionPanel(asElement(root));
    const served: AttributionEntry[] = [
      FINTRAFFIC,
      GEONAMES,
      {
        source: 'adsbexchange',
        text: 'Unfiltered aircraft data from ADS-B Exchange',
        url: 'https://www.adsbexchange.com',
        licence: 'Paid RapidAPI key; redistribution prohibited without written permission',
        // Single-source fixture, so no grouped-credit operators and no licence date.
        operators: [],
      },
      {
        source: 'nominatim',
        // Nominatim's own string, carried on every record in its own `licence` field, and
        // reproduced here character for character. The plain-HTTP URL is theirs: rewriting a
        // licence notice to satisfy a linter is the one edit that is never allowed.
        // eslint-disable-next-line unicorn/prefer-https
        text: 'Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright',
        url: 'https://openstreetmap.org/copyright',
        licence: 'ODbL 1.0',
        // Single-source fixture, so no grouped-credit operators and no licence date.
        operators: [],
      },
    ];

    panel.render(served);

    // The layer rail used to match credits to layers and list the leftovers underneath. This
    // is stronger: nothing is matched, so a source the backend adds reaches the screen
    // whether or not anything here recognises its name. The cloud credit is on the end
    // because the browser adds it: no API list can carry a layer the API never sees.
    const shown = [...served, CLOUDS];
    const rendered = root.all('a').map((link) => link.textContent);
    expect(rendered).toStrictEqual(shown.map((entry) => entry.text));
    expect(root.all('span').map((node) => node.textContent)).toStrictEqual(
      shown.map((entry) => ` (${entry.licence})`),
    );
  });
});

/**
 * A grouped transit credit, in the shape the backend serves.
 *
 * Etalab 2.0 governs 101 of the 258 transit feeds and asks for the producer's name and the date
 * the information was last updated. Both are here, and both are why the transit layer could not
 * be publicly displayed until this rendered.
 */
const TRANSIT_GROUPED: AttributionEntry = {
  source: 'Transit feeds under Etalab 2.0',
  text: 'Transit vehicle positions from 101 French public transport authorities, Etalab 2.0',
  url: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence',
  licence: 'Etalab 2.0',
  as_of: '2026-08-24T09:14:32Z',
  operators: [
    { name: 'Île-de-France Mobilités', url: 'https://prim.iledefrance-mobilites.fr/en/cgu' },
    { name: 'Tisséo', url: 'https://data.toulouse-metropole.fr/pages/licence/' },
    { name: 'TAM Montpellier', url: 'https://data.montpellier3m.fr/licence' },
  ],
};

/**
 * A verbatim mandate, which is the row this file most has to leave alone.
 *
 * King County Metro requires its sentence "prominently displayed" and the City of Hamilton
 * reserves the right to require removal. Both have their own single-source rows, so neither
 * carries operators or a date, and nothing about the grouped rendering may reach them.
 */
const VERBATIM: AttributionEntry = {
  source: 'King County Metro',
  text:
    'Transit data provided by permission of King County. King County disclaims any warranty ' +
    'of merchantability or warranty of fitness of this material for any particular purpose.',
  url: 'https://kingcounty.gov/en/dept/metro/rider-tools/developer-resources',
  licence: 'Permission of King County, verbatim notice required',
  operators: [],
};

describe('lastUpdatedText', () => {
  it('is a date about the data, in UTC and saying so', () => {
    // Etalab asks for "the date the information was last updated", which is a fact about the
    // vehicles on screen rather than when the page loaded. UTC because a credit read in one
    // timezone about data timestamped in another is exactly the ambiguous case.
    expect(lastUpdatedText('2026-08-24T09:14:32Z')).toBe('2026-08-24 09:14 UTC');
  });

  it('does not depend on the machine reading it', () => {
    // A locale-formatted local time would make this test pass or fail on the runner's timezone,
    // and would make the credit mean different things to different readers.
    expect(lastUpdatedText('2026-08-24T09:14:32+02:00')).toBe('2026-08-24 07:14 UTC');
  });
});

describe('operatorsLabel', () => {
  it('counts what is behind the disclosure, and names it as terms', () => {
    // A disclosure that does not say how much is behind it is a mystery control, same reason
    // the "i" carries its count in its accessible name.
    expect(operatorsLabel(101)).toBe('101 operators and their terms');
    expect(operatorsLabel(1)).toBe('1 operator and its terms');
  });
});

function rowFor(entry: AttributionEntry): FakeElement {
  const root = markup();
  new AttributionPanel(asElement(root)).render([entry]);
  const row = root.all('li').at(0);
  if (row === undefined) {
    throw new Error('the panel rendered no row');
  }
  return row;
}

describe('a grouped credit carries what the licence asks for', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (tag: string): FakeElement => new FakeElement(tag),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the date on the row rather than behind the disclosure', () => {
    // The blocker. A date inside a closed `<details>` is not displayed, and Etalab asks for it
    // to be. So it is a direct child of the row, beside the licence.
    const row = rowFor(TRANSIT_GROUPED);
    const stamp = row.elements.find((child) => child.tag === 'time');

    expect(stamp?.textContent).toBe(' · information last updated 2026-08-24 09:14 UTC');
    expect(stamp?.attributes['datetime']).toBe('2026-08-24T09:14:32Z');
  });

  it('keeps the licence on the row, not only beside the names', () => {
    // ODbL governs 46 of these feeds and wants the licence alongside the owners. A grouped row
    // that listed operators without its licence would fail that, so the licence is a direct
    // child of the row and is visible whether the disclosure is open or closed.
    const row = rowFor(TRANSIT_GROUPED);
    const licence = row.elements.find((child) => child.className === 'attribution-licence');

    expect(licence?.textContent).toBe(' (Etalab 2.0)');
    expect(row.all('details').at(0)?.all('span')).toStrictEqual([]);
  });

  it('keeps the sentence as the row link, untouched', () => {
    // `text` is not compliant on its own, which `docs/status.md` records as unachievable for
    // Etalab, but it is still the thing a reader sees first and nothing reformats or truncates
    // it. The row is what discharges the licence; this is the part of the row a reader reads.
    const row = rowFor(TRANSIT_GROUPED);
    const link = row.elements.at(0);

    expect(link?.tag).toBe('a');
    expect(link?.textContent).toBe(TRANSIT_GROUPED.text);
    expect(link?.href).toBe(TRANSIT_GROUPED.url);
  });

  it('links every operator to its own terms rather than to the row', () => {
    // CC-BY governs 35 of these feeds and the licence link is not optional, so one row-level
    // link cannot stand for 35 different ones. `CreditedOperatorEntry.url` is the terms binding
    // that owner alone, which is what these hrefs have to be.
    const links = rowFor(TRANSIT_GROUPED).all('details').at(0)?.all('a') ?? [];

    expect(links.map((link) => link.textContent)).toStrictEqual([
      'Île-de-France Mobilités',
      'Tisséo',
      'TAM Montpellier',
    ]);
    expect(links.map((link) => link.href)).toStrictEqual(
      TRANSIT_GROUPED.operators.map((operator) => operator.url),
    );
    expect(links.every((link) => link.href !== TRANSIT_GROUPED.url)).toBe(true);
    expect(links.at(0)?.title).toBe('Terms for Île-de-France Mobilités');
  });

  it('separates the names with text so a hundred owners are not a hundred rows', () => {
    // The panel across the bottom of the globe was the original complaint, and every summary
    // on screen is floored at 44px. So the owners are an inline run: one element each, commas
    // as text between them, and one summary for the row however many there are.
    const names = rowFor(TRANSIT_GROUPED).all('details').at(0)?.all('div').at(0);

    expect(names?.rendered).toBe('Île-de-France Mobilités, Tisséo, TAM Montpellier');
    expect(names?.elements).toHaveLength(3);
  });

  it('costs one summary whether it stands for three owners or a hundred and one', () => {
    const many: AttributionEntry = {
      ...TRANSIT_GROUPED,
      operators: Array.from({ length: 101 }, (_, index) => ({
        name: `Authority ${String(index)}`,
        url: `https://example.invalid/terms/${String(index)}`,
      })),
    };

    expect(rowFor(many).all('summary')).toHaveLength(1);
    expect(rowFor(TRANSIT_GROUPED).all('summary')).toHaveLength(1);
  });
});

describe('a single-source credit is left exactly as it was', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (tag: string): FakeElement => new FakeElement(tag),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never groups a verbatim mandate, and never touches its sentence', () => {
    // The protection for King County Metro and the City of Hamilton. Their wording is theirs
    // and their rows are single-source, so nothing may reformat, truncate or group them: a link
    // carrying the sentence exactly, and its licence.
    const row = rowFor(VERBATIM);

    expect(row.elements.map((child) => child.tag)).toStrictEqual(['a', 'span']);
    expect(row.rendered).toBe(
      `${VERBATIM.text} (Permission of King County, verbatim notice required)`,
    );
  });

  it('still adds the date to a verbatim mandate, because that is not a change to its wording', () => {
    // Live, both mandate rows carry an `as_of`, since the vehicles behind them are as live as
    // any other. The sentence is what the provider fixed; a date beside it neither reformats
    // nor truncates it, and there is still no disclosure because the row stands for one owner.
    const row = rowFor({ ...VERBATIM, as_of: '2026-08-24T08:14:16Z' });

    expect(row.elements.map((child) => child.tag)).toStrictEqual(['a', 'span', 'time']);
    expect(row.rendered).toContain(VERBATIM.text);
    expect(row.all('details')).toStrictEqual([]);
  });

  it('renders no date when the row has none, and none when it is null', () => {
    expect(rowFor(FINTRAFFIC).all('time')).toStrictEqual([]);
    expect(rowFor({ ...FINTRAFFIC, as_of: null }).all('time')).toStrictEqual([]);
  });

  it('still credits the source if a backend serves no operators field at all', () => {
    // Defensive on purpose, and the asymmetry is the argument: this panel throwing takes every
    // credit off the globe rather than costing one row its owner list. Not a compliant state,
    // since a row rather than a field discharges these licences, but the better of two bad
    // outcomes: a stale backend during a rollout must not blank the credits.
    const stale = { ...FINTRAFFIC, operators: undefined } as unknown as AttributionEntry;
    const row = rowFor(stale);

    expect(row.elements.map((child) => child.tag)).toStrictEqual(['a', 'span']);
    expect(row.rendered).toContain(FINTRAFFIC.text);
  });
});
