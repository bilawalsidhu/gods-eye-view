/**
 * Tests for the cloud layer, against a fake Cesium and a fake NASA.
 *
 * Three claims are what most of this file exists to prove, because all three are ways a
 * time-dimensioned imagery layer fails without erroring.
 *
 * A slot is never asserted without a tile behind it. GIBS answers 404 for a frame it has not
 * built yet and the newest frame is always one it has not built yet, so a layer that trusts
 * the clock draws nothing and says everything is fine. The probe walk is what stops that, and
 * both halves of it are asserted below: it takes the first slot that answers, and it gives up
 * rather than walking back for ever.
 *
 * A refresh that changes nothing changes nothing. `requestRenderMode` is on and imagery is
 * expensive, so a tick landing inside the same ten-minute slot must not swap three sheets and
 * wake the renderer.
 *
 * And the coverage hole is stated. GIBS carries no Meteosat, so this layer cannot show clouds
 * over Africa, and the rail has to say so rather than let an empty continent read as a bug.
 */

import { describe, expect, it, vi } from 'vitest';

import { CLOUD_CREDIT_TEXT } from '../../ui/attribution';
import {
  CLEAR_SKY_CEILING,
  CLOUD_FLOOR,
  CLOUD_GAP_NOTICE,
  CLOUD_LAYER,
  CLOUD_REASON_MAX,
  CLOUD_SATELLITES,
  CLOUD_SLOT_CANDIDATES,
  CloudLayer,
  cloudDefaultUrl,
  cloudGapInView,
  cloudImagery,
  cloudProbeUrl,
  cloudSlot,
  cloudSlots,
  cloudTileTemplate,
  cloudUnavailableReason,
  describeError,
  headTile,
  renderAsCloud,
  newestCloudSlot,
  slotFromHeader,
} from './clouds';
import type { CloudSatellite } from './clouds';

// Hoisted above every import above by Vitest, which is what makes the fake below the Cesium
// the layer under test receives. Faithful in the one place that matters: an `ImageryLayer`
// copies its options onto itself, so the blend settings can be read back off the sheet.
vi.mock('cesium', () => {
  class FakeCredit {
    readonly text: string;

    constructor(text: string) {
      this.text = text;
    }
  }
  class FakeRectangle {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;

    constructor(west: number, south: number, east: number, north: number) {
      this.west = west;
      this.south = south;
      this.east = east;
      this.north = north;
    }

    static fromDegrees(west: number, south: number, east: number, north: number): FakeRectangle {
      return new FakeRectangle(west, south, east, north);
    }
  }
  class FakeWebMercatorTilingScheme {
    readonly projection = 'web-mercator';
  }
  class FakeProvider {
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    // Present because the real provider has it and the layer patches it: a fake without it
    // would let a rename of Cesium's own method through unnoticed.
    requestImage(x: number, y: number, level: number): Promise<unknown> {
      return Promise.resolve({ width: 2, height: 1, tile: `${x}/${y}/${level}` });
    }
  }
  class FakeImageryLayer {
    readonly provider: FakeProvider;
    show = true;

    constructor(provider: FakeProvider, options: Record<string, unknown> = {}) {
      this.provider = provider;
      Object.assign(this, options);
    }
  }
  return {
    Color: { BLACK: 'black' },
    Credit: FakeCredit,
    ImageryLayer: FakeImageryLayer,
    Rectangle: FakeRectangle,
    WebMapTileServiceImageryProvider: FakeProvider,
    WebMercatorTilingScheme: FakeWebMercatorTilingScheme,
  };
});

interface Sheet {
  show: boolean;
  provider: { options: Record<string, unknown> };
}

/** An httpx-style failure: a real error whose message renders as nothing at all. */
class SilentTimeout extends Error {
  override name = 'TimeoutError';
}

/** One satellite by name, so no test depends on the order of a list it does not own. */
function named(name: string): CloudSatellite {
  const found = CLOUD_SATELLITES.find((satellite) => satellite.name === name);
  if (found === undefined) {
    throw new Error(`no satellite named ${name}`);
  }
  return found;
}

/**
 * Cesium's imagery collection, reduced to the two calls this layer makes, and a log.
 *
 * The log is the point: whether a refresh leaves a frame with no clouds on it comes down to
 * the order of an add and a remove, and only the sequence can show that.
 */
