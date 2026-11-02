import test from 'node:test';
import assert from 'node:assert/strict';
import { createWellDataUrlResolver as resolver } from './dataBase.mjs';

test('same-origin default and versioned local bases remain supported', () => {
  assert.equal(
    resolver()('index.json'),
    'https://gev.invalid/well-index-v1/index.json',
  );
  const url = resolver(
    '/well-index-usgwd/releases/root_001/',
    [],
    'http://localhost:5173',
  );
  assert.equal(
    url('states/Rhode_Island/abc.index.json'),
    'http://localhost:5173/well-index-usgwd/releases/root_001/states/Rhode_Island/abc.index.json',
  );
});

test('HTTPS remote base requires an exact explicit origin, including port', () => {
  const base = 'https://data.example.test/wells/releases/root-001/';
  assert.throws(() => resolver(base), /Invalid well data/);
  assert.throws(
    () => resolver(base, ['https://data.example.test:8443']),
    /Invalid well data/,
  );
  const url = resolver(base, ['https://data.example.test']);
  assert.equal(url('abc.counts.json'), base + 'abc.counts.json');
});

test('noncanonical, credential-bearing, query, fragment and insecure bases fail closed', () => {
  for (const base of [
    '//data.example.test/wells/',
    'http://data.example.test/wells/',
    'https://' + ['user:password', 'data.example.test'].join('@') + '/wells/',
    'https://data.example.test/wells/?token=synthetic',
    'https://data.example.test/wells/#fragment',
    'https://data.example.test/wells/?',
    'https://data.example.test/wells/#',
    'https://data.example.test/wells/../elsewhere/',
    'https://data.example.test/wells/%2e%2e/',
    'https://data.example.test/wells\\elsewhere/',
    'https://data.example.test.evil.test/wells/',
    'https://DATA.example.test/wells/',
    '/wells/../elsewhere/',
    '/wells//',
    '/wells',
    '/wells/?',
    '/wells/%2f/',
    '/wells/#fragment',
    '/wells/\n',
    '',
    null,
  ])
    assert.throws(
      () => resolver(base, ['https://data.example.test']),
      /Invalid well data/,
    );
  for (const allowed of [
    null,
    '*',
    ['*'],
    ['http://data.example.test'],
    ['https://data.example.test/'],
    ['https://' + ['user', 'data.example.test'].join('@')],
    Array(9).fill('https://data.example.test'),
  ])
    assert.throws(() => resolver('/wells/', allowed), /Invalid well data/);
  assert.throws(
    () => resolver('/wells/', [], 'file:///tmp/'),
    /Invalid well data/,
  );
});

test('manifest references cannot escape the data directory or add URL parameters', () => {
  const url = resolver('https://data.example.test/wells/v1/', [
    'https://data.example.test',
  ]);
  for (const path of [
    '../index.json',
    '/index.json',
    '//evil.test/index.json',
    'https://evil.test/index.json',
    'states/../index.json',
    'states//index.json',
    'states\\index.json',
    'states/%2e%2e/index.json',
    'index.json?token=x',
    'index.json#x',
    'index.json\n',
    'index.json/extra',
    '',
    null,
    'x'.repeat(2049),
  ])
    assert.throws(() => url(path), /Invalid well artifact/);
});
