import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidRayhunterBase,
  parseRayhunterWarnings,
  pickManifestTargetName,
} from './rayhunterTap.js';

test('isValidRayhunterBase: accepts host:port, rejects malformed or metadata targets', () => {
  assert.equal(isValidRayhunterBase('192.168.1.1:8080'), true);
  assert.equal(isValidRayhunterBase('my-hotspot.local:8080'), true);
  assert.equal(isValidRayhunterBase('192.168.1.1'), false, 'missing port');
  assert.equal(isValidRayhunterBase('192.168.1.1:0'), false, 'port out of range');
  assert.equal(isValidRayhunterBase('192.168.1.1:70000'), false, 'port out of range');
  assert.equal(isValidRayhunterBase(''), false);
  assert.equal(isValidRayhunterBase(null), false);
  // Not a real security boundary by itself (the server-side proxy re-validates
  // and is the actual enforcement point) but should still reject the obvious
  // cloud-metadata address for a sane UI-side error message.
  assert.equal(isValidRayhunterBase('192.168.1.1:8080/../etc'), false);
});

test('pickManifestTargetName: prefers the live recording, else the most recent closed one', () => {
  assert.equal(pickManifestTargetName({ current_entry: { name: 'in-progress' }, entries: [] }), 'live');
  assert.equal(pickManifestTargetName({ current_entry: null, entries: [] }), null);
  assert.equal(pickManifestTargetName({ entries: [] }), null);
  assert.equal(
    pickManifestTargetName({
      current_entry: null,
      entries: [
        { name: 'older', start_time: '2026-08-20T00:00:00Z' },
        { name: 'newer', start_time: '2026-08-24T00:00:00Z' },
      ],
    }),
    'newer',
  );
});

test('parseRayhunterWarnings: skips the metadata line, Informational events, and malformed lines', () => {
  const ndjson = [
    JSON.stringify({ analyzers: [], rayhunter: {}, report_version: 1 }), // metadata line
    JSON.stringify({ packet_timestamp: '2026-08-25T00:00:00Z', skipped_message_reason: null, events: [{ event_type: 'Informational', message: 'nothing to see' }] }),
    JSON.stringify({ packet_timestamp: '2026-08-25T00:00:05Z', skipped_message_reason: null, events: [null, { event_type: 'High', message: 'Suspicious paging' }] }),
    'not even json',
    JSON.stringify({ packet_timestamp: '2026-08-25T00:00:10Z', skipped_message_reason: null, events: [{ event_type: 'Low', message: 'Odd config' }] }),
  ].join('\n');

  const warnings = parseRayhunterWarnings(ndjson);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings.map((w) => w.severity), ['High', 'Low']);
  assert.equal(warnings[0].message, 'Suspicious paging');
  assert.equal(warnings[0].timestamp, '2026-08-25T00:00:05Z');
  // Distinct keys so re-polling the same growing file never double-counts a warning.
  assert.notEqual(warnings[0].key, warnings[1].key);
});

test('parseRayhunterWarnings: empty/garbage input yields no warnings, never throws', () => {
  assert.deepEqual(parseRayhunterWarnings(''), []);
  assert.deepEqual(parseRayhunterWarnings('not json\n{also not json'), []);
  assert.deepEqual(parseRayhunterWarnings(undefined), []);
});
