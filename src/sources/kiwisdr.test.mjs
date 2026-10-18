import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKiwiDirectoryScript,
  parseKiwiGps,
  parseKiwiOrigin,
  normalizeKiwiStation,
  normalizeKiwiDirectory,
  kiwiLoad,
} from './kiwisdr.js';

// Shape taken from a real rx.linkfanel.net/kiwisdr_com.js response.
const row = (over = {}) => ({
  updated: 'Thursday, 15-Oct-2026 20:05:15 GMT',
  id: '98f07bffccc3',
  status: 'active',
  offline: 'no',
  name: '80m Dipole | Chichester UK',
  sdr_hw: 'KiwiSDR 1 v1.902 ⁣ 📡 GPS ⁣ ⏳ Limits',
  bands: '0-30000000',
  users: '5',
  users_max: '8',
  gps: '(50.85, -0.66)',
  grid: 'IO90QU',
  loc: 'Chichester UK',
  antenna: '80m Dipole',
  snr: '45,46',
  url: 'http://g8ure.ddns.net:8075',
  ...over,
});

test('parses the var-wrapped directory script', () => {
  const script = `// header\n// more\n\nvar kiwisdr_com =\n[\n${JSON.stringify(row())},\n${JSON.stringify(row({ id: 'f82e0c015d32' }))}\n]\n;\n`;
  assert.equal(parseKiwiDirectoryScript(script).length, 2);
  assert.throws(() => parseKiwiDirectoryScript('nope'));
  assert.throws(() => parseKiwiDirectoryScript('var x = [ {broken ]'));
});

test('one malformed row costs one row, not the whole directory', () => {
  const pretty = (r) =>
    '{\n' +
    Object.entries(r)
      .map(([k, v]) => `"${k}":"${v}"`)
      .join(',\n') +
    '\n}';
  const good1 = pretty(row({ id: 'aaaa11110001' }));
  const good2 = pretty(row({ id: 'aaaa11110002' }));
  // A stray quote inside a value: not valid JSON.
  const badQuote = pretty(
    row({ id: 'bbbb22220001', name: 'Dave "G4XYZ" shack' }),
  );
  // A raw tab inside a value: not valid JSON either.
  const badTab = pretty(row({ id: 'cccc33330001', antenna: 'long\twire' }));
  // A trailing comma before the closing brace.
  const trailing = pretty(row({ id: 'dddd44440001' })).replace(/\n}$/, ',\n}');
  const script = `// header\nvar kiwisdr_com =\n[\n${[good1, badQuote, good2, badTab, trailing].join(',\n')},\n]\n;\n`;
  assert.throws(() =>
    JSON.parse(script.slice(script.indexOf('['), script.lastIndexOf(']') + 1)),
  );
  const rows = parseKiwiDirectoryScript(script);
  const ids = rows.map((r) => r.id);
  assert.ok(
    ids.includes('aaaa11110001') && ids.includes('aaaa11110002'),
    ids.join(),
  );
  assert.ok(ids.includes('cccc33330001'), 'a tab is cleaned, not fatal');
  assert.ok(ids.includes('dddd44440001'), 'a trailing comma is tolerated');
  assert.ok(
    !ids.includes('bbbb22220001'),
    'the unparseable row alone is dropped',
  );
  assert.equal(normalizeKiwiDirectory(rows).length, 4);
  // Nothing salvageable is still an error.
  assert.throws(() => parseKiwiDirectoryScript('var x = [ "a", {"b": ] ;'));
});

test('normalizes a real-shaped row', () => {
  const s = normalizeKiwiStation(row());
  assert.equal(s.id, '98f07bffccc3');
  assert.equal(s.lat, 50.85);
  assert.equal(s.lon, -0.66);
  assert.equal(s.users, 5);
  assert.equal(s.usersMax, 8);
  assert.equal(s.origin, 'http://g8ure.ddns.net:8075');
  assert.equal(s.port, 8075);
  assert.equal(s.hardware, 'KiwiSDR 1 v1.902');
  assert.equal(s.highHz, 30_000_000);
  assert.equal(s.snr, 46);
});

test('rejects unusable rows', () => {
  assert.equal(normalizeKiwiStation(row({ status: 'offline' })), null);
  assert.equal(normalizeKiwiStation(row({ offline: 'yes' })), null);
  assert.equal(normalizeKiwiStation(row({ gps: '(0, 0)' })), null);
  assert.equal(normalizeKiwiStation(row({ gps: '(91, 0)' })), null);
  assert.equal(normalizeKiwiStation(row({ gps: 'garbage' })), null);
  assert.equal(normalizeKiwiStation(row({ users_max: '0' })), null);
  assert.equal(normalizeKiwiStation(row({ id: '../x' })), null);
  assert.equal(normalizeKiwiStation(null), null);
});

test('refuses origins that could aim the browser at a LAN or odd scheme', () => {
  for (const bad of [
    'http://192.168.1.5:8073',
    'http://10.0.0.2:8073',
    'http://127.0.0.1:8073',
    'http://localhost:8073',
    'http://user:pw@example.com:8073',
    'ftp://example.com',
    'javascript:alert(1)',
    'http://intranet:8073',
  ])
    assert.equal(parseKiwiOrigin(bad), null, bad);
  assert.equal(parseKiwiOrigin('http://example.com').port, 80);
  assert.equal(
    parseKiwiOrigin('https://example.com/path?x=1').origin,
    'https://example.com',
  );
});

test('dedupes by id and caps', () => {
  const out = normalizeKiwiDirectory([
    row(),
    row(),
    row({ id: 'aaaaaaaa1111' }),
  ]);
  assert.equal(out.length, 2);
});

test('gps parser', () => {
  assert.deepEqual(parseKiwiGps('(-33.9, 151.2)'), { lat: -33.9, lon: 151.2 });
  assert.equal(parseKiwiGps(undefined), null);
});

test('load buckets', () => {
  const s = (users, usersMax) => ({ users, usersMax });
  assert.equal(kiwiLoad(s(0, 4)), 'free');
  assert.equal(kiwiLoad(s(1, 4)), 'free');
  assert.equal(kiwiLoad(s(2, 4)), 'busy');
  assert.equal(kiwiLoad(s(4, 4)), 'full');
});