class FakeSheets {
  readonly log: string[] = [];
  readonly live: Sheet[] = [];

  add(layer: Sheet): void {
    this.log.push('add');
    this.live.push(layer);
  }

  remove(layer: Sheet, destroy?: boolean): boolean {
    this.log.push(destroy === true ? 'remove+destroy' : 'remove');
    const at = this.live.indexOf(layer);
    this.live.splice(at, 1);
    return at !== -1;
  }
}

function makeLayer(options: { probe?: (url: string) => Answer; now?: () => Date } = {}): {
  layer: InstanceType<typeof CloudLayer>;
  sheets: FakeSheets;
} {
  const sheets = new FakeSheets();
  const layer = new CloudLayer(
    sheets as unknown as ConstructorParameters<typeof CloudLayer>[0],
    options,
  );
  return { layer, sheets };
}

/**
 * A document whose canvas hands back two known pixels and records what was written to it.
 *
 * Enough to drive the tile repaint in a runner with no DOM: one warm-sea pixel and one dense
 * cloud pixel go in, and the alpha channel that comes back says whether the ramp ran.
 */
function stubCanvas(): { painted: Uint8ClampedArray | null } {
  const state: { painted: Uint8ClampedArray | null } = { painted: null };
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (): void => undefined,
        getImageData: () => ({
          data: new Uint8ClampedArray([104, 104, 104, 255, 220, 220, 220, 255]),
        }),
        putImageData: (image: { data: Uint8ClampedArray }): void => {
          state.painted = image.data;
        },
      }),
    }),
  });
  return state;
}

/** One pixel through the repaint, as `[red, green, blue, alpha]`. */
function repaint(red: number, green: number, blue: number): number[] {
  const pixels = new Uint8ClampedArray([red, green, blue, 255]);
  renderAsCloud(pixels);
  return [...pixels];
}

/** One pixel through the repaint, as an alpha from 0 to 255. */
function alphaOf(red: number, green: number, blue: number): number {
  return repaint(red, green, blue)[3] ?? -1;
}

/** Read one blend setting back off the first sheet the layer built. */
function setting(sheets: FakeSheets, key: string): unknown {
  return (sheets.live[0] as unknown as Record<string, unknown>)[key];
}

/** A camera looking at the middle of the covered Atlantic, so no gap notice. */
const ATLANTIC = { west: -40, south: 20, east: -20, north: 40 };
/** A camera over Egypt, which is in the hole GIBS leaves where Meteosat would be. */
const EGYPT = { west: 25, south: 22, east: 35, north: 32 };

const NOON = new Date('2026-08-23T12:00:00Z');
const LATER = new Date('2026-08-23T12:30:00Z');

/** What a probe hands back: whether the tile is there, and the frame GIBS named. */
type Answer = Promise<{ ok: boolean; slot: string | null }>;

/** GIBS answering every tile and naming no frame, which is the fallback path. */
const ALWAYS = (): Answer => Promise.resolve({ ok: true, slot: null });
const NEVER = (): Answer => Promise.resolve({ ok: false, slot: null });
/** GIBS naming the frame it served, which is the normal path and one request. */
const REPORTS =
  (slot: string) =>
  (url: string): Answer =>
    Promise.resolve({ ok: true, slot: url.includes('/default/default/') ? slot : null });

describe('cloudSlot', () => {
  it('floors to the ten-minute frame GIBS actually publishes', () => {
    expect(cloudSlot(new Date('2026-08-23T09:27:43.512Z'))).toBe('2026-08-23T09:20:00Z');
    expect(cloudSlot(new Date('2026-08-23T09:30:00Z'))).toBe('2026-08-23T09:30:00Z');
  });

  it('ends in Z rather than an offset, which a time dimension is not', () => {
    // The offset form is what silently breaks CelesTrak's OMM reader elsewhere in this
    // project. Here it would be a path segment GIBS never published, so a 404 per tile.
    const slot = cloudSlot(NOON);
    expect(slot).toBe('2026-08-23T12:00:00Z');
    expect(slot).not.toContain('+00:00');
    expect(slot).not.toContain('.000');
  });
});

