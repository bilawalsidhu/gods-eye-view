import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateText, localizeUiText } from './localize.js';

const zh = (text) => translateText(text, 'zh-TW');

test('exact and upper-case lookups translate', () => {
  assert.equal(zh('DATA LAYERS'), '資料圖層');
  assert.equal(zh('Live Flights'), '即時航班');
  assert.equal(zh('LIVE FLIGHTS'), '即時航班');
});

test('surrounding whitespace survives translation', () => {
  assert.equal(zh('  CCTV OFF \n'), '  監視器 關 \n');
});

test('unknown strings, data, and icon-like lowercase words pass through', () => {
  assert.equal(zh('Shibuya Crossing'), 'Shibuya Crossing');
  assert.equal(zh('close'), 'close');
  assert.equal(zh('12:30'), '12:30');
});

test('runtime-composed labels translate by pattern', () => {
  assert.equal(zh('Live Flights: OFF'), '即時航班:關');
  assert.equal(zh('Expand DATA LAYERS'), '展開資料圖層');
  assert.equal(zh('LIVE · OK'), '即時 · 正常');
  assert.equal(zh('POWER UP · 8 KEYS WAITING'), '強化功能 · 8 組金鑰待設定');
  assert.equal(zh('HDG 346°'), '方位 346°');
});

test('segment vocabulary never translates a standalone word', () => {
  // The Cesium error dialog's "OK" button is not a status.
  assert.equal(zh('OK'), 'OK');
});

test('English is the identity locale', () => {
  assert.equal(translateText('DATA LAYERS', 'en'), 'DATA LAYERS');
  assert.equal(localizeUiText('DATA LAYERS'), 'DATA LAYERS');
});
