import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrameAncestors, embedFramingPlugin } from '../../build/embed-framing.js';

const quiet = () => {};

test('frame-ancestors lists may be space- or comma-separated', () => {
  const spaced = parseFrameAncestors('http://127.0.0.1:4187 https://app.example.com', { warn: quiet });
  const commas = parseFrameAncestors('http://127.0.0.1:4187,https://app.example.com', { warn: quiet });
  const mixed = parseFrameAncestors(' http://127.0.0.1:4187 , https://app.example.com/ ', { warn: quiet });
  const expected = { anywhere: false, sources: ['http://127.0.0.1:4187', 'https://app.example.com'] };
  assert.deepEqual(spaced, expected);
  assert.deepEqual(commas, expected);
  assert.deepEqual(mixed, expected);
});

test('keywords gain quotes, wildcards and schemes are kept, duplicates collapse', () => {
  assert.deepEqual(parseFrameAncestors("self, https://*.example.com:*, https:, 'self'", { warn: quiet }), {
    anywhere: false,
    sources: ["'self'", 'https://*.example.com:*', 'https:'],
  });
  assert.deepEqual(parseFrameAncestors('*', { warn: quiet }), { anywhere: true, sources: [] });
});

test('anything that is not a CSP source is dropped with a warning, never injected', () => {
  const warnings = [];
  const injected = parseFrameAncestors('https://ok.example; script-src *', { warn: (m) => warnings.push(m) });
  assert.deepEqual(injected, { anywhere: false, sources: [] });
  const parsed = parseFrameAncestors("https://a.example/path, 'unsafe-inline', * https://ok.example", {
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(parsed, { anywhere: false, sources: ['https://ok.example'] });
  assert.equal(warnings.length, 4);
  // Nothing valid: the plugin keeps the server's default framing protection.
  assert.equal(embedFramingPlugin({ ancestors: 'https://a.example/path', warn: quiet }).configureServer, undefined);
});

test("'none' alone wins over other sources", () => {
  const warnings = [];
  assert.deepEqual(parseFrameAncestors("none https://a.example", { warn: (m) => warnings.push(m) }), {
    anywhere: false,
    sources: ["'none'"],
  });
  assert.equal(warnings.length, 1);
});

test('a comma list produces a valid header on embed documents', () => {
  const plugin = embedFramingPlugin({ ancestors: 'http://localhost:4187,https://app.example.com', warn: quiet });
  const headers = {};
  let handler;
  plugin.configureServer({ middlewares: { use: (fn) => (handler = fn) } });
  const res = { setHeader: (k, v) => (headers[k.toLowerCase()] = v) };
  handler({ url: '/?embed=1' }, res, () => {});
  assert.equal(headers['content-security-policy'], 'frame-ancestors http://localhost:4187 https://app.example.com');
});