describe('cloudSlots', () => {
  it('starts behind the clock, because the newest frame is not built yet', () => {
    // Measured on 2026-08-23: the two newest slots answered 404 on every attempt, and the
    // newest with bytes behind it was between 26 and 36 minutes old.
    expect(cloudSlots(NOON)[0]).toBe('2026-08-23T11:40:00Z');
  });

  it('walks back in ten-minute steps and stops', () => {
    const slots = cloudSlots(NOON);
    expect(slots).toHaveLength(CLOUD_SLOT_CANDIDATES);
    expect(slots.at(-1)).toBe('2026-08-23T10:30:00Z');
    // Newest first, because the first one that answers is the one we want and every step
    // back is ten minutes of staleness bought to get a picture at all.
    expect(slots).toStrictEqual(slots.toSorted((a, b) => b.localeCompare(a)));
  });
});

describe('cloudProbeUrl', () => {
  it('asks for the one tile that holds the whole world', () => {
    expect(cloudProbeUrl(named('GOES-West'), '2026-08-23T09:20:00Z')).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-West_ABI_Band13_Clean_Infrared' +
        '/default/2026-08-23T09:20:00Z/GoogleMapsCompatible_Level6/0/0/0.png',
    );
  });
});

describe('cloudTileTemplate', () => {
  it('leaves Cesium its own placeholders and interpolates none of them', () => {
    const template = cloudTileTemplate(named('GOES-East'));
    expect(template).toContain('{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png');
    expect(template).toContain('GOES-East_ABI_Band13_Clean_Infrared');
    expect(template).not.toContain('${');
    expect(template).not.toContain('undefined');
  });
});

describe('CLOUD_SATELLITES', () => {
  it('cuts the slices at the midpoints, so no tile has two satellites answering for it', () => {
    const ordered = CLOUD_SATELLITES.toSorted((a, b) => a.west - b.west);
    expect(
      ordered.map((satellite) => `${satellite.name} ${satellite.west} to ${satellite.east}`),
    ).toStrictEqual(['GOES-West -180 to -106', 'GOES-East -106 to 0', 'Himawari 60 to 180']);
    // Derived rather than eyeballed: an overlap would hand Cesium two sheets of the same sky
    // and let the smeared limb of one cover the nadir of the other.
    const overlapping = ordered.filter(
      (satellite, index) => (ordered[index + 1]?.west ?? 180) < satellite.east,
    );
    expect(overlapping).toStrictEqual([]);
  });

  it('reaches London, which sits on the very edge of the GOES-East disk', () => {
    // Verified against real tiles on 2026-08-23: a tile over London carried imagery and one
    // over Cairo came back fully transparent. The camera opens on London, so a layer that
    // stopped short of it would look broken on the first frame.
    const covering = CLOUD_SATELLITES.filter(
      (satellite) => satellite.west <= -0.12 && satellite.east >= -0.12,
    );
    expect(covering.map((satellite) => satellite.name)).toStrictEqual(['GOES-East']);
  });
});

describe('cloudGapInView', () => {
  it('says nothing about a view the satellites cover', () => {
    expect(cloudGapInView(ATLANTIC)).toBe(false);
    expect(cloudGapInView({ west: 100, south: -10, east: 140, north: 10 })).toBe(false);
  });

  it('reports the hole GIBS leaves where Meteosat would be', () => {
    expect(cloudGapInView(EGYPT)).toBe(true);
    // The eastern edge of GOES-East is the meridian, so Berlin is in the hole and London is
    // not. Six degrees of smeared limb was traded for a console with nothing in it.
    expect(cloudGapInView({ west: 12, south: 51, east: 15, north: 54 })).toBe(true);
    expect(cloudGapInView({ west: -1, south: 51, east: -0.1, north: 52 })).toBe(false);
  });

  it('honours a view that crosses the antimeridian rather than answering about its mirror', () => {
    // West greater than east is Cesium's wrapped rectangle. The Pacific does not touch the
    // gap; a view running from Beijing round to Cairo does.
    expect(cloudGapInView({ west: 170, south: -10, east: -170, north: 10 })).toBe(false);
    expect(cloudGapInView({ west: 116, south: 0, east: 31, north: 40 })).toBe(true);
  });
});

