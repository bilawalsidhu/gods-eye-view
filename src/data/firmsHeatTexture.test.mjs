// src/data/firmsHeatTexture.test.mjs
//
// Pure-logic coverage for the WASM heat-texture bridge: layout math (aspect,
// clamps, whole-globe fallback), anti-meridian longitude domain mapping, and
// splat-input building (heat parity with the entity path's normalization).
// The WASM call itself is runtime-verified in the browser (docs/PLAN.md
// Phase 5) — here the render step is exercised with a stub renderer against
// a stub document.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSplatInputs,
  computeHeatTextureLayout,
  renderHeatTexture,
  textureDomainLon,
  wasmHeatRenderingEnabled,
} from './firmsHeatTexture.js';

const LOD = { gridDegrees: 2.0 };

/** Make one aggregated cell (firmsHeatmap aggregateFires shape). */
function cell(latCell, lonCell, overrides = {}) {
  return {
    latCell,
    lonCell,
    count: 1,
    intensity: 10,
    maxFrp: 5,
    night: 0,
    newestAcqMs: 0,
    ...overrides,
  };
}

function score(c) {
  return c.intensity + c.count * 0.8 + c.night * 0.6 + c.maxFrp * 0.12;
}

test('layout matches cell-grid resolution and clamps to the texture cap', () => {
  // 60° lon span at 2°/cell → 30 cells → 180 px wide.
  const bounds = { west: -120, south: 30, east: -60, north: 60, wraps: false };
  const layout = computeHeatTextureLayout(bounds, 2.0);
  assert.equal(layout.width, 180);
  assert.equal(layout.height, 90);
  assert.equal(layout.west, -120);
  assert.equal(layout.south, 30);
  assert.equal(layout.lonSpan, 60);
  assert.equal(layout.latSpan, 30);
});

test('layout honors the 1024 px cap on huge spans without breaking scale', () => {
  const layout = computeHeatTextureLayout({ west: -180, south: -90, east: 180, north: 90, wraps: false }, 0.25);
  assert.equal(layout.width, 1024);
  assert.equal(layout.height, 1024);
});

test('layout null bounds → whole-globe texture', () => {
  const layout = computeHeatTextureLayout(null, 2.0);
  assert.equal(layout.west, -180);
  assert.equal(layout.south, -90);
  assert.equal(layout.lonSpan, 360);
  assert.equal(layout.latSpan, 180);
});

test('layout returns null for degenerate spans', () => {
  assert.equal(computeHeatTextureLayout({ west: 10, south: 10, east: 10, north: 10, wraps: false }, 2), null);
  assert.equal(computeHeatTextureLayout({ west: 10, south: 10, east: 20, north: 10, wraps: false }, 2), null);
  assert.equal(computeHeatTextureLayout({ west: 10, south: 10, east: 20, north: 20, wraps: false }, 0), null);
});

test('textureDomainLon wraps cell centers into [west, west+360)', () => {
  const bounds = { west: 175, east: -175, wraps: true };
  assert.equal(textureDomainLon(176, bounds), 176);
  assert.equal(textureDomainLon(-179, bounds), 181); // right of the anti-meridian
  // A center WEST of the wrapping box (its rectangle may still intersect the
  // padded edge) lands outside [west, west+span] — 534 ∉ [175, 185] — so the
  // renderer drops it. That is the intended contract: only centers inside the
  // wrapping box are painted.
  assert.equal(textureDomainLon(174, bounds), 534);
  assert.equal(textureDomainLon(10, { west: -10, east: 10, wraps: false }), 10); // pass-through
});

test('splat inputs preserve heat ordering via the crate brightness window', () => {
  const cells = [
    cell(10, 10, { intensity: 100 }), // hottest
    cell(20, 20, { intensity: 10 }),
    cell(30, 30, { intensity: 1 }), // weakest
  ];
  const inputs = buildSplatInputs(cells, LOD, null);
  assert.ok(inputs);
  assert.equal(inputs.lons.length, 3);
  // Cell centers, not corners.
  assert.equal(inputs.lats[0], 11);
  assert.equal(inputs.lons[0], 11);
  // Crate normalizes [300, 500] → hottest maps near 500, weakest just above 300.
  const hottest = inputs.brights[0];
  const weakest = inputs.brights[2];
  assert.ok(hottest > 450 && hottest <= 500, `hottest brightness ${hottest}`);
  assert.ok(weakest > 300 && weakest < hottest, `weakest brightness ${weakest}`);
  assert.ok(inputs.brights.every((b) => b > 300), 'no cell maps to zero intensity (invisible)');
});

