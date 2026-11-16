import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOON_HORIZON_DEG,
  MOON_RADIUS,
  lunarStateAt,
  moonAltitude,
  moonDirection,
  moonHorizon,
  moonInShadow,
  sublunarPoint,
} from './lunar.js';
import { moonAlbedo, moonShade, paintMoon } from './skyPanel.js';
import { createEclipseElementsSource } from './source.js';

const catalog = await createEclipseElementsSource().getLunarCatalog();
const byId = (id) => catalog.find((eclipse) => eclipse.id === id);
const utc = (ms) => new Date(ms).toISOString().slice(11, 16);

test('the catalogue holds every lunar eclipse from 1583 to 3000, in time order', () => {
  assert.equal(catalog.length, 3440);
  assert.equal(catalog[0].id, '1583-01-08');
  assert.equal(catalog.at(-1).year, 3000);
  for (let index = 1; index < catalog.length; index += 1)
    assert.ok(catalog[index].startMs > catalog[index - 1].endMs);
  const kinds = Object.groupBy(catalog, ({ kind }) => kind);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(kinds).map(([kind, list]) => [kind, list.length]),
    ),
    { 'lunar-penumbral': 1254, 'lunar-partial': 1216, 'lunar-total': 970 },
  );
  assert.ok(catalog.every(({ body }) => body === 'lunar'));
});

test("the shadow radii and the Moon's speed worked out from the catalogue give back its phase durations", () => {
  for (const eclipse of catalog) {
    const minutes = (reach) =>
      ((2 * Math.sqrt(Math.max(0, reach * reach - eclipse.gamma ** 2))) /
        eclipse.speed) *
      60;
    if (eclipse.partialMinutes)
      assert.ok(
        Math.abs(
          minutes(eclipse.umbraRadius + MOON_RADIUS) - eclipse.partialMinutes,
        ) < 0.5,
        `${eclipse.id}: the umbral phase`,
      );
    if (eclipse.totalMinutes)
      assert.ok(
        Math.abs(
          minutes(eclipse.umbraRadius - MOON_RADIUS) - eclipse.totalMinutes,
        ) < 0.5,
        `${eclipse.id}: totality`,
      );
  }
});

test('the total lunar eclipse of 7 September 2025 runs through its phases at the published times', () => {
  const eclipse = byId('2025-09-07');
  assert.equal(eclipse.kind, 'lunar-total');
  // NASA: penumbral 15:28 to 20:55, partial 16:27 to 19:56, total 17:30 to
  // 18:52, greatest 18:11 UT.
  assert.equal(utc(eclipse.greatestMs), '18:11');
  assert.equal(utc(eclipse.contacts.penumbral[0]), '15:28');
  assert.equal(utc(eclipse.contacts.partial[0]), '16:27');
  assert.equal(utc(eclipse.contacts.total[0]), '17:30');
  assert.equal(utc(eclipse.contacts.total[1]), '18:52');
  const phase = (ms) => lunarStateAt(eclipse, ms).phase;
  assert.equal(phase(eclipse.startMs - 60_000), 'none');
  assert.equal(phase(eclipse.contacts.partial[0] - 60_000), 'penumbral');
  assert.equal(phase(eclipse.contacts.total[0] - 60_000), 'partial');
  assert.equal(phase(eclipse.greatestMs), 'total');
  assert.equal(phase(eclipse.contacts.total[1] + 60_000), 'partial');
  assert.equal(phase(eclipse.endMs + 60_000), 'none');
  // At greatest eclipse the Moon is at its nearest to the axis.
  assert.deepEqual(moonInShadow(eclipse, eclipse.greatestMs), {
    x: 0,
    y: eclipse.gamma,
  });
  assert.ok(
    Math.abs(
      lunarStateAt(eclipse, eclipse.greatestMs).umbral -
        eclipse.umbralMagnitude,
    ) < 1e-9,
  );
});

