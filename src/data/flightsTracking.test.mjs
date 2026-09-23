// src/data/flightsTracking.test.mjs
// Config-schema contract for the shared flight-tracking pipeline. Both live
// layers (flights.js, militaryFlights.js) instantiate
// createFlightTrackingPipeline(config); the pipeline is a shared-behavior
// chokepoint, so a config seam that drifts on ONE layer silently changes
// behavior for that layer only — the exact failure class this file pins:
// documented keys = consumed keys = keys both call sites actually provide.
import { readSource } from '../testSupport/readSource.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { createFlightTrackingPipeline } from './flightsTracking.js';

const SOURCE = readSource('./flightsTracking.js', import.meta.url);

/** The `@param`-documented config keys → optional flag, from the factory's
 * JSDoc block. */
function documentedConfigKeys() {
  const block = SOURCE.match(
    /\/\*\*[\s\S]*?\*\/\s*\nexport function createFlightTrackingPipeline/,
  );
  assert.ok(block, 'factory JSDoc block must exist');
  const keys = {};
  for (const m of block[0].matchAll(/@param \{[^}]+\} (\[)?config\.([A-Za-z0-9_]+)\]?/g)) {
    keys[m[2]] = m[1] === '[';
  }
  return keys;
}

/** Top-level keys of the object literal passed to
 * createFlightTrackingPipeline({...}) in a consumer source. */
function providedConfigKeys(consumerSource, label) {
  const anchor = consumerSource.indexOf('createFlightTrackingPipeline({');
  assert.notEqual(anchor, -1, `${label} must instantiate the shared pipeline`);
  const open = consumerSource.indexOf('{', anchor);
  let depth = 0;
  let inStr = null;
  let lineComment = false;
  let blockComment = false;
  const entries = [];
  let entryStart = open + 1;
  for (let i = open; i < consumerSource.length; i += 1) {
    const ch = consumerSource[i];
    const next = consumerSource[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) { entries.push(consumerSource.slice(entryStart, i)); break; }
    } else if (ch === ',' && depth === 1) {
      entries.push(consumerSource.slice(entryStart, i));
      entryStart = i + 1;
    }
  }
  const keys = [];
  for (const entry of entries) {
    // Entries may open with inline documentation (the flights call site
    // documents its enrichment seam mid-literal) — comments never carry keys.
    const cleaned = entry
      .replaceAll(/\/\/[^\n]*/g, '')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    if (!cleaned) continue;
    // `key:` entries (values may be identifiers, numbers, strings, arrows).
    const m = cleaned.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/)
      ?? cleaned.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
    assert.ok(m, `${label}: unparseable config entry: ${cleaned.slice(0, 60)}`);
    keys.push(m[1]);
  }
  return keys;
}

test('the factory config schema documents exactly 24 keys with the documented optionality', () => {
  const documented = documentedConfigKeys();
  assert.equal(Object.keys(documented).length, 24, '24 documented config keys');
  const optional = Object.entries(documented).filter(([, opt]) => opt).map(([k]) => k);
  // The only two optional seams are the by-layer divergences: military floors
  // trail fixes to sampled ground; flights alone runs budgeted ambient type
  // enrichment. A new optional key must be a deliberate seam, not an accident.
  assert.deepEqual(optional.sort(), ['requestTypeEnrichment', 'trailFloorFix']);
});

test('the factory consumes exactly the documented keys (runtime get-trap)', () => {
  const documented = documentedConfigKeys();
  const read = new Set();
  const config = new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'string') read.add(key);
      return undefined;
    },
  });
  // Constructing the pipeline is side-effect-light (Cesium scratch objects
  // only) — safe to build against a recording proxy in node.
  createFlightTrackingPipeline(config);
  assert.deepEqual(
    [...read].sort(),
    Object.keys(documented).sort(),
    'every consumed config key must be documented, and every documented key consumed',
  );
});