describe('slotFromHeader', () => {
  it('takes a frame GIBS named and refuses anything else', () => {
    // This value goes straight back out as a path segment in every tile URL, so it is checked
    // rather than trusted. A response header is upstream input like any other.
    expect(slotFromHeader('2026-08-23T10:00:00Z')).toBe('2026-08-23T10:00:00Z');
    expect(slotFromHeader(null)).toBeNull();
    expect(slotFromHeader('2026-08-23T10:00:00+00:00')).toBeNull();
    expect(slotFromHeader('../../../etc/passwd')).toBeNull();
  });
});

describe('newestCloudSlot', () => {
  it('takes the frame GIBS names, in one request, with nothing guessed', async () => {
    const asked: string[] = [];
    const probe = (url: string): Answer => {
      asked.push(url);
      return REPORTS('2026-08-23T09:30:00Z')(url);
    };

    expect(await newestCloudSlot(named('Himawari'), NOON, probe)).toBe('2026-08-23T09:30:00Z');
    // One request, not the four the walk would take to reach a frame that old, three of them
    // 404s and so three console errors in a browser.
    expect(asked).toStrictEqual([cloudDefaultUrl(named('Himawari'))]);
  });

  it('walks the slots when the answer names no frame', async () => {
    const asked: string[] = [];
    const probe = (url: string): Answer => {
      asked.push(url);
      return Promise.resolve({ ok: asked.length === 3, slot: null });
    };

    expect(await newestCloudSlot(named('GOES-West'), NOON, probe)).toBe('2026-08-23T11:30:00Z');
    // The `default` request and then two slots. Not all nine: the rest would be wasted
    // requests against a provider whose cadence discipline is a rule here.
    expect(asked).toHaveLength(3);
  });

  it('gives up rather than walking back into last week', async () => {
    const asked: string[] = [];
    const probe = (url: string): Answer => {
      asked.push(url);
      return Promise.resolve({ ok: false, slot: null });
    };

    expect(await newestCloudSlot(named('GOES-West'), NOON, probe)).toBeNull();
    expect(asked).toHaveLength(CLOUD_SLOT_CANDIDATES + 1);
  });
});

describe('headTile', () => {
  it('reads the status and the frame rather than downloading the tile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'layer-time-actual': '2026-08-23T10:00:00Z' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await headTile('https://example.test/tile.png')).toStrictEqual({
      ok: true,
      slot: '2026-08-23T10:00:00Z',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/tile.png', { method: 'HEAD' });

    vi.unstubAllGlobals();
  });

  it('treats a 404 as a frame that is not there rather than as an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }));

    expect(await headTile('https://example.test/tile.png')).toStrictEqual({
      ok: false,
      slot: null,
    });

    vi.unstubAllGlobals();
  });
});

describe('describeError', () => {
  it('names the type when the message is empty, so a broken layer says something', () => {
    // The frontend twin of the httpx problem in AGENTS.md: several failures stringify to
    // nothing at all, and a reason that renders as an empty string is a layer saying nothing.
    expect(describeError(new SilentTimeout())).toBe('TimeoutError');
    expect(describeError(new Error('Failed to fetch'))).toBe('Failed to fetch');
    expect(describeError('blocked')).toBe('blocked');
    expect(describeError(undefined)).toBe('unknown error');
  });
});

describe('cloudUnavailableReason', () => {
  it('says the layer found nothing rather than leaving the row blank', () => {
    expect(cloudUnavailableReason(null)).toBe(
      'NASA GIBS published no cloud imagery in the last 90 minutes',
    );
  });

  it('never exceeds the cap the rail can render', () => {
    const reason = cloudUnavailableReason('x'.repeat(400));
    expect(reason.length).toBeLessThanOrEqual(CLOUD_REASON_MAX);
    expect(reason.endsWith('…')).toBe(true);
    expect(cloudUnavailableReason(null).length).toBeLessThanOrEqual(CLOUD_REASON_MAX);
  });
});

