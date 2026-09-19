import test from 'node:test';
import assert from 'node:assert/strict';
import { translateTraditionalChinese } from './zh-TW.js';

test('translates fixed interface labels into Traditional Chinese', () => {
  assert.equal(translateTraditionalChinese('DATA LAYERS'), '資料圖層');
  assert.equal(translateTraditionalChinese('Choose your first view'), '選擇第一個視角');
  assert.equal(translateTraditionalChinese('SAVE KEYS'), '儲存金鑰');
});

test('translates dynamic interface messages without changing their values', () => {
  assert.equal(translateTraditionalChinese('Location: Taipei'), '位置：Taipei');
  assert.equal(translateTraditionalChinese('Error: network unavailable'), '錯誤：network unavailable');
  assert.equal(
    translateTraditionalChinese('POWER UP · 8 KEYS WAITING'),
    '擴充功能 · 尚有 8 組金鑰未設定',
  );
});

test('leaves provider names and unknown live data unchanged', () => {
  assert.equal(translateTraditionalChinese('OpenSky'), 'OpenSky');
  assert.equal(translateTraditionalChinese('B-18701'), 'B-18701');
});