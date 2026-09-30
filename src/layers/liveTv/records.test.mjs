import assert from 'node:assert/strict';
import test from 'node:test';
import { LIVE_TV_COUNTRY_ANCHORS } from './anchors.js';
import {
  LIVE_TV_MAX_STREAMS_PER_CHANNEL,
  buildLiveTvIndex,
  isLiveTvCountryCode,
  isPlayableStreamUrl,
  sanitizeLiveTvChannels,
  sanitizeLiveTvCountries,
} from './records.js';

const channel = (id, country, extra = {}) => ({
  id,
  name: id.split('.')[0],
  country,
  categories: ['news'],
  is_nsfw: false,
  closed: null,
  ...extra,
});
const stream = (channelId, url, extra = {}) => ({
  channel: channelId,
  feed: null,
  title: channelId,
  url,
  quality: '720p',
  labels: [],
  user_agent: null,
  referrer: null,
  ...extra,
});

test('stream URLs must be direct http(s) HLS playlists on non-platform hosts', () => {
  for (const url of [
    'https://example.tv/live/index.m3u8',
    'http://203.0.113.9:8080/hls/main.M3U8?token=abc',
  ])
    assert.equal(isPlayableStreamUrl(url), true, url);
  for (const url of [
    'https://example.tv/live/stream.mpd',
    'https://example.tv/live',
    'rtmp://example.tv/live/index.m3u8',
    'https://user:secret@example.tv/live/index.m3u8',
    'https://www.youtube.com/live/index.m3u8',
    'https://m.twitch.tv/x/index.m3u8',
    `https://example.tv/${'a'.repeat(2048)}.m3u8`,
    'not a url',
    null,
  ])
    assert.equal(isPlayableStreamUrl(url), false, String(url));
});

test('the index drops blocklisted, NSFW and closed channels and unplayable streams', () => {
  const index = buildLiveTvIndex({
    channels: [
      channel('Good.uk', 'UK'),
      channel('Second.uk', 'UK', { categories: ['general', 'kids'] }),
      channel('Blocked.us', 'US'),
      channel('Adult.us', 'US', { is_nsfw: true }),
      channel('Gone.us', 'US', { closed: '2024-01-01' }),
      channel('Agent.fr', 'FR'),
      channel('Nowhere.zz', 'ZZ'),
      channel('bad id with spaces', 'FR'),
    ],
    streams: [
      stream('Good.uk', 'https://a.example/good.m3u8', {
        labels: ['Geo-blocked', 'Unknown label'],
      }),
      stream('Good.uk', 'https://a.example/good.m3u8'),
      stream('Good.uk', 'https://b.example/good.m3u8', { quality: '1080p' }),
      stream('Second.uk', 'https://c.example/second.mpd'),
      stream('Second.uk', 'https://c.example/second.m3u8'),
      stream('Blocked.us', 'https://d.example/blocked.m3u8'),
      stream('Adult.us', 'https://e.example/adult.m3u8'),
      stream('Gone.us', 'https://f.example/gone.m3u8'),
      stream('Agent.fr', 'https://g.example/agent.m3u8', {
        user_agent: 'Mozilla/5.0 Special',
      }),
      stream('Agent.fr', 'https://g.example/ref.m3u8', {
        referrer: 'https://g.example/',
      }),
      stream('Nowhere.zz', 'https://h.example/zz.m3u8'),
      stream(null, 'https://i.example/orphan.m3u8'),
    ],
    blocklist: [{ channel: 'Blocked.us', reason: 'dmca' }],
    countries: [{ code: 'UK', name: 'United Kingdom' }],
  });
  assert.deepEqual(index.countries, [
    {
      code: 'UK',
      name: 'United Kingdom',
      lon: LIVE_TV_COUNTRY_ANCHORS.UK[0],
      lat: LIVE_TV_COUNTRY_ANCHORS.UK[1],
      channels: 2,
    },
  ]);
  assert.deepEqual(index.channelsByCountry.get('UK'), [
    {
      id: 'Good.uk',
      name: 'Good',
      categories: ['news'],
      streams: [
        {
          url: 'https://a.example/good.m3u8',
          quality: '720p',
          labels: ['Geo-blocked'],
        },
        { url: 'https://b.example/good.m3u8', quality: '1080p', labels: [] },
      ],
    },
    {
      id: 'Second.uk',
      name: 'Second',
      categories: ['general', 'kids'],
      streams: [
        { url: 'https://c.example/second.m3u8', quality: '720p', labels: [] },
      ],
    },
  ]);
  assert.equal(index.channelsByCountry.has('US'), false);
  assert.equal(index.channelsByCountry.has('ZZ'), false);
  // Totals count every playable channel, including the unplaced ZZ one.
  assert.deepEqual(index.totals, {
    channels: 3,
    streams: 4,
    excluded: { blocklist: 1, nsfw: 1, closed: 1, headers: 2, format: 1 },
    unplaced: 1,
  });
});

