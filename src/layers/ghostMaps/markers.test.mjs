import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GHOST_MARKER_DEFAULT_KIND,
  GHOST_MARKER_FRAME_COLOR,
  GHOST_MARKER_KINDS,
  GHOST_MARKER_SIZE,
  GHOST_MARKER_TINT_FLOOR,
  clearGhostMarkerCache,
  descriptionTypeText,
  drawGhostMarker,
  ghostEventKind,
  ghostFallbackImage,
  ghostMarkerImage,
  ghostMarkerTint,
  isNeutralTint,
} from './markers.js';

/** A recording 2D context: what was traced, filled and stroked. */
function recorder() {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args) =>
          calls.push([String(name), ...args]),
      set: (_t, name, value) => {
        calls.push(['set', String(name), value]);
        return true;
      },
    },
  );
  return { ctx, calls };
}

const table = (label, value) =>
  `<table><tr><td>${label}</td><td>${value}</td></tr></table>`;

test('the kind comes from what the placemark says about itself', () => {
  const cases = [
    [{ name: 'Ballistic missile launch' }, 'missile'],
    [{ name: 'Shahed-136 intercepted' }, 'drone'],
    [{ name: 'Airstrike on depot' }, 'air'],
    [{ folder: 'Naval incidents', name: 'Tanker attacked' }, 'naval'],
    [{ name: 'Explosion reported' }, 'strike'],
    [{ name: 'Artillery shelling' }, 'strike'],
    [{ name: 'Ambush on convoy' }, 'clash'],
    [{ name: 'Warehouse fire' }, 'fire'],
    [{ name: '12 killed in market' }, 'casualty'],
    [{ name: 'Protest in the square' }, 'unrest'],
    [{ name: 'Border crossing closed' }, 'checkpoint'],
    [{ name: 'Refugee camp expanded' }, 'displacement'],
    [{ name: 'Air base' }, 'facility'],
    [{ name: 'Something happened' }, 'report'],
    [{}, 'report'],
  ];
  for (const [placemark, kind] of cases)
    assert.equal(ghostEventKind(placemark), kind, JSON.stringify(placemark));
});

test('the more specific kind wins over the general one', () => {
  // A drone strike is a drone; a missile strike is a missile; an airstrike is air.
  assert.equal(ghostEventKind({ name: 'Drone strike on base' }), 'drone');
  assert.equal(ghostEventKind({ name: 'Missile strike' }), 'missile');
  assert.equal(ghostEventKind({ name: 'Air strike on port' }), 'air');
});

test('the Type row of the popup table leads, the long description is not scanned', () => {
  const html =
    table('Event Type', 'Drone') + table('Notes', 'Fire and explosions nearby');
  assert.equal(descriptionTypeText(html), 'Drone');
  assert.equal(
    ghostEventKind({ name: 'Report 4411', description: html }),
    'drone',
  );
  // Words only in the notes do not classify the placemark.
  assert.equal(
    ghostEventKind({
      name: 'Report 4412',
      description: table('Notes', 'a fire and a missile'),
    }),
    'report',
  );
  assert.equal(descriptionTypeText('<p>no table</p>'), '');
  assert.equal(descriptionTypeText(null), '');
});

test('the icon file name and the folder are read, the path and extension are not', () => {
  assert.equal(
    ghostEventKind({ name: 'x', iconHref: 'files/drone_red.png' }),
    'drone',
  );
  assert.equal(
    ghostEventKind({ name: 'x', folder: 'Checkpoints' }),
    'checkpoint',
  );
  assert.equal(
    ghostEventKind({ name: 'x', iconHref: 'fire/icon.png' }),
    'report',
  );
  assert.equal(
    ghostEventKind({ name: 'x', iconHref: 'https://x/y.png?drone' }),
    'report',
  );
});

test('every kind is drawn as a cyan plate with a glyph, and the glyphs differ', () => {
  const traces = new Map();
  for (const kind of GHOST_MARKER_KINDS) {
    const { ctx, calls } = recorder();
    drawGhostMarker(ctx, kind, GHOST_MARKER_SIZE);
    assert.ok(
      calls.some(
        (c) =>
          c[0] === 'set' &&
          c[1] === 'strokeStyle' &&
          c[2] === GHOST_MARKER_FRAME_COLOR,
      ),
      `${kind} has the cyan frame`,
    );
    assert.ok(
      calls.filter((c) => c[0] === 'stroke').length >= 2,
      `${kind} draws a glyph`,
    );
    traces.set(kind, JSON.stringify(calls));
  }
  assert.equal(new Set(traces.values()).size, GHOST_MARKER_KINDS.length);
  assert.equal(GHOST_MARKER_KINDS.at(-1), GHOST_MARKER_DEFAULT_KIND);
});

