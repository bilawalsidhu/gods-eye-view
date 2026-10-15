import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { youtubeVideoId } from './youtube.js';
import { normalizeCctvEmbedUrl } from './cctvTypes.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

const id = 'r8Busmkpsh8';
const player = `https://www.youtube-nocookie.com/embed/${id}?playsinline=1`;

test('public YouTube URL forms share a canonical player without caller parameters', () => {
  for (const value of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=unrelated&t=120&autoplay=1`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=tracking`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube.com/shorts/${id}/`,
    `https://www.youtube.com/embed/${id}?origin=https://evil.test&controls=0`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://youtube-nocookie.com/embed/${id}/`,
    player,
  ]) {
    assert.equal(youtubeVideoId(new URL(value)), id, value);
    assert.equal(normalizeCctvEmbedUrl(value), player, value);
  }
  assert.equal(normalizeCctvEmbedUrl(player), player);
});

test('YouTube inputs reject credentials, alternate ports, lookalike hosts and missing video IDs', () => {
  for (const value of [
    `http://www.youtube.com/watch?v=${id}`,
    `https://user:secret@www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com:8443/watch?v=${id}`,
    `https://www.youtube.com.evil.test/watch?v=${id}`,
    `https://www.youtube.com@evil.test/watch?v=${id}`,
    `https://www.youtu.be/${id}`,
    `https://youtu.be/${id}/extra`,
    `https://www.youtube.com/watch?v=${id}&v=abcdefghijk`,
    'https://www.youtube.com/watch?v=too-short',
    'https://www.youtube.com/watch?v=abcdefghij%2F',
    'https://www.youtube.com/playlist?list=PL1234',
    'https://www.youtube.com/@UADEoficial/live',
    'https://www.youtube.com/embed/live_stream?channel=UC1234',
    'https://www.youtube.com/embed/live_stream/?channel=UC1234',
    `https://www.youtube.com/embed/${id}%2F`,
  ]) {
    assert.equal(youtubeVideoId(new URL(value)), null, value);
    assert.equal(normalizeCctvEmbedUrl(value), '', value);
  }
  for (const value of [
    null,
    123,
    ` ${player}`,
    `${player}\n`,
    `https://www.you\ttube.com/watch?v=${id}`,
    `https:\\\\www.youtube.com\\embed\\${id}`,
    `//www.youtube.com/embed/${id}`,
    `<iframe src="${player}"></iframe>`,
    'javascript:alert(1)',
    `${player}&unused=${'a'.repeat(4096)}`,
  ])
    assert.equal(normalizeCctvEmbedUrl(value), '', String(value));
});

test('Argentine example catalog has attributed players and approximate locations, without raw media', () => {
  const examples = JSON.parse(
    readFileSync(
      new URL('../../config/cctv_sources.youtube.json', import.meta.url),
    ),
  );
  assert.equal(examples.length, 2);
  assert.equal(
    new Set(examples.map((camera) => camera.id)).size,
    examples.length,
  );
  for (const camera of examples) {
    const source = normalizeSourceItem(camera);
    assert.equal(source.feedType, 'embed');
    assert.match(
      source.embedUrl,
      /^https:\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{11}\?playsinline=1$/,
    );
    assert.match(source.sourcePageUrl, /^https:\/\//);
    assert.ok(source.provider && source.credit && source.license);
    assert.match(source.locationNote, /Approximate.*unverified/);
    assert.equal(Number.isFinite(source.headingDeg), false);
    assert.equal(source.url, '');
    assert.equal(source.snapshotUrl, '');
    assert.ok(source.lat >= -90 && source.lat <= 90);
    assert.ok(source.lon >= -180 && source.lon <= 180);
  }
});