test('splat inputs drop cells outside the padded bounds', () => {
  const cells = [cell(10, 10), cell(50, 50)];
  const bounds = { west: 5, south: 5, east: 15, north: 15, wraps: false };
  const inputs = buildSplatInputs(cells, LOD, bounds);
  assert.equal(inputs.lons.length, 1);
  assert.equal(inputs.lats[0], 11);
});

test('splat inputs remap wrapping-bound longitudes into the texture domain', () => {
  const cells = [cell(10, 178), cell(10, -178)];
  const bounds = { west: 175, south: 8, east: -175, north: 12, wraps: true };
  const inputs = buildSplatInputs(cells, LOD, bounds);
  assert.equal(inputs.lons.length, 2);
  // -178 is right of the anti-meridian → must land right of 178 in the texture.
  assert.ok(Math.min(...inputs.lons) >= 175);
  assert.ok(Math.max(...inputs.lons) > 180);
});

test('splat inputs return null for empty/invalid arguments', () => {
  assert.equal(buildSplatInputs([], LOD, null), null);
  assert.equal(buildSplatInputs([cell(0, 0)], { gridDegrees: 0 }, null), null);
  // All cells clipped → nothing to splat.
  assert.equal(buildSplatInputs([cell(50, 50)], LOD, { west: 5, south: 5, east: 15, north: 15, wraps: false }), null);
});

test('renderHeatTexture paints the stub canvas with exact buffer dimensions', () => {
  const painted = new globalThis.Uint8ClampedArray(4 * 8 * 4);
  painted[0] = 200; // first pixel red channel
  const renderer = { render: (...args) => (renderHeatTexture.args = args, painted) };
  const layout = { width: 8, height: 4, west: 0, south: 0, lonSpan: 16, latSpan: 8 };
  const inputs = { lons: new Float64Array(1), lats: new Float64Array(1), brights: new Int32Array(1) };
  const created = [];
  const documentLike = {
    createElement(tag) {
      const canvas = {
        tag,
        width: 0,
        height: 0,
        contexts: 0,
        getContext() {
          this.contexts += 1;
          return { putImageData(data) { this.data = data; } };
        },
      };
      created.push(canvas);
      return canvas;
    },
    createImageData(data, w, h) {
      return { data, width: w, height: h };
    },
  };
  const result = renderHeatTexture(renderer, inputs, layout, documentLike);
  assert.ok(result);
  assert.equal(created.length, 1);
  assert.equal(created[0].width, 8);
  assert.equal(created[0].height, 4);
  assert.equal(result.canvas, created[0]);
  assert.equal(result.pixels, painted);
  // Crate call: [min,max) window passed as west/east, south/north pairs.
  assert.deepEqual(renderHeatTexture.args.slice(3), [8, 4, 0, 16, 0, 8]);
});

test('renderHeatTexture rejects wrong-shaped buffers and rendererless calls', () => {
  const layout = { width: 8, height: 4, west: 0, south: 0, lonSpan: 16, latSpan: 8 };
  const inputs = { lons: new Float64Array(1), lats: new Float64Array(1), brights: new Int32Array(1) };
  assert.equal(renderHeatTexture(null, inputs, layout, stubDoc()), null);
  const shortBuffer = new globalThis.Uint8ClampedArray(10);
  assert.equal(renderHeatTexture({ render: () => shortBuffer }, inputs, layout, stubDoc()), null);
  const good = new globalThis.Uint8ClampedArray(4 * 8 * 4);
  assert.equal(renderHeatTexture({ render: () => good }, inputs, layout, null), null); // no document

  function stubDoc() {
    return {
      createElement() {
        return { width: 0, height: 0, getContext: () => ({ putImageData() {} }) };
      },
      createImageData: (data) => ({ data }),
    };
  }
});

test('kill switch defaults to enabled outside a browser location', () => {
  assert.equal(wasmHeatRenderingEnabled(), true);
});

test('splat heat parity: score order maps monotonically to brightness', () => {
  const cells = [cell(0, 0, { intensity: 5 }), cell(10, 10, { intensity: 25 }), cell(20, 20, { intensity: 50 })];
  const inputs = buildSplatInputs(cells, LOD, null);
  const byScore = [...cells].map(score);
  const hottestIdx = byScore.indexOf(Math.max(...byScore));
  assert.equal(inputs.brights[hottestIdx], Math.max(...inputs.brights));
});
