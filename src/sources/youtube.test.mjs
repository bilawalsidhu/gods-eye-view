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

test('Twitch channels normalize without trusting a supplied parent or playback parameters', () => {
  const expected =
    'https://player.twitch.tv/?channel=tucumanturismo02&autoplay=false&muted=true';
  for (const input of [
    'https://www.twitch.tv/tucumanturismo02',
    'https://twitch.tv/TucumanTurismo02/',
    'https://player.twitch.tv/?channel=tucumanturismo02&parent=evil.test&autoplay=true&muted=false',
    expected,
  ])
    assert.equal(normalizeCctvEmbedUrl(input), expected);
  assert.equal(
    normalizeSourceItem({ id: 'twitch', feedType: 'embed', embedUrl: expected })
      .embedUrl,
    expected,
  );
  for (const input of [
    'http://www.twitch.tv/tucumanturismo02',
    'https://user:password@www.twitch.tv/tucumanturismo02',
    'https://player.twitch.tv:8443/?channel=tucumanturismo02',
    'https://player.twitch.tv.evil.test/?channel=tucumanturismo02',
    'https://player.twitch.tv/?channel=a&channel=b',
    'https://player.twitch.tv/?video=v1234',
    'https://player.twitch.tv/?channel=a%26parent%3Devil.test',
    'https://www.twitch.tv/videos/1234',
    'https://www.twitch.tv/a/extra',
    `https://www.twitch.tv/${'a'.repeat(26)}`,
  ])
    assert.equal(normalizeCctvEmbedUrl(input), '', input);
});

test('public panorama and Angelcam players use bounded provider URL forms', () => {
  for (const [input, expected] of [
    [
      'https://v.angelcam.com/iframe?v=j3r74nbxrm&autoplay=1&token=discard',
      'https://v.angelcam.com/iframe?v=j3r74nbxrm&autoplay=1&mute=1',
    ],
    [
      'https://finca-la-anita-mendoza.roundshot.com/?debug=true',
      'https://finca-la-anita-mendoza.roundshot.com/',
    ],
  ]) {
    assert.equal(normalizeCctvEmbedUrl(input), expected);
    assert.equal(normalizeCctvEmbedUrl(expected), expected);
  }
  for (const input of [
    'https://v.angelcam.com/iframe?v=j3r74nbxrm&v=40yem868r5',
    'https://v.angelcam.com/iframe?v=invalid',
    'https://v.angelcam.com/other?v=j3r74nbxrm',
    'https://v.angelcam.com.evil.test/iframe?v=j3r74nbxrm',
    'https://user:password@finca-la-anita-mendoza.roundshot.com/',
    'https://finca-la-anita-mendoza.roundshot.com:8443/',
    'https://finca-la-anita-mendoza.roundshot.com.evil.test/',
    'https://finca-la-anita-mendoza.roundshot.com/other',
    'https://roundshot.com/',
  ])
    assert.equal(normalizeCctvEmbedUrl(input), '', input);
});
