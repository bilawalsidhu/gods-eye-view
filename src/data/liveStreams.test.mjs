// src/data/liveStreams.test.mjs — the fixed list of live streams and how a
// selected object's keys pick from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_STREAMS,
  YOUTUBE_EMBED_HOST,
  liveStreamsFor,
  youtubeLivePlayerVars,
  youtubeWatchUrl,
} from './liveStreams.js';

test('every listed stream is a complete YouTube entry with a distinct id', () => {
  assert.ok(LIVE_STREAMS.length >= 2, 'the ISS has two streams');
  const ids = new Set(LIVE_STREAMS.map((stream) => stream.id));
  assert.equal(ids.size, LIVE_STREAMS.length);
  for (const stream of LIVE_STREAMS) {
    assert.equal(stream.platform, 'youtube');
    assert.match(stream.videoId, /^[\w-]{11}$/, `${stream.id} video id`);
    assert.ok(stream.title.length > 0);
    assert.ok(stream.owner.length > 0);
    assert.match(stream.ownerUrl, /^https:\/\/www\.youtube\.com\//);
    assert.ok(stream.subjects.length > 0, `${stream.id} names a subject`);
    assert.ok(Object.isFrozen(stream), 'entries cannot be edited at run time');
  }
});

test('the ISS streams attach to the station key, in list order', () => {
  const found = liveStreamsFor(['station:iss']);
  assert.deepEqual(
    found.map((stream) => stream.id),
    ['iss-exterior', 'iss-crew'],
  );
});

test('a key no stream names, or no keys at all, finds nothing', () => {
  assert.deepEqual(liveStreamsFor(['satellites:25544']), []);
  assert.deepEqual(liveStreamsFor([]), []);
  assert.deepEqual(liveStreamsFor(null), []);
  assert.deepEqual(liveStreamsFor(undefined), []);
});

test('a subject known by several keys gets the union, each stream once', () => {
  const streams = [
    { id: 'a', subjects: ['x'] },
    { id: 'b', subjects: ['y', 'x'] },
    { id: 'c', subjects: ['z'] },
  ];
  assert.deepEqual(
    liveStreamsFor(new Set(['x', 'y']), streams).map((s) => s.id),
    ['a', 'b'],
  );
});

test('the watch link is the video page on YouTube proper', () => {
  assert.equal(
    youtubeWatchUrl('ROboUHfPUrU'),
    'https://www.youtube.com/watch?v=ROboUHfPUrU',
  );
  assert.equal(
    youtubeWatchUrl('a b&c'),
    'https://www.youtube.com/watch?v=a%20b%26c',
  );
});

test('the player is created on the privacy-enhanced host, muted, with the API on', () => {
  assert.equal(YOUTUBE_EMBED_HOST, 'https://www.youtube-nocookie.com');
  const vars = youtubeLivePlayerVars('http://localhost:5190');
  assert.equal(vars.autoplay, 1);
  assert.equal(vars.mute, 1);
  assert.equal(vars.playsinline, 1);
  assert.equal(vars.rel, 0);
  assert.equal(vars.enablejsapi, 1);
  assert.equal(vars.origin, 'http://localhost:5190');
  assert.equal(
    'origin' in youtubeLivePlayerVars(undefined),
    false,
    'no origin is passed when the page has none',
  );
});
