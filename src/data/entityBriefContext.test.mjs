import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEntityBriefPayload,
  buildLocalEntityBrief,
  buildLocalRegionBrief,
  buildNaturalIntelBrief,
  buildPlaceNarrativeParts,
  buildRegionBriefPayload,
  estimateBoundsAreaKm2,
  formatContactProse,
  formatRegionTitle,
  metaChipsFromRecord,
  metaChipsFromRegion,
  normalizeHeadlineTitles,
  summarizeRecordForBrief,
} from './entityBriefContext.js';
import {
  GEMINI_BRIEF_UNCONFIGURED_CODE,
  isGeminiBriefUnconfigured,
  keylessGeminiBriefResponse,
} from '../geminiBriefResponse.js';
import { buildGeminiEntityBriefUserParts, buildGeminiGenerationConfig } from '../../scripts/gemini-entity-brief-proxy.mjs';

test('summarizeRecordForBrief compacts aircraft metadata', () => {
  const summary = summarizeRecordForBrief({
    id: 'ae1234',
    layerId: 'military-flights',
    label: '59-1474',
    latitude: 31.88,
    longitude: -83.04,
    properties: {
      typeCode: 'K35R',
      callsign: '59-1474',
      operator: '',
      altitudeFt: 7350,
    },
  });
  assert.equal(summary.name, '59-1474');
  assert.equal(summary.properties.typeCode, 'K35R');
  assert.equal(summary.properties.altitudeFt, '7350');
});

test('buildEntityBriefPayload wraps target and timestamp', () => {
  const payload = buildEntityBriefPayload({
    id: 'v1',
    layerId: 'ais-live-vessels',
    label: 'MAERSK TEST',
    latitude: -20.1,
    longitude: 57.5,
    properties: { shipType: 'Cargo' },
  });
  assert.equal(payload.kind, 'contact');
  assert.ok(payload.target);
  assert.ok(payload.requestedAt);
  assert.equal(payload.target.layerName, 'Vessel');
});

test('metaChipsFromRecord keeps concise highlight tags', () => {
  const chips = metaChipsFromRecord({
    id: 'x',
    layerId: 'flights',
    label: 'JBU165',
    properties: { callsign: 'JBU165', type: 'A320' },
  });
  assert.deepEqual(chips, ['Aircraft', 'A320', 'JBU165']);
});

test('buildLocalEntityBrief works without Gemini', () => {
  const text = buildLocalEntityBrief({
    id: 'x',
    layerId: 'flights',
    label: 'TEST123',
    latitude: 1,
    longitude: 2,
    properties: { type: 'B738' },
  });
  assert.match(text, /Aircraft: TEST123/);
  assert.match(text, /GEMINI_API_KEY/);
});

test('keylessGeminiBriefResponse describes missing provider', () => {
  const response = keylessGeminiBriefResponse('');
  assert.equal(response.payload.code, GEMINI_BRIEF_UNCONFIGURED_CODE);
  assert.equal(isGeminiBriefUnconfigured(200, response.payload), true);
});

test('buildRegionBriefPayload prioritizes monitoring context', () => {
  const bounds = {
    south: 31.8,
    north: 32.0,
    west: -83.2,
    east: -82.9,
    center: { lat: 31.9, lon: -83.04 },
  };
  const payload = buildRegionBriefPayload({
    bounds,
    contacts: [{ layerId: 'cctv', name: 'Cam-1' }],
    place: {
      label: 'Cordele, Georgia',
      locality: 'Cordele',
      region: 'Georgia',
      country: 'United States',
      countryCode: 'US',
    },
    weather: { weatherCode: 0, temperatureC: 24, windKph: 12, precipitationMm: 0 },
    headlines: [{ title: 'Regional headline' }],
    landmarks: [{ name: 'Test Landmark', city: 'Test', distanceKm: 0.5, inSelection: true }],
  });
  assert.equal(payload.kind, 'marquee');
  assert.equal(payload.focus, 'viewport');
  assert.equal(payload.place.label, 'Cordele, Georgia');
  assert.ok(payload.selection.approxAreaKm2 > 0);
  assert.ok(payload.selection.assetSummary.cctv === 1);
  assert.equal(payload.landmarks.length, 1);
  assert.deepEqual(payload.headlines, ['Regional headline']);
});

test('buildGeminiGenerationConfig caps thinking for Gemini 3 models', () => {
  const config = buildGeminiGenerationConfig('gemini-3.6-flash');
  assert.equal(config.maxOutputTokens, 1024);
  assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'minimal' });
});

test('buildGeminiEntityBriefUserParts attaches viewport image for vision analysis', () => {
  const { parts, hasViewport } = buildGeminiEntityBriefUserParts({
    kind: 'marquee',
    viewportCapture: {
      mimeType: 'image/jpeg',
      width: 640,
      height: 360,
      dataBase64: 'abc123',
    },
    contacts: [{ layerId: 'military', name: 'TEST1' }],
  });

  assert.equal(hasViewport, true);
  assert.equal(parts[0].inlineData.data, 'abc123');
  assert.match(parts[1].text, /TEST1/);
});

test('buildPlaceNarrativeParts shows vision pending placeholder', () => {
  const parts = buildPlaceNarrativeParts({
    visionPending: true,
    bounds: { center: { lat: 25, lon: 56 } },
    contacts: [{ layerId: 'military', name: 'TEST1', properties: { callsign: 'TEST1' } }],
  });
  assert.match(parts.narrative, /looking at/i);
  assert.equal(parts.contactParagraphs.length, 0);
});