describe('renderAsCloud', () => {
  it('drops a warm surface entirely, which is most of the globe', () => {
    // Measured peaks: tropical Atlantic 96 to 111, Amazon 48 to 95, Sahara by day 96 to 127.
    // Six of nine sampled climates peak below the ceiling, so this is the common case and it
    // is the one that decides whether the basemap reads as a map.
    expect(alphaOf(104, 104, 104)).toBe(0);
    expect(alphaOf(75, 75, 75)).toBe(0);
    expect(alphaOf(CLEAR_SKY_CEILING, CLEAR_SKY_CEILING, CLEAR_SKY_CEILING)).toBe(0);
  });

  it('drops the off-disk corners, which is why no colour key is needed', () => {
    // A tile straddling a disk's limb carries the space beyond it as opaque (0, 0, 0). That
    // is grey with a brightness of zero, so it falls out with the sky and the old
    // `colorToAlpha` on black has nothing left to do.
    expect(alphaOf(0, 0, 0)).toBe(0);
  });

  it("paints cloud white rather than passing NASA's colours through", () => {
    // Two people read the untouched ramp as a broken render rather than as weather, over one
    // half of the Earth with a hard edge down the middle. The audience for this globe does not
    // read infrared, so the layer draws cloud as cloud and lets the alpha carry the density.
    expect(repaint(200, 200, 200)).toStrictEqual([255, 255, 255, 255]);
    expect(repaint(150, 150, 150).slice(0, 3)).toStrictEqual([255, 255, 255]);
  });

  it('sends a colourised cold top to the top of the white ramp rather than dropping it', () => {
    // The most meteorologically real thing in the picture. (0, 67, 90) is a cold top whose
    // brightest channel is 90, well under the ceiling, so keyed on brightness alone it would
    // vanish and punch a hole through the middle of every storm. It ends up solid white,
    // which is the densest, tallest cloud this palette can say.
    expect(repaint(0, 67, 90)).toStrictEqual([255, 255, 255, 255]);
    expect(repaint(51, 255, 0)).toStrictEqual([255, 255, 255, 255]);
    expect(repaint(0, 81, 149)).toStrictEqual([255, 255, 255, 255]);
  });

  it('leaves no chroma anywhere, so nothing can read as false colour', () => {
    // The property the whole change exists to establish. Every visible pixel is grey-free
    // white; a single surviving coloured pixel would be a patch of rainbow on the globe.
    const samples: [number, number, number][] = [
      [200, 200, 200],
      [150, 150, 150],
      [0, 67, 90],
      [51, 255, 0],
      [255, 128, 0],
      [0, 0, 255],
    ];
    for (const [red, green, blue] of samples) {
      const [outRed, outGreen, outBlue] = repaint(red, green, blue);
      expect(outRed).toBe(outGreen);
      expect(outGreen).toBe(outBlue);
    }
  });

  it('paints dense cloud in full', () => {
    expect(alphaOf(220, 220, 220)).toBe(255);
    expect(alphaOf(CLOUD_FLOOR, CLOUD_FLOOR, CLOUD_FLOOR)).toBe(255);
  });

  it('ramps between the two rather than drawing a contour', () => {
    const middle = alphaOf(152, 152, 152);
    expect(middle).toBeGreaterThan(100);
    expect(middle).toBeLessThan(160);
    // Monotone, so thicker cloud is never fainter than thinner cloud.
    const steps = [130, 140, 150, 160, 170].map((grey) => alphaOf(grey, grey, grey));
    expect(steps).toStrictEqual(steps.toSorted((a, b) => a - b));
  });

  it('keeps a colourised cold top even though it is darker than clear sky', () => {
    // The measurement the whole thing hangs on. NASA colourises the cold end of this ramp, so
    // the tallest storms arrive cyan and green, and (0, 67, 90) is a cold top whose brightest
    // channel is 90, well under the ceiling. Keyed on brightness alone the ramp would punch a
    // hole through the middle of every deep convective cluster.
    expect(alphaOf(0, 67, 90)).toBe(255);
    expect(alphaOf(51, 255, 0)).toBe(255);
    expect(alphaOf(0, 81, 149)).toBe(255);
  });

  it('paints a cold surface as cloud, which is the honest limit of one infrared channel', () => {
    // Asserted so it is a known behaviour rather than a surprise. Band 13 reports temperature,
    // and Southern Ocean sea ice measured 160 to 175 with nothing at all below 144: colder
    // than a good deal of real cloud, because it genuinely is. No threshold can fix that, so
    // the ice caps paint, high in the ramp rather than at full strength.
    expect(alphaOf(170, 170, 170)).toBeGreaterThan(200);
    expect(alphaOf(175, 175, 175)).toBeGreaterThan(240);
  });

  it('walks a whole tile rather than the first pixel of it', () => {
    const pixels = new Uint8ClampedArray([104, 104, 104, 255, 220, 220, 220, 255, 0, 0, 0, 255]);
    renderAsCloud(pixels);
    expect([pixels[3], pixels[7], pixels[11]]).toStrictEqual([0, 255, 0]);
  });
});