test('injected seams and presentation constants land on the pipeline verbatim', () => {
  const noop = () => {};
  const config = {
    modelSpec: noop,
    refreshTr3bContact: noop,
    clearTracking: noop,
    trackFlight: noop,
    updateTrackedModel: noop,
    contextSubjectMetadata: noop,
    fleetBillboardColor: noop,
    fleetBillboardScale: noop,
    modelCap: () => 4,
    modelColor: noop,
    modelMatrix: noop,
    normalBillboardScaleByDistance: noop,
    refreshTrailDisplay: noop,
    requestTypeEnrichment: noop,
    trailFloorFix: noop,
    trackedLabelText: noop,
    fleetFreshnessColor: noop,
    infoSpeed: () => 240,
    infoHeading: () => 91.2,
    trackedModelMaxPx: 200,
    trackedFocusScaleBase: 1,
    trackedLabelAccent: '#39d0ff',
    unmodeledTrackedColor: Cesium.Color.CYAN.withAlpha(0.8),
    modeledIconColor: Cesium.Color.CYAN,
  };
  const p = createFlightTrackingPipeline(config);
  // Function seams are stored by reference, not wrapped — callers may rely on
  // identity (and the layer owns their lifecycle).
  assert.equal(p._modelSpec, config.modelSpec);
  assert.equal(p._clearTracking, config.clearTracking);
  assert.equal(p._infoSpeed, config.infoSpeed);
  assert.equal(p._trailFloorFix, config.trailFloorFix, 'optional seam stored when provided');
  // Presentation constants keep their documented pipeline-facing names.
  assert.equal(p.TRACKED_MODEL_MAX_PX, 200);
  assert.equal(p.TRACKED_FOCUS_SCALE_BASE, 1);
  assert.equal(p.TRACKED_LABEL_ACCENT, '#39d0ff');
  assert.equal(p.UNMODELED_TRACKED_COLOR, config.unmodeledTrackedColor);
  assert.equal(p.MODELED_ICON_COLOR, config.modeledIconColor);
});

const CONSUMERS = [
  ['flights.js', './flights.js'],
  ['militaryFlights.js', './militaryFlights.js'],
];

test('both live layers provide every required key and no orphan key', () => {
  const documented = documentedConfigKeys();
  const required = Object.keys(documented).filter((k) => !documented[k]);
  for (const [label, path] of CONSUMERS) {
    const provided = providedConfigKeys(readSource(path, import.meta.url), label);
    assert.equal(new Set(provided).size, provided.length, `${label}: duplicate config keys`);
    const orphans = provided.filter((k) => !(k in documented));
    assert.deepEqual(orphans, [], `${label}: keys the pipeline does not consume`);
    const missing = required.filter((k) => !provided.includes(k));
    assert.deepEqual(missing, [], `${label}: required keys missing from the call site`);
  }
});

test('the two layers together wire every documented seam (no dead config)', () => {
  const documented = Object.keys(documentedConfigKeys()).sort();
  const union = new Set();
  for (const [label, path] of CONSUMERS) {
    for (const key of providedConfigKeys(readSource(path, import.meta.url), label)) {
      union.add(key);
    }
  }
  assert.deepEqual([...union].sort(), documented,
    'a seam no layer provides is dead config and must be removed or wired');
  // And the layer divergence is exactly the optional seams — flights pushes
  // raw trail fixes and runs ambient enrichment; military does the opposite.
  const flights = providedConfigKeys(readSource('./flights.js', import.meta.url), 'flights.js');
  const military = providedConfigKeys(readSource('./militaryFlights.js', import.meta.url), 'militaryFlights.js');
  assert.deepEqual(['trailFloorFix'].filter((k) => !flights.includes(k)), ['trailFloorFix'],
    'flights must NOT floor trail fixes (raw-fix contract)');
  assert.deepEqual(['requestTypeEnrichment'].filter((k) => !military.includes(k)), ['requestTypeEnrichment'],
    'military must NOT run ambient enrichment (budget contract)');
});
