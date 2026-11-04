// src/ui/unitSurfaces.test.mjs — every surface family that shows a measurement
// reads it in the Display → Units system, both ways, while what tools and
// share links receive stays metric.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import { applicationI18n } from './i18n.js';
import {
  formatSpeed,
  formatTemperature,
  setUnitSystem,
} from './unitLabels.js';
import { formatCockpitDistance } from './cockpitPresentation.js';
import { createContextState } from './cockpitContextState.js';
import { presentCctvCalibration } from './cctvCalibration.js';
import { hudAltitude, hudMeasure, hudReadout } from '../hudLocalityFormat.js';
import { presentAwarenessDistance } from '../layers/awareness/panel.js';
import { localizeCoverageLabel } from '../layers/awareness/coverageLabel.js';
import { routeDistanceText } from '../layers/directions/index.js';
import { windReadingResult } from '../layers/wind/presentation.js';
import { buildTransitSelectionCopy } from '../layers/transit/policy.js';
import { getTransitFeed } from '../data/transitFeeds.js';
import { formatMeasure as drawMeasure } from '../annotations/drawMode.js';
import { attachVoiceResult } from '../voice/speech.js';
import { presentResult } from '../voice/resultDisplay.js';

const NBSP = String.fromCharCode(160);
/** "4.2 KM" as formatters write it: a no-break space before the unit. */
const nb = (text) => text.replace(/ (?=[^ ]+$)/, NBSP);

/** `body` in metric, then in imperial; back to metric afterwards. */
function bothSystems(body) {
  setLocale('en');
  try {
    setUnitSystem('metric');
    const metric = body();
    setUnitSystem('imperial');
    const imperial = body();
    return { metric, imperial };
  } finally {
    setUnitSystem('metric');
  }
}

test('Cockpit: contact distances and the Contacts window', () => {
  assert.deepEqual(
    bothSystems(() => [
      formatCockpitDistance(4200),
      formatCockpitDistance(44_000),
      createContextState().subject,
    ]),
    {
      metric: [nb('4.2 KM'), nb('44 KM'), nb('CONTACTS · 250 KM')],
      imperial: [nb('2.6 MI'), nb('27 MI'), nb('CONTACTS · 155 MI')],
    },
  );
});

test('Cockpit brief weather: temperature and wind', () => {
  assert.deepEqual(
    bothSystems(() => [formatTemperature(-5), formatSpeed(10)]),
    {
      metric: [nb('-5 °C'), nb('36 km/h')],
      imperial: [nb('23 °F'), nb('22 mph')],
    },
  );
});

test('HUD: altitude, view window, sensor readouts', () => {
  assert.deepEqual(
    bothSystems(() => [
      hudAltitude(850),
      hudAltitude(4200),
      `${hudMeasure(12, '')}x${hudMeasure(8, 'km')}`,
      hudReadout(0.3, 2),
      hudReadout(120, 0),
    ]),
    {
      metric: ['850M', '4.2KM', '12x8KM', '0.30m', '120m'],
      imperial: ['2789FT', '2.6MI', '7x5MI', '0.98ft', '394ft'],
    },
  );
});

test('Contacts and routes: distances switch units at their thresholds', () => {
  assert.deepEqual(
    bothSystems(() => [
      presentAwarenessDistance(850),
      presentAwarenessDistance(250_000),
      routeDistanceText(42),
      routeDistanceText(1234),
      routeDistanceText(21_000),
      routeDistanceText(null),
    ]),
    {
      metric: [nb('850 m'), nb('250 km'), nb('42 m'), nb('1.2 km'), nb('21 km'), ''],
      imperial: [nb('0.5 mi'), nb('155 mi'), nb('138 ft'), nb('0.8 mi'), nb('13 mi'), ''],
    },
  );
});

test('Weather: a wind reading shows temperature in the unit system, speed in its chip unit', () => {
  const reading = {
    speed: 5,
    units: 'km/h',
    from: 'N',
    coordinates: '29.93°N · 97.74°W',
    model: 'GFS',
    validTime: '2026-10-14 14:00 UTC',
    scalarKind: 'temperature',
    scalarLabel: 'Air temperature · 2 m',
    scalarValue: '-3.0 °C',
    explanation: 'Interpolated model forecast.',
  };
  const lines = bothSystems(() =>
    Object.fromEntries(
      windReadingResult(reading).lines.map((line) => [line.id, line.text]),
    ),
  );
  assert.equal(lines.metric.scalar, nb('Air temperature · 2 m · -3.0 °C'));
  assert.equal(lines.imperial.scalar, nb('Air temperature · 2 m · 26.6 °F'));
  // Wind speed keeps the layer's own unit chip (km/h here) in both systems.
  assert.equal(lines.metric.wind, lines.imperial.wind);
  assert.match(lines.imperial.wind, /km\/h/);
});

test('CCTV: calibration lengths read in feet and convert back to metres', () => {
  const state = {
    activeCamera: {
      headingDeg: 90,
      pitchDeg: -10,
      fovDeg: 60,
      rangeM: 120,
      mountHeightM: 6,
      calibration: { offsetNorthM: 1.5, offsetEastM: -0.5 },
    },
  };
  const values = bothSystems(() => presentCctvCalibration(state, true).values);
  assert.deepEqual(
    [values.metric.range, values.metric.height, values.metric.north],
    ['RANGE 120m', 'HGT 6m', 'ΔN 1.5m'],
  );
  assert.deepEqual(
    [values.imperial.range, values.imperial.height, values.imperial.north],
    ['RANGE 394ft', 'HGT 20ft', 'ΔN 4.9ft'],
  );
  // Degrees never convert.
  assert.equal(values.imperial.fov, values.metric.fov);
});

