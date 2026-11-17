// The CCTV summary line names the CAL badge, the source kind and the view
// band in the page language; unknown codes stay as uppercase codes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import {
  summaryCalLabel,
  summarySourceLabel,
  summaryViewBandLabel,
} from './presentation.js';

function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}

test('English keeps the summary codes', () => {
  assert.equal(summaryCalLabel('raw-prior'), 'RAW PRIOR');
  assert.equal(summarySourceLabel('image'), 'IMAGE');
  assert.equal(summarySourceLabel('hls'), 'HLS');
  assert.equal(summaryViewBandLabel('street'), 'STREET');
  assert.equal(summaryViewBandLabel('none'), 'NONE');
});

test('Portuguese summary values are translated', () => {
  inLocale('pt', () => {
    assert.equal(summaryCalLabel('raw-prior'), 'ESTIMATIVA BRUTA');
    assert.equal(summaryCalLabel('calibrated'), 'CALIBRADA');
    assert.equal(summarySourceLabel('IMAGE'), 'IMAGEM');
    assert.equal(summarySourceLabel('mjpeg'), 'MJPEG');
    assert.equal(summaryViewBandLabel('street'), 'RUA');
    assert.equal(summaryViewBandLabel('city'), 'CIDADE');
  });
});
