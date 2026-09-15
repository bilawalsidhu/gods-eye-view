import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockText,
  escapeText,
  formatHectares,
  referencesHtml,
  replayFraction,
  rosterHtml,
  timelineChartSvg,
} from './panel.js';

test('escapeText neutralizes markup from config or feed values', () => {
  assert.equal(escapeText('<b x="1">&\'</b>'), '&lt;b x=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
  assert.equal(escapeText(null), '');
});

test('rosterHtml marks the selected event and escapes names', () => {
  const html = rosterHtml(
    [
      { id: 'a', name: 'Camp <Fire>', region: 'Butte', startDate: '2018-11-08', endDate: '2018-11-25' },
      { id: 'b', name: 'Other', startDate: '2024-01-01', endDate: '2024-01-02' },
    ],
    'b',
  );
  assert.equal((html.match(/fire-history-roster-item/g) || []).length, 2);
  assert.match(html, /data-event-id="b"[^>]*aria-pressed="true"/);
  assert.match(html, /data-event-id="a"[^>]*aria-pressed="false"/);
  assert.match(html, /CAMP &lt;FIRE&gt; · 2018/);
  assert.match(html, /REGION UNAVAILABLE/);
  assert.match(rosterHtml([], null), /NO REGISTERED EVENTS/);
});

test('formatHectares', () => {
  assert.equal(formatHectares(62053), '62,053 HA');
  assert.equal(formatHectares(null), 'UNAVAILABLE');
  assert.equal(formatHectares(0), 'UNAVAILABLE');
});

test('timelineChartSvg draws one bar per day and a cursor only when engaged', () => {
  const timeline = [
    { date: '2018-11-08', count: 10, maxFrp: 5 },
    { date: '2018-11-09', count: 0, maxFrp: 0 },
    { date: '2018-11-10', count: 5, maxFrp: 9 },
  ];
  const svg = timelineChartSvg(timeline, null);
  assert.equal((svg.match(/<rect /g) || []).length, 3);
  assert.doesNotMatch(svg, /fire-history-chart-cursor/);
  assert.match(svg, /2018-11-08 to 2018-11-10/);
  const withCursor = timelineChartSvg(timeline, 0.5);
  assert.match(withCursor, /fire-history-chart-cursor" x1="150.00"/);
  // Zero-count day has zero height, peak day fills the chart.
  assert.match(svg, /height="0.00"/);
  assert.match(svg, /height="54.00"/);
  assert.match(timelineChartSvg([], null), /NO DAILY DATA/);
});

test('referencesHtml appends the NIFC link only when a perimeter is loaded', () => {
  assert.match(referencesHtml([], { label: 'WFIGS Interagency Perimeters' }), /NIFC Open Data/);
  assert.doesNotMatch(referencesHtml([], null), /NIFC/);
});

test('referencesHtml keeps https links only', () => {
  const html = referencesHtml([
    { label: 'CAL FIRE', url: 'https://www.fire.ca.gov/x' },
    { label: 'bad', url: 'javascript:alert(1)' },
  ]);
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(referencesHtml([]), /NO LINKED DOCUMENTS/);
});

test('replayFraction and clockText follow the clock', () => {
  const base = { startMs: 0, endMs: 1000, cursorMs: 250, shown: 12, active: 3, speed: 1 };
  assert.equal(replayFraction({ ...base, status: 'playing' }), 0.25);
  assert.equal(replayFraction(null), 0);
  assert.equal(clockText(null), 'LOAD AN EVENT TO REPLAY ITS SPREAD');
  assert.equal(
    clockText({ ...base, status: 'idle' }, { startDate: 'a', endDate: 'b' }),
    'STATIC · ALL DETECTIONS a → b',
  );
  assert.equal(
    clockText({ ...base, status: 'playing' }),
    'PLAYING · 1970-01-01 00:00Z · 12 SHOWN · 3 BURNING',
  );
  assert.match(clockText({ ...base, status: 'ended' }), /^END ·/);
});