test('a sprite is drawn once per kind and shared, and an unknown kind is the report symbol', () => {
  clearGhostMarkerCache();
  let canvases = 0;
  const documentRef = {
    createElement() {
      canvases += 1;
      return {
        getContext: () => recorder().ctx,
        toDataURL: () => `data:image/png;base64,sprite-${canvases}`,
      };
    },
  };
  const a = ghostMarkerImage('drone', null, documentRef);
  assert.equal(ghostMarkerImage('drone', null, documentRef), a);
  assert.equal(canvases, 1);
  assert.equal(
    ghostMarkerImage('nonsense', null, documentRef),
    ghostMarkerImage('report', null, documentRef),
  );
  assert.equal(canvases, 2);
  clearGhostMarkerCache();
  // Even without a canvas there is an image: a marker is never nothing.
  assert.match(ghostMarkerImage('report'), /^data:image\/svg\+xml/);
  clearGhostMarkerCache();
});

test('the ArcGIS black placeholder is a neutral colour, not a colour to draw', () => {
  // `ff000000` is the black an ArcGIS export writes into its styles. It is a
  // placeholder that says "use the product colour", not a request for a black
  // marker: a black marker on a dark globe cannot be seen.
  const black = [0, 0, 0, 1];
  assert.equal(isNeutralTint(black), true);
  assert.equal(isNeutralTint([0.01, 0.01, 0.01, 1]), true);
  // The old plain-white sprite is the other placeholder.
  assert.equal(isNeutralTint([1, 1, 1, 1]), true);
  assert.equal(isNeutralTint([0.96, 0.96, 0.96, 1]), true);
  // A colour that says something is not neutral.
  assert.equal(isNeutralTint([1, 0, 0, 1]), false);
  assert.equal(isNeutralTint([0, 0.5, 1, 0.5]), false);
  // No colour at all is neutral.
  assert.equal(isNeutralTint(null), true);
  assert.equal(isNeutralTint(undefined), true);
});

test('the ArcGIS placeholder yields the product colour, never a black marker', () => {
  const product = { r: 200 / 255, g: 1, b: 0 };
  const tint = ghostMarkerTint([0, 0, 0, 1], product);
  assert.deepEqual(tint, { r: product.r, g: product.g, b: product.b, a: 1 });
  // The marker must not be black: a black marker cannot be seen.
  assert.ok(tint.r + tint.g + tint.b > 0, 'the tint carries colour');
});

test('a KML colour that says something is used, and its alpha never falls below the floor', () => {
  const product = { r: 0, g: 0, b: 1 };
  // A quarter-opaque colour would fade the marker away.
  const faded = ghostMarkerTint([0, 0, 1, 0.25], product);
  assert.equal(faded.a, GHOST_MARKER_TINT_FLOOR);
  assert.ok(faded.a >= 0.35);
  // A fully transparent colour would erase it.
  const erased = ghostMarkerTint([0, 0, 1, 0], product);
  assert.equal(erased.a, GHOST_MARKER_TINT_FLOOR);
  // A colour that says something keeps its own hue.
  const red = ghostMarkerTint([1, 0, 0, 1], product);
  assert.deepEqual(red, { r: 1, g: 0, b: 0, a: 1 });
  // An opaque colour keeps its alpha.
  assert.equal(ghostMarkerTint([1, 0, 0, 1], product).a, 1);
});

test('a sprite is never null, and a broken canvas is reported once and cached', (t) => {
  clearGhostMarkerCache();
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  let attempts = 0;
  const brokenDocument = {
    createElement() {
      attempts += 1;
      throw new Error('no canvas here');
    },
  };
  const first = ghostMarkerImage('drone', null, brokenDocument);
  assert.ok(first, 'a marker image is still produced');
  assert.match(first, /^data:image\/(png|svg\+xml)/);
  // The failure is reported ONCE for the kind, not once per placemark.
  assert.equal(warnings.length, 1);
  const second = ghostMarkerImage('drone', null, brokenDocument);
  assert.equal(second, first, 'the failure is cached');
  assert.equal(warnings.length, 1, 'the failure is not reported again');
  // The canvas is tried once for the symbol and once for the disc that
  // stands in for it; the second placemark tries nothing at all.
  assert.equal(attempts, 2, 'the canvas is not retried for every placemark');
  clearGhostMarkerCache();
});

test('the plain disc that stands in for a symbol is coloured and never black', () => {
  clearGhostMarkerCache();
  // The recorder's proxy records the fill style, so the colour is checked.
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, name) => (...args) => calls.push([String(name), ...args]),
      set: (_t, name, value) => {
        calls.push(['set', String(name), value]);
        return true;
      },
    },
  );
  const documentRef = {
    createElement() {
      return {
        getContext: () => ctx,
        toDataURL: () => 'data:image/png;base64,disc',
      };
    },
  };
  const url = ghostFallbackImage(
    ghostMarkerTint([0, 0, 0, 1], { r: 200 / 255, g: 1, b: 0 }),
    documentRef,
  );
  assert.equal(url, 'data:image/png;base64,disc');
  const fill = calls.find((c) => c[0] === 'set' && c[1] === 'fillStyle');
  assert.ok(fill, 'the disc is filled');
  assert.ok(!/rgba\(0, 0, 0/.test(fill[2]), 'the disc is not black');
  clearGhostMarkerCache();
});
