import test from 'node:test';
import assert from 'node:assert/strict';
import { GeospatialThreatScanner } from './geospatialThreatScanner.js';

test('GeospatialThreatScanner detects squawk 7700 emergencies and earthquake hazards', () => {
  const domElements = [];
  const mockDoc = {
    createElement: (tag) => {
      const el = {
        tagName: tag,
        className: '',
        style: {},
        innerHTML: '',
        children: [],
        appendChild: (child) => el.children.push(child),
        querySelectorAll: () => [],
        querySelector: () => null,
        remove: () => {},
      };
      domElements.push(el);
      return el;
    },
    body: {
      appendChild: (el) => domElements.push(el),
    },
  };

  let flyToTarget = null;
  const mockFlightEntity = {
    name: 'UAL920',
    properties: {
      squawk: '7700',
      callsign: 'UAL920',
    },
    position: null,
  };

  const mockQuakeEntity = {
    name: 'Off Coast of Honshu',
    properties: {
      mag: 6.2,
      place: 'Off Coast of Honshu, Japan',
      longitude: 142.5,
      latitude: 38.3,
    },
  };

  const mockViewer = {
    entities: {
      values: [mockFlightEntity, mockQuakeEntity],
    },
    flyTo: (entity) => {
      flyToTarget = entity;
    },
    camera: {
      flyTo: () => {},
    },
  };

  const messages = [];
  const sentQueries = [];
  const mockAi = {
    appendMessage: (role, msg) => messages.push({ role, msg }),
    sendMessage: (text) => sentQueries.push(text),
  };

  const cues = [];
  const scanner = new GeospatialThreatScanner({
    viewer: mockViewer,
    aiController: mockAi,
    documentRef: mockDoc,
    playCue: (cue) => cues.push(cue),
    scanIntervalMs: 1000,
  });

  // Run initial scan
  scanner.scanNow();

  // Verify threat alert sound triggered
  assert.equal(cues.includes('alert'), true);

  // Verify JARVIS received notifications for both threats
  assert.ok(
    messages.some((m) => m.msg.includes('UAL920') && m.msg.includes('7700')),
  );
  assert.ok(
    messages.some((m) => m.msg.includes('M6.2') && m.msg.includes('Honshu')),
  );

  // Test intercepting threat
  scanner.interceptThreat({ entity: mockFlightEntity });
  assert.equal(flyToTarget, mockFlightEntity);

  // Stop scanner
  scanner.stop();
});
