import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SATELLITE_FEEDS,
  SATELLITE_FEED_IDS,
  feedForNorad,
  hasSatelliteFeed,
  himawariFullDiskUrl,
  resolveFeedSource,
  youtubeChannelLiveEmbed,
  youtubeVideoEmbed,
} from './satelliteFeeds.js';

test('every feed spec has the fields its kind requires', () => {
  for (const feed of SATELLITE_FEEDS) {
    assert.equal(typeof feed.noradId, 'number');
    assert.ok(feed.name && feed.shortLabel, `${feed.noradId} needs name + shortLabel`);
    assert.ok(['video', 'imagery'].includes(feed.kind));

    if (feed.kind === 'video') {
      assert.ok(Array.isArray(feed.sources) && feed.sources.length >= 1);
      assert.ok(feed.sources.some((s) => s.id === feed.defaultSourceId), 'defaultSourceId resolves');
      for (const source of feed.sources) {
        assert.ok(source.id && source.label && source.embedUrl && source.attribution);
        assert.ok(Array.isArray(source.videoIds) && source.videoIds.length >= 1, `${source.id} has candidate ids`);
        for (const id of source.videoIds) assert.match(id, /^[\w-]{11}$/, 'looks like a YouTube video id');
        assert.ok(source.watchUrl, `${source.id} has a watch fallback url`);
      }
    } else {
      assert.equal(typeof feed.frameUrl, 'function');
      assert.ok(feed.refreshMs > 0);
      assert.ok(feed.attribution);
    }
  }
});

test('SATELLITE_FEED_IDS is exactly the set of registered NORAD ids', () => {
  assert.ok(SATELLITE_FEED_IDS instanceof Set);
  assert.deepEqual(
    [...SATELLITE_FEED_IDS].sort((a, b) => a - b),
    SATELLITE_FEEDS.map((f) => f.noradId).sort((a, b) => a - b),
  );
});

test('feedForNorad / hasSatelliteFeed coerce input and miss cleanly', () => {
  assert.equal(feedForNorad(25544).shortLabel, 'ISS');
  assert.equal(feedForNorad('25544').shortLabel, 'ISS'); // string NORAD id
  assert.equal(feedForNorad(11111), null);
  assert.equal(hasSatelliteFeed(60133), true);
  assert.equal(hasSatelliteFeed(60134), false);
});

test('the ISS is registered as a video feed with NASA as default', () => {
  const iss = feedForNorad(25544);
  assert.equal(iss.kind, 'video');
  assert.equal(iss.defaultSourceId, 'nasa');
  assert.ok(iss.sources.some((s) => s.id === 'earth'), 'ships the 24/7 Earth source too');
});

test('youtube embeds are muted and use the privacy host', () => {
  const iss = feedForNorad(25544);
  for (const source of iss.sources) {
    assert.match(source.embedUrl, /^https:\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{11}\?/);
    assert.match(source.embedUrl, /[?&]mute=1(&|$)/);
    // embedUrl is the plain-iframe fallback: it must be the first candidate id.
    assert.ok(source.embedUrl.includes(`/embed/${source.videoIds[0]}?`));
  }
  assert.match(youtubeVideoEmbed('abc12345678'), /\/embed\/abc12345678\?.*mute=1/);
  assert.match(youtubeChannelLiveEmbed('UCabc'), /channel=UCabc&.*mute=1/);
});

test('GOES frameUrl is stable within a 10-min bucket and rolls at the boundary', () => {
  const goes = feedForNorad(60133);
  const base = Date.UTC(2026, 7, 31, 12, 0, 0);
  assert.equal(goes.frameUrl(base), goes.frameUrl(base + 9 * 60 * 1000), 'same bucket → same url');
  assert.notEqual(goes.frameUrl(base), goes.frameUrl(base + 10 * 60 * 1000), 'next bucket → new url');
  assert.match(goes.frameUrl(base), /GOES19\/ABI\/FD\/GEOCOLOR\/latest\.jpg\?_=\d+$/);
});

test('Himawari frameUrl floors to a UTC 10-min slot with a 30-min lookback', () => {
  // 12:47:30Z → minus 30 min = 12:17:30Z → floored = 12:10:00Z
  const url = himawariFullDiskUrl(Date.UTC(2026, 7, 31, 12, 47, 30));
  assert.match(url, /D531106\/1d\/550\/2026\/08\/31\/121000_0_0\.png$/);
});

test('resolveFeedSource falls back default → first, and rejects non-video feeds', () => {
  const iss = feedForNorad(25544);
  assert.equal(resolveFeedSource(iss, 'earth').id, 'earth');
  assert.equal(resolveFeedSource(iss, 'nope').id, 'nasa'); // → defaultSourceId
  assert.equal(resolveFeedSource(iss, null).id, 'nasa');
  assert.equal(resolveFeedSource(feedForNorad(60133)), null); // imagery
  assert.equal(resolveFeedSource(null), null);
});
