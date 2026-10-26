// The HUD's LAT/LON readout in degrees-minutes-seconds. Seconds are printed to
// two decimals, so a value within 0.005" of the next whole minute rounds up.
// That carry must reach the minutes (and degrees): `122°20'60.00"W` is not a
// coordinate. Ordinary decimal inputs land there through binary floating
// point: 122.35 - 122 is 0.34999999999999432, so -122.35 read 20'60.00".
//
// hud.js imports `mgrs`, a CommonJS package whose named exports Node's ESM
// loader cannot see, so this installs the same one-specifier stub as
// hudAltitudeDatum.test.mjs before importing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');

const toDMS = (decimal, type) => IntelHUD.prototype._toDMS(decimal, type);

test('a rounded-up second carries into the minutes', () => {
  assert.equal(toDMS(-122.35, 'lon'), `122°21'00.00"W`);
  assert.equal(toDMS(139.7, 'lon'), `139°42'00.00"E`);
  assert.equal(toDMS(37.0166666, 'lat'), `37°01'00.00"N`);
});

test('a carry through 59 minutes reaches the degrees', () => {
  assert.equal(toDMS(38.999999, 'lat'), `39°00'00.00"N`);
  assert.equal(toDMS(-0.999999, 'lat'), `01°00'00.00"S`);
  assert.equal(toDMS(179.999999, 'lon'), `180°00'00.00"E`);
});

test('ordinary values keep their existing format', () => {
  assert.equal(toDMS(38.889722, 'lat'), `38°53'23.00"N`);
  assert.equal(toDMS(-77.035278, 'lon'), `077°02'07.00"W`);
  assert.equal(toDMS(51.5, 'lat'), `51°30'00.00"N`);
  assert.equal(toDMS(-33.8568, 'lat'), `33°51'24.48"S`);
  assert.equal(toDMS(0, 'lon'), `000°00'00.00"E`);
  assert.equal(toDMS(90, 'lat'), `90°00'00.00"N`);
});

test('the telemetry tick paints the carried value into both readouts', () => {
  const elements = new Map(
    [
      'hud-alt',
      'hud-summary',
      'hud-mgrs',
      'hud-latlon',
      'hud-bottom-line',
      'hud-gsd',
      'hud-coll',
      'hud-ona',
      'hud-mode',
    ].map((id) => [id, { textContent: '' }]),
  );
  const previousDocument = globalThis.document;
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const viewer = {
    camera: {
      pitch: -Math.PI / 2,
      positionCartographic: {
        latitude: (37.75 * Math.PI) / 180,
        longitude: (-122.35 * Math.PI) / 180,
        height: 1500,
      },
      computeViewRectangle: () => undefined,
      moveStart: { addEventListener() {}, removeEventListener() {} },
      moveEnd: { addEventListener() {}, removeEventListener() {} },
    },
  };
  let hud;
  try {
    hud = new IntelHUD(viewer);
    hud._updateCameraData();
    const latlon = elements.get('hud-latlon').textContent;
    const bottom = elements.get('hud-bottom-line').textContent;
    assert.equal(latlon, `37°45'00.00"N 122°21'00.00"W`);
    assert.match(bottom, /LON: 122°21'00\.00"W/);
    assert.doesNotMatch(`${latlon} ${bottom}`, /60\.00"/);
  } finally {
    hud?.destroy();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