test('Transit: the reported speed follows the unit system; English copy stays metric', () => {
  const feed = getTransitFeed('metrotransit-msp');
  const record = {
    id: '1557',
    label: '1557',
    routeId: '17',
    lat: 44.9,
    lon: -93.4,
    speedMps: 11.2,
    timestamp: 1_788_936_945,
    timestampSource: 'vehicle',
  };
  const now = 1_788_936_960_000;
  const reported = (copy) => copy.details.find((line) => line.startsWith('reported'));
  const shown = bothSystems(() =>
    reported(
      buildTransitSelectionCopy(feed, record, 'bus', now, null, null, undefined, formatSpeed),
    ),
  );
  assert.equal(shown.metric, nb('reported 40 km/h'));
  assert.equal(shown.imperial, nb('reported 25 mph'));
  // The tools' English copy keeps km/h whatever the page shows.
  const english = bothSystems(() =>
    reported(buildTransitSelectionCopy(feed, record, 'bus', now)),
  );
  assert.deepEqual(english, {
    metric: 'reported 40 km/h',
    imperial: 'reported 40 km/h',
  });
});

test('Draw: a line and an area measure in the unit system', () => {
  const line = {
    shape: 'line',
    vertices: [
      { lon: -97.75, lat: 30.26 },
      { lon: -97.73, lat: 30.27 },
    ],
  };
  const area = {
    shape: 'area',
    vertices: [
      { lon: -97.75, lat: 30.26 },
      { lon: -97.74, lat: 30.26 },
      { lon: -97.74, lat: 30.27 },
    ],
  };
  const measured = bothSystems(() => [drawMeasure(line), drawMeasure(area)]);
  assert.deepEqual(measured.metric, ['2.2 km', '53.5 ha']);
  assert.deepEqual(measured.imperial, ['1.4 mi', '132.2 ac']);
});

test('Voice: what is said and shown follows the unit system; the result data stays metric', () => {
  const framed = bothSystems(() =>
    attachVoiceResult('frame_overhead', {
      ok: false,
      count: 0,
      error: 'nothing in range',
      radiusKm: 25,
      layerId: 'flights',
    }),
  );
  assert.match(framed.metric.say, / within 25 km\.$/);
  assert.match(framed.imperial.say, / within 16 miles\.$/);
  assert.equal(framed.imperial.radiusKm, 25, 'the tool result keeps km');

  const view = bothSystems(
    () =>
      attachVoiceResult('get_current_view_state', {
        ok: true,
        camera: { heightM: 12_000 },
        layers: [],
      }).say,
  );
  assert.match(view.metric, /Camera 12 km up/);
  assert.match(view.imperial, /Camera 7 miles up/);

  const area = bothSystems(
    () =>
      presentResult('resolve_area', { ok: true, name: 'Lake', areaKm2: 2.5 })
        .display.lines[0],
  );
  assert.deepEqual(area, { metric: nb('2.5 km²'), imperial: nb('0.965 mi²') });

  const scope = bothSystems(
    () =>
      presentResult('analyst_query', {
        ok: true,
        count: 2,
        complete: true,
        scopeLabel: 'in view',
        feedState: 'nominal',
        unanswered: [],
        display: { scope: 'within 250 km of the view centre' },
        items: [],
      }).display.lines[0],
  );
  assert.deepEqual(scope, {
    metric: `within 250${NBSP}km of the view centre`,
    imperial: `within 155.3${NBSP}mi of the view centre`,
  });
});

test('a view that formats a measurement re-renders when the unit system changes', async (t) => {
  setLocale('en');
  setUnitSystem('metric');
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({ render: () => h('span', formatTemperature(20)) });
  app.use(applicationI18n());
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
    setUnitSystem('metric');
  });
  assert.equal(host.textContent, nb('20 °C'));
  setUnitSystem('imperial');
  await nextTick();
  assert.equal(host.textContent, nb('68 °F'));
  setUnitSystem('metric');
  await nextTick();
  assert.equal(host.textContent, nb('20 °C'));
});

test('Voice: one mile, one foot and one mile up are said in the singular', () => {
  const say = (radiusKm) =>
    attachVoiceResult('frame_overhead', {
      ok: false,
      count: 0,
      error: 'nothing in range',
      radiusKm,
      layerId: 'flights',
    }).say;
  const height = (heightM) =>
    attachVoiceResult('get_current_view_state', {
      ok: true,
      camera: { heightM },
      layers: [],
    }).say;
  const imperial = bothSystems(() => [
    say(1.609344),
    say(2.5),
    height(1700),
    height(0.3),
    height(600),
  ]).imperial;
  assert.match(imperial[0], / within 1 mile\.$/);
  assert.match(imperial[1], / within 1\.6 miles\.$/);
  assert.match(imperial[2], /Camera 1 mile up/);
  assert.match(imperial[3], /Camera 1 foot up/);
  assert.match(imperial[4], /Camera 1,969 feet up/);
});

test('Contacts: installation coverage is worded when shown, so a switch rewords it', () => {
  assert.deepEqual(
    bothSystems(() => [
      localizeCoverageLabel('WITHIN 62 KM'),
      localizeCoverageLabel('CURRENT VIEWPORT ONLY'),
      localizeCoverageLabel('SOMETHING ELSE'),
      localizeCoverageLabel(null),
    ]),
    {
      metric: [nb('WITHIN 62 KM'), 'CURRENT VIEWPORT ONLY', 'SOMETHING ELSE', null],
      imperial: [nb('WITHIN 39 MI'), 'CURRENT VIEWPORT ONLY', 'SOMETHING ELSE', null],
    },
  );
});
