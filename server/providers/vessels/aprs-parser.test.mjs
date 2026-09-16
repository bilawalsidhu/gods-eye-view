import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAprsLine, parseAprsTelemetry } from './aprs-parser.js';

test('parses all APRS position forms and maritime symbols', () => {
  const forms = ['!', '=', '/', '@'];
  for (const form of forms) {
    const row = parseAprsLine(`CALL>APRS:${form}123456z4903.50N/07201.75Ws`);
    assert.equal(row?.lat.toFixed(4), '49.0583');
    assert.equal(row?.lon.toFixed(4), '-72.0292');
  }
  assert.ok(parseAprsLine('SHIP>APRS:!4903.50N/07201.75Ws'));
  assert.ok(parseAprsLine('SHIP>APRS:!4903.50N\\07201.75Ws'));
  assert.ok(parseAprsLine('SHIP>APRS:!4903.50N/07201.75W>'));
  assert.ok(parseAprsLine('SHIP>APRS:!4903.50N/07201.75WY'));
  assert.equal(parseAprsLine('WX>APRS:!4903.50N/07201.75WcRain'), null);
  assert.equal(parseAprsLine('LAND>APRS:!not-a-position'), null);
});

test('rejects malformed AIS and preserves NMEA sentence framing', () => {
  assert.equal(parseAprsLine('!AIVDM,2,3,1,A,15,0*hh'), null);
  assert.equal(parseAprsLine('!AIVDM,1,1,,A,*hh'), null);
});

/**
 * Independent AIS encoder written from the ITU-R M.1371 bit layout. Encoding
 * here (rather than importing a fixture) means the decode test fails if the
 * parser's bit offsets drift from the specification.
 */
function encodeAis({ type, mmsi, lat, lon, course, speed }) {
  const bits = new Array(168).fill(0);
  const put = (value, start, width) => {
    const v = value < 0 ? value + 2 ** width : value;
    for (let i = 0; i < width; i += 1)
      bits[start + i] = (v >> (width - 1 - i)) & 1;
  };
  put(type, 0, 6);
  put(mmsi, 8, 30);
  if (type === 18) {
    put(Math.round(speed * 10), 46, 10);
    put(Math.round(lon * 600000), 57, 28);
    put(Math.round(lat * 600000), 85, 27);
    put(Math.round(course * 10), 112, 12);
  } else {
    put(Math.round(speed * 10), 50, 10);
    put(Math.round(lon * 600000), 61, 28);
    put(Math.round(lat * 600000), 89, 27);
    put(Math.round(course * 10), 116, 12);
  }
  while (bits.length % 6) bits.push(0);
  let payload = '';
  for (let i = 0; i < bits.length; i += 6) {
    let n = 0;
    for (let j = 0; j < 6; j += 1) n = (n << 1) | bits[i + j];
    let code = n + 48;
    if (code > 87) code += 8;
    payload += String.fromCharCode(code);
  }
  const body = `AIVDM,1,1,,A,${payload},0`;
  let sum = 0;
  for (const ch of body) sum ^= ch.charCodeAt(0);
  return `!${body}*${(sum & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}

test('decodes Class A and Class B AIS position reports at the spec bit offsets', () => {
  const classA = parseAprsLine(
    encodeAis({
      type: 1,
      mmsi: 367533950,
      lat: 37.802333,
      lon: -122.345833,
      course: 45,
      speed: 12.3,
    }),
  );
  assert.equal(classA.mmsi, '367533950');
  assert.ok(Math.abs(classA.lat - 37.802333) < 1e-4);
  assert.ok(Math.abs(classA.lon - -122.345833) < 1e-4);
  assert.ok(Math.abs(classA.course - 45) < 0.11);
  assert.ok(Math.abs(classA.speed - 12.3) < 0.11);
  assert.equal(classA.metadata.aisType, 1);
  assert.equal(classA.reference, 'mmsi:367533950');

  const classB = parseAprsLine(
    encodeAis({
      type: 18,
      mmsi: 123456789,
      lat: -20.25,
      lon: 10.5,
      course: 200.5,
      speed: 5,
    }),
  );
  assert.equal(classB.mmsi, '123456789');
  assert.ok(Math.abs(classB.lat - -20.25) < 1e-4);
  assert.ok(Math.abs(classB.lon - 10.5) < 1e-4);
  assert.ok(Math.abs(classB.course - 200.5) < 0.11);
  assert.ok(Math.abs(classB.speed - 5) < 0.11);
  assert.equal(classB.metadata.aisType, 18);
});

test('parses APRS telemetry and rejects malformed reports', () => {
  const telemetry = parseAprsTelemetry(
    'SHIP>APRS,TCPIP*:T#042,100,200,50,0,255,10101010',
    1_700_000_000_000,
  );
  assert.equal(telemetry.reference, 'aprs:SHIP');
  assert.equal(telemetry.callsign, 'SHIP');
  assert.equal(telemetry.sequence, 42);
  assert.deepEqual(telemetry.analog, [100, 200, 50, 0, 255]);
  assert.equal(telemetry.digitalBits, '10101010');
  assert.equal(telemetry.observedAtMs, 1_700_000_000_000);

  assert.equal(parseAprsTelemetry('SHIP>APRS:T#042,100,200,50,0'), null);
  assert.equal(
    parseAprsTelemetry('SHIP>APRS:T#04x,100,200,50,0,255,10101010'),
    null,
  );
  assert.equal(
    parseAprsTelemetry('SHIP>APRS:T#042,100,200,50,0,255,1012'),
    null,
  );
  assert.equal(parseAprsTelemetry('SHIP>APRS:!4903.50N/07201.75Ws'), null);
});

test('finds an AIVDM sentence inside an APRS-IS wrapper line', () => {
  const sentence = encodeAis({
    type: 1,
    mmsi: 111111111,
    lat: 1.5,
    lon: 2.5,
    course: 10,
    speed: 1,
  });
  const wrapped = parseAprsLine(`STATION>APRS,TCPIP*:${sentence}`);
  assert.equal(wrapped.mmsi, '111111111');
  assert.ok(Math.abs(wrapped.lat - 1.5) < 1e-4);
  assert.ok(Math.abs(wrapped.lon - 2.5) < 1e-4);
});