test('channels keep a bounded stream list and countries sort busiest first', () => {
  const streams = [];
  for (let i = 0; i < LIVE_TV_MAX_STREAMS_PER_CHANNEL + 3; i++)
    streams.push(stream('Many.de', `https://s${i}.example/live.m3u8`));
  streams.push(stream('One.pl', 'https://pl.example/live.m3u8'));
  streams.push(stream('Two.de', 'https://de.example/live.m3u8'));
  const index = buildLiveTvIndex({
    channels: [
      channel('Many.de', 'DE'),
      channel('Two.de', 'DE'),
      channel('One.pl', 'PL'),
    ],
    streams,
    blocklist: [],
  });
  assert.deepEqual(
    index.countries.map(({ code, name, channels }) => [code, name, channels]),
    [
      ['DE', 'DE', 2],
      ['PL', 'PL', 1],
    ],
  );
  assert.equal(
    index.channelsByCountry.get('DE')[0].streams.length,
    LIVE_TV_MAX_STREAMS_PER_CHANNEL,
  );
});

test('the index refuses files that are not arrays', () => {
  assert.equal(
    buildLiveTvIndex({ channels: {}, streams: [], blocklist: [] }),
    null,
  );
  assert.equal(
    buildLiveTvIndex({ channels: [], streams: [], blocklist: null }),
    null,
  );
});

test('every anchor is a valid lon/lat pair keyed by a two-letter code', () => {
  const entries = Object.entries(LIVE_TV_COUNTRY_ANCHORS);
  assert.ok(entries.length >= 230);
  for (const [code, [lon, lat]] of entries) {
    assert.match(code, /^[A-Z]{2}$/);
    assert.ok(lon >= -180 && lon <= 180, code);
    assert.ok(lat >= -90 && lat <= 90, code);
  }
  // iptv-org files Great Britain under UK, not the ISO GB code.
  assert.ok(LIVE_TV_COUNTRY_ANCHORS.UK);
});

test('browser sanitizers keep only well-formed countries and playable channels', () => {
  assert.equal(sanitizeLiveTvCountries(null), null);
  assert.deepEqual(
    sanitizeLiveTvCountries([
      { code: 'DE', name: 'Germany', lon: 10, lat: 51, channels: 3 },
      { code: 'DE', name: 'Duplicate', lon: 10, lat: 51, channels: 3 },
      { code: 'xx', name: 'Lower', lon: 0, lat: 0, channels: 1 },
      { code: 'FR', name: 'Far', lon: 500, lat: 0, channels: 1 },
      { code: 'PL', name: 'Empty', lon: 19, lat: 52, channels: 0 },
    ]),
    [{ code: 'DE', name: 'Germany', lon: 10, lat: 51, channels: 3 }],
  );
  assert.equal(sanitizeLiveTvChannels('nope'), null);
  assert.deepEqual(
    sanitizeLiveTvChannels([
      {
        id: 'Good.de',
        name: 'Good\u0000TV',
        categories: ['news', 7],
        streams: [
          { url: 'javascript:alert(1)//.m3u8' },
          { url: 'https://ok.example/a.m3u8', quality: '720p', labels: ['x'] },
        ],
      },
      { id: 'NoStreams.de', name: 'None', streams: [] },
      {
        id: '<script>',
        name: 'Bad',
        streams: [{ url: 'https://ok.example/b.m3u8' }],
      },
    ]),
    [
      {
        id: 'Good.de',
        name: 'Good TV',
        categories: ['news'],
        streams: [
          { url: 'https://ok.example/a.m3u8', quality: '720p', labels: [] },
        ],
      },
    ],
  );
  assert.equal(isLiveTvCountryCode('PL'), true);
  assert.equal(isLiveTvCountryCode('pl'), false);
  assert.equal(isLiveTvCountryCode('../x'), false);
});