describe('cloudImagery', () => {
  it('carries the layer, the matrix set, the slot and the credit GIBS asks for', () => {
    const satellite = named('GOES-East');
    const provider = cloudImagery(
      satellite,
      '2026-08-23T09:20:00Z',
    ) as unknown as Sheet['provider'];
    const options = provider.options;

    expect(options['layer']).toBe('GOES-East_ABI_Band13_Clean_Infrared');
    expect(options['format']).toBe('image/png');
    expect(options['tileMatrixSetID']).toBe('GoogleMapsCompatible_Level6');
    // Level 6 is the deepest this matrix set publishes and the indices are zero-based, so 7
    // would be a 404 for every tile a user zoomed into.
    expect(options['maximumLevel']).toBe(6);
    expect(options['dimensions']).toStrictEqual({ Time: '2026-08-23T09:20:00Z' });
    expect(options['credit']).toMatchObject({ text: CLOUD_CREDIT_TEXT });
    // On the provider rather than on the layer, because this is what stops the request being
    // made. On the layer it would only stop the tile being drawn, so the 404 would still land.
    expect(options['rectangle']).toMatchObject({
      west: satellite.west,
      south: -81,
      east: satellite.east,
      north: 81,
    });
  });
});

describe('cloudImagery tile repaint', () => {
  it('sends every tile through the ramp on its way to Cesium', async () => {
    // The wiring, not the ramp: `renderAsCloud` is tested directly above, and this asserts that
    // a tile really passes through it before Cesium sees it. Without this, Cesium renaming
    // `requestImage` would leave the sheets opaque and nothing here would notice.
    const state = stubCanvas();
    const provider = cloudImagery(named('GOES-East'), '2026-08-23T09:20:00Z');

    await provider.requestImage(0, 0, 0);

    expect(state.painted).not.toBeNull();
    // Warm sea out, dense cloud in.
    expect([state.painted?.[3], state.painted?.[7]]).toStrictEqual([0, 255]);
    vi.unstubAllGlobals();
  });
});