test('buildPlaceNarrativeParts reads as natural analyst prose', () => {
  const parts = buildPlaceNarrativeParts({
    place: { label: 'Port Louis, Mauritius', country: 'Mauritius' },
    weather: { weatherCode: 0, temperatureC: 24 },
    bounds: { south: -20.2, north: -20.0, west: 57.4, east: 57.6, center: { lat: -20.1, lon: 57.5 } },
    areaKm2: 4,
    geoReliable: true,
    contacts: [{
      layerId: 'military',
      name: '17-46036',
      latitude: -20.1,
      longitude: 57.5,
      properties: {
        callsign: '17-46036',
        aircraftClass: 'widebody',
        altitudeFt: 34000,
        speedMps: 220,
        heading: 90,
        operator: 'USAF',
      },
    }],
  });
  assert.match(parts.narrative, /around Port Louis, Mauritius/);
  assert.match(parts.narrative, /one military aircraft/i);
  assert.match(parts.narrative, /17-46036/);
  assert.match(parts.narrative, /FL340|circulating/i);
  assert.match(parts.narrative, /U\.S\. Air Force|USAF/i);
  assert.match(parts.narrative, /34°C|Temperature/i);
  assert.equal(parts.contactParagraphs.length, 0);
});

test('buildNaturalIntelBrief weaves CCTV and weather naturally', () => {
  const text = buildNaturalIntelBrief({
    place: { label: 'Strait of Oman', region: 'Gulf of Oman', country: 'Oman' },
    weather: { weatherCode: 0, temperatureC: 34 },
    enabledLayers: [{ id: 'cctv', name: 'CCTV' }],
    contacts: [
      {
        layerId: 'military',
        name: '17-46034',
        properties: { callsign: '17-46034', typeCode: 'K35R', operator: 'USAF', altitudeFt: 26000, speedMps: 230, heading: 90 },
      },
      {
        layerId: 'military',
        name: 'AE688D',
        properties: { callsign: 'AE688D', altitudeFt: 34000, speedMps: 210, heading: 270 },
      },
      {
        layerId: 'cctv',
        name: 'Port Camera',
        properties: { name: 'Port Camera', city: 'Muscat' },
      },
    ],
  });
  assert.match(text, /Strait of Oman/);
  assert.match(text, /2 military aircraft/);
  assert.match(text, /KC-135|refueling/i);
  assert.match(text, /Temperature.*34°C/i);
  assert.match(text, /CCTV.*Port Camera/i);
});

test('formatContactProse avoids field labels', () => {
  const prose = formatContactProse({
    layerId: 'military',
    name: '17-46036',
    latitude: 25.1,
    longitude: 56.4,
    properties: { callsign: '17-46036', aircraftClass: 'widebody', altitudeFt: 26000, heading: 270 },
  });
  assert.match(prose, /Military track 17-46036 \(widebody\)/);
  assert.doesNotMatch(prose, /Type:/);
});

test('buildPlaceNarrativeParts explains unreliable geo selections', () => {
  const parts = buildPlaceNarrativeParts({
    bounds: { south: 51.5, north: 51.51, west: -0.13, east: -0.12, center: { lat: 51.505, lon: -0.125 } },
    areaKm2: 50_000,
    geoReliable: false,
    enabledLayers: [{ id: 'cctv', name: 'CCTV' }],
    contacts: [{
      layerId: 'military',
      name: 'TEST1',
      properties: { callsign: 'TEST1' },
    }],
  });
  assert.match(parts.narrative, /drawn box/i);
});

test('buildLocalRegionBrief reads as native place narrative', () => {
  const text = buildLocalRegionBrief({
    bounds: { center: { lat: -20.1, lon: 57.5 } },
    place: { label: 'Port Louis, Mauritius', country: 'Mauritius' },
    weather: { weatherCode: 0, temperatureC: 24 },
    headlineTitles: ['Harbour expansion update'],
    contacts: [{
      layerId: 'flights',
      name: 'DTA577',
      properties: { typeCode: 'B738', altitudeFt: 35000, operator: 'TAAG', routeOrigin: 'LAD', routeDestination: 'JNB', speedMps: 220 },
    }],
  });
  assert.match(text, /Port Louis, Mauritius/);
  assert.match(text, /DTA577/);
  assert.match(text, /Boeing 737|B738/i);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test('normalizeHeadlineTitles accepts article objects', () => {
  assert.deepEqual(
    normalizeHeadlineTitles([{ title: 'One headline' }, { title: 'Two headline' }]),
    ['One headline', 'Two headline'],
  );
});

test('metaChipsFromRegion prefers asset counts over weather', () => {
  const chips = metaChipsFromRegion({
    weather: { weatherCode: 0, temperatureC: 20 },
    contacts: [
      { layerId: 'cctv' },
      { layerId: 'flights' },
    ],
  });
  assert.match(chips[0], /1 cam/);
  assert.match(chips[0], /1 aircraft/);
});

test('formatRegionTitle prefers place label over coordinates', () => {
  assert.equal(
    formatRegionTitle({ place: { label: 'Austin, Texas' }, bounds: { center: { lat: 30, lon: -97 } } }),
    'Austin, Texas',
  );
});

test('estimateBoundsAreaKm2 returns positive area for valid bounds', () => {
  const area = estimateBoundsAreaKm2({
    south: 30,
    north: 31,
    west: -98,
    east: -97,
    center: { lat: 30.5, lon: -97.5 },
  });
  assert.ok(area > 9000 && area < 11000);
});