test('the Moon is up over India and down over Brazil; the place under it moves west', () => {
  const eclipse = byId('2025-09-07');
  const at = eclipse.greatestMs;
  assert.ok(moonAltitude(eclipse, at, 28.6, 77.2) > 40);
  assert.ok(moonAltitude(eclipse, at, -23.5, -46.6) < -20);
  assert.deepEqual(sublunarPoint(eclipse, at), { lat: -6, lon: 87 });
  const later = sublunarPoint(eclipse, at + 3_600_000);
  assert.ok(Math.abs(later.lon - (87 - 14.492)) < 1e-9);
  const [x, y, z] = moonDirection(eclipse, at);
  assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-12);
});

test("the horizon line rings the place under the Moon at a right angle's reach", () => {
  const eclipse = byId('2025-09-07');
  const line = moonHorizon(eclipse, eclipse.greatestMs, 72);
  assert.equal(line.length, 73);
  for (const { lat, lon } of line) {
    assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
    assert.ok(
      Math.abs(moonAltitude(eclipse, eclipse.greatestMs, lat, lon)) < 1e-6,
    );
  }
  assert.ok(MOON_HORIZON_DEG < 90);
});

test('painting the Moon draws its face with the shadow across it, and veils it when it is below the horizon', () => {
  const calls = [];
  const gradient = { addColorStop() {} };
  let put = null;
  const context = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === 'createLinearGradient' || name === 'createRadialGradient'
          ? () => gradient
          : name === 'getTransform'
            ? () => ({ a: 2 })
            : name === 'getImageData'
              ? (_x, _y, width, height) => ({
                  width,
                  data: new Uint8ClampedArray(width * height * 4),
                })
              : name === 'putImageData'
                ? (image, x, y) => {
                    put = { image, x, y };
                  }
                : (...args) => calls.push([name, ...args]),
      set: () => true,
    },
  );
  // The Moon half in the umbra: the shadow's axis is up and to the right.
  const view = { x: 1.6, y: -1.6, umbraRadius: 2.7, penumbraRadius: 4.7 };
  paintMoon(context, view);
  // Painted in the canvas's own pixels: twice the size on a dense screen.
  const { image } = put;
  assert.equal(image.width, 162);
  assert.deepEqual([put.x, put.y], [95, 95]);
  const pixel = (x, y) => {
    const column = Math.round(((x + 1) / 2) * image.width);
    const row = Math.round(((y + 1) / 2) * image.width);
    return [...image.data.slice((row * image.width + column) * 4).slice(0, 3)];
  };
  // Toward the shadow the Moon is dark and red; away from it, bright grey.
  const [red, green, blue] = pixel(0.5, -0.5);
  assert.ok(red < 90 && red > green * 2 && green > blue);
  const lit = pixel(-0.55, 0.6);
  assert.ok(lit[0] > 100 && lit[0] - lit[2] < 20);
  // Outside the disc nothing is painted over the sky.
  assert.deepEqual(pixel(-0.95, -0.95), [0, 0, 0]);
  const fills = calls.filter(([name]) => name === 'fillRect').length;
  calls.length = 0;
  paintMoon(context, { ...view, below: true });
  assert.equal(calls.filter(([name]) => name === 'fillRect').length, fills + 1);
});

test("the Moon's face has dark seas, bright highlands and Tycho; the shadow reddens it", () => {
  // Mare Imbrium is darker than the southern highlands; Tycho is brightest.
  assert.ok(moonAlbedo(-0.3, -0.45) < 0.6);
  assert.ok(moonAlbedo(0.2, 0.7) > 0.75);
  assert.ok(moonAlbedo(-0.12, 0.68) > moonAlbedo(0.2, 0.7));
  // Outside the penumbra the Moon is fully lit; the penumbra dims it evenly.
  assert.deepEqual(moonShade(5, 2.7, 4.7, 0), [1, 1, 1]);
  const [r, g, b] = moonShade(3.5, 2.7, 4.7, 0);
  assert.ok(r < 1 && r > 0.2 && r === g && g === b);
  // In the umbra only red light is left, more of it toward the edge, and
  // the eye sees it best with the whole Moon inside.
  const deep = moonShade(0.5, 2.7, 4.7, 1);
  assert.ok(deep[0] > deep[1] * 2 && deep[1] > deep[2]);
  assert.ok(moonShade(2, 2.7, 4.7, 1)[0] > deep[0]);
  assert.ok(deep[0] > moonShade(0.5, 2.7, 4.7, 0)[0] * 2);
});