describe('CloudLayer', () => {
  it('puts one sheet on the globe per satellite that answered', async () => {
    const { layer, sheets } = makeLayer({ probe: ALWAYS, now: () => NOON });

    expect(await layer.refresh()).toBe(true);
    expect(sheets.live).toHaveLength(CLOUD_SATELLITES.length);
    expect(sheets.log).toStrictEqual(['add', 'add', 'add']);
    expect(layer.capability).toStrictEqual({ layer: CLOUD_LAYER, available: true, reason: null });
    expect(layer.showing.get('GOES-East')).toBe('2026-08-23T11:40:00Z');
  });

  it('draws the frame GIBS named rather than the one the clock suggested', async () => {
    const { layer } = makeLayer({ probe: REPORTS('2026-08-23T09:30:00Z'), now: () => NOON });

    expect(await layer.refresh()).toBe(true);
    // 150 minutes old, which is well outside the fallback walk. Himawari really was that far
    // behind when this was measured, and a layer that refused it would have drawn nothing.
    expect(layer.showing.get('Himawari')).toBe('2026-08-23T09:30:00Z');
  });

  it('leaves the blend to the pixels rather than veiling the globe with a constant', async () => {
    const { layer, sheets } = makeLayer({ probe: ALWAYS, now: () => NOON });
    await layer.refresh();

    // The bug this replaced: a fixed alpha over a field that is opaque everywhere is a veil
    // everywhere, and clear sky on this product is mid grey rather than black, so 0.62 of it
    // went down over the whole disk and the background became the loudest thing on screen.
    // `renderAsCloud` decides transparency per pixel now, so neither of these may come back.
    expect(setting(sheets, 'colorToAlpha')).toBeUndefined();
    expect(setting(sheets, 'contrast')).toBeUndefined();
    // Nor saturation. Every visible pixel is written to white, so it has no chroma to act on
    // and could not change one of them: a setting that cannot affect anything is a lie.
    expect(setting(sheets, 'saturation')).toBeUndefined();
    // Just under 1, so dense cloud is nearly solid and a coastline under it stays findable.
    expect(setting(sheets, 'alpha')).toBeGreaterThan(0.8);
    expect(setting(sheets, 'alpha')).toBeLessThan(1);
  });

  it('changes nothing when the tick lands inside the same slot', async () => {
    const { layer, sheets } = makeLayer({ probe: ALWAYS, now: () => NOON });
    await layer.refresh();
    sheets.log.length = 0;

    expect(await layer.refresh()).toBe(false);
    expect(sheets.log).toStrictEqual([]);
    expect(sheets.live).toHaveLength(CLOUD_SATELLITES.length);
  });

  it('adds the newer sheet before dropping the older one, so no frame is empty', async () => {
    const clock = { at: NOON };
    const { layer, sheets } = makeLayer({ probe: ALWAYS, now: () => clock.at });
    await layer.refresh();
    sheets.log.length = 0;
    clock.at = LATER;

    expect(await layer.refresh()).toBe(true);
    expect(sheets.log).toStrictEqual([
      'add',
      'remove+destroy',
      'add',
      'remove+destroy',
      'add',
      'remove+destroy',
    ]);
    expect(sheets.live).toHaveLength(CLOUD_SATELLITES.length);
    expect(layer.showing.get('Himawari')).toBe('2026-08-23T12:10:00Z');
  });

  it('keeps a sheet built and stops drawing it when the switch moves', async () => {
    const clock = { at: NOON };
    const { layer, sheets } = makeLayer({ probe: ALWAYS, now: () => clock.at });
    await layer.refresh();

    layer.setVisible(false);
    expect(sheets.live.map((sheet) => sheet.show)).toStrictEqual([false, false, false]);

    // A sheet built while the switch is off has to arrive off, or the next refresh turns the
    // layer back on behind the user.
    clock.at = LATER;
    await layer.refresh();
    expect(sheets.live.map((sheet) => sheet.show)).toStrictEqual([false, false, false]);

    layer.setVisible(true);
    expect(sheets.live.map((sheet) => sheet.show)).toStrictEqual([true, true, true]);
  });

  it('reports itself unavailable with a short reason when GIBS has nothing', async () => {
    const { layer, sheets } = makeLayer({ probe: NEVER, now: () => NOON });

    expect(await layer.refresh()).toBe(false);
    expect(sheets.live).toHaveLength(0);
    const capability = layer.capability;
    expect(capability.available).toBe(false);
    expect(capability.reason).toBe('NASA GIBS published no cloud imagery in the last 90 minutes');
    expect(capability.reason?.length).toBeLessThanOrEqual(CLOUD_REASON_MAX);
  });

  it('says what went wrong when the request itself failed', async () => {
    const { layer } = makeLayer({
      probe: (): Answer => Promise.reject(new Error('Failed to fetch')),
      now: () => NOON,
    });

    await layer.refresh();
    expect(layer.capability.reason).toBe('NASA GIBS unreachable: Failed to fetch');
  });

  it('stays up on the satellites that answered and names the one that did not', async () => {
    const { layer } = makeLayer({
      probe: (url) => Promise.resolve({ ok: !url.includes('Himawari'), slot: null }),
      now: () => NOON,
    });

    await layer.refresh();
    expect(layer.capability.available).toBe(true);
    expect(layer.notice(ATLANTIC)).toBe('Himawari cloud imagery missing from NASA GIBS');
  });

  it('warns about the coverage hole only while the camera is looking at it', async () => {
    const { layer } = makeLayer({ probe: ALWAYS, now: () => NOON });
    await layer.refresh();

    expect(layer.notice(ATLANTIC)).toBeNull();
    expect(layer.notice(EGYPT)).toBe(CLOUD_GAP_NOTICE);
    // Short enough to be shown outright rather than shortened behind a click, which is what
    // NOTICE_SUMMARY_MAX in the rail decides.
    expect(CLOUD_GAP_NOTICE.length).toBeLessThanOrEqual(72);
  });
});
