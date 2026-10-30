import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import {
  fetchWithinHost,
  fetchCctvImageFromUpstream,
} from '../../server/providers/cctv/media.js';

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = read('../../config/cctv_sources.argentina.json');
const survey = read('../../docs/data/cctv-argentina-survey-2026-10-15.json');
const mediaUrl = (camera) => camera.embedUrl || camera.url;

test('Peatonal Dufaur overrides the dedicated pack instead of duplicating its stream', () => {
  const dedicated = {
    id: 'monte-hermoso-peatonal-dufaur',
    url: 'https://encoder-1b.montevision.com.ar/live/monte2.m3u8',
    lat: -38.988,
    lon: -61.2865,
  };
  const { sources } = allocateSourceCap(
    [
      { name: 'monte-hermoso', sources: [dedicated] },
      { name: 'file', sources: catalog },
    ],
    1000,
  );
  const matches = sources.filter((camera) => camera.url === dedicated.url);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, dedicated.id);
  assert.equal(matches[0].lat, dedicated.lat);
  assert.equal(matches[0].lon, dedicated.lon);
});

test('Varitech stays in its separate opt-in pack, with historical receipts preserved', () => {
  const pack = survey.separatePacks.find(
    (entry) => entry.provider === 'Varitech',
  );
  assert.equal(pack.status, 'covered-by-pr');
  assert.equal(
    pack.pullRequest,
    'https://github.com/bilawalsidhu/gods-eye-view/pull/1147',
  );
  assert.equal(pack.enableEnv, 'CCTV_VARITECH_ENABLED=1');
  assert.equal(pack.verification.length, 10);
  const activeIds = new Set(catalog.map((camera) => camera.id));
  for (const receipt of pack.verification) {
    assert.ok(!activeIds.has(receipt.cameraId));
    assert.equal(receipt.checkedAt, survey.checkedAt);
    assert.equal(receipt.decoded, true);
    assert.equal(new URL(receipt.publishedUrl).hostname, 'varitech.ar');
  }
  for (const camera of catalog) {
    assert.ok(!camera.id.startsWith('ar-varitech-'));
    assert.notEqual(new URL(mediaUrl(camera)).hostname, 'varitech.ar');
  }
});

test('Argentina sources have unique public media and uncalibrated area anchors', () => {
  assert.equal(new Set(catalog.map((c) => c.id)).size, catalog.length);
  assert.equal(new Set(catalog.map(mediaUrl)).size, catalog.length);
  for (const camera of catalog) {
    assert.match(camera.id, /^[a-z0-9-]+$/);
    assert.match(camera.cityId, /^[a-z0-9-]+$/);
    assert.equal(camera.country, 'AR');
    assert.ok(
      Number.isFinite(camera.lat) && camera.lat >= -56 && camera.lat <= -21,
      camera.id,
    );
    assert.ok(
      Number.isFinite(camera.lon) && camera.lon >= -74 && camera.lon <= -53,
      camera.id,
    );
    for (const key of [
      'name',
      'city',
      'province',
      'provider',
      'credit',
      'license',
      'locationNote',
    ]) {
      assert.ok(
        typeof camera[key] === 'string' && camera[key].trim(),
        `${camera.id}: ${key}`,
      );
    }
    for (const value of [
      mediaUrl(camera),
      camera.sourcePageUrl,
      camera.locationSourceUrl,
    ]) {
      const url = new URL(value);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username + url.password + url.hash, '');
      for (const key of url.searchParams.keys())
        assert.ok(['v', 'alias'].includes(key), key);
    }
    assert.equal(camera.headingConfidence, 'low');
    for (const key of [
      'headingDeg',
      'pitchDeg',
      'fovDeg',
      'rangeM',
      'mountHeightM',
      'poseSource',
    ]) {
      assert.equal(
        camera[key],
        undefined,
        `${camera.id} must not assert a pose`,
      );
    }
  }
});

test('Argentina types use supported URL contracts and normalize direct feeds unchanged', () => {
  for (const camera of catalog) {
    assert.ok(['embed', 'hls', 'image'].includes(camera.feedType));
    const url = new URL(mediaUrl(camera));
    if (camera.feedType === 'embed') {
      assert.ok(normalizeSourceItem(camera).embedUrl, camera.id);
      if (url.hostname === 'www.youtube.com') {
        assert.equal(url.pathname, '/watch');
        assert.match(url.searchParams.get('v'), /^[A-Za-z0-9_-]{11}$/);
      } else if (url.hostname === 'www.twitch.tv') {
        assert.match(url.pathname, /^\/[a-z0-9_]{1,25}$/);
        assert.equal(url.search, '');
      } else if (url.hostname === 'v.angelcam.com') {
        assert.equal(url.pathname, '/iframe');
        assert.match(url.searchParams.get('v'), /^[a-z0-9]{10}$/);
      } else {
        assert.match(url.hostname, /^[a-z0-9-]+\.roundshot\.com$/);
        assert.equal(url.pathname, '/');
        assert.equal(url.search, '');
      }
      assert.equal(camera.url, undefined);
      assert.equal(camera.snapshotUrl, undefined);
    } else {
      const normalized = normalizeSourceItem(camera);
      assert.equal(normalized.feedType, camera.feedType);
      assert.equal(normalized.url, camera.url);
      assert.equal(normalized.lat, camera.lat);
      assert.equal(normalized.lon, camera.lon);
      if (camera.feedType === 'hls') assert.match(url.pathname, /\.m3u8$/);
      else assert.equal(camera.snapshotUrl, camera.url);
    }
    if (camera.snapshotAliasUrl) {
      const alias = new URL(camera.snapshotAliasUrl);
      assert.equal(alias.origin, 'https://ipcamlive.com');
      assert.equal(alias.pathname, '/player/snapshot.php');
      assert.deepEqual([...alias.searchParams.keys()], ['alias']);
      assert.match(alias.searchParams.get('alias'), /^[a-z0-9]+$/);
      assert.equal(camera.url, camera.snapshotAliasUrl);
    }
  }
});

test('IPCamLive aliases follow only public snapshot redirects and never forward private headers', async () => {
  const alias =
    'https://ipcamlive.com/player/snapshot.php?alias=telecabina1500';
  const target = 'https://s123.ipcamlive.com/streams/abcd1234/snapshot.jpg';
  const requests = [];
  const response = await fetchWithinHost(
    alias,
    { headers: { Authorization: 'private', Cookie: 'private' } },
    async (url, init) => {
      requests.push(url);
      assert.equal(new Headers(init.headers).get('authorization'), null);
      assert.equal(new Headers(init.headers).get('cookie'), null);
      assert.equal(init.credentials, 'omit');
      return url === alias
        ? new Response(null, { status: 302, headers: { location: target } })
        : new Response('image');
    },
  );
  assert.equal(await response.text(), 'image');
  assert.deepEqual(requests, [alias, target]);
  for (const location of [
    'http://s123.ipcamlive.com/streams/a/snapshot.jpg',
    'https://s123.ipcamlive.com.evil.example/streams/a/snapshot.jpg',
    'https://127.0.0.1/snapshot.jpg',
    'https://s123.ipcamlive.com:8443/streams/a/snapshot.jpg',
    'https://user:pass@s123.ipcamlive.com/streams/a/snapshot.jpg',
    'https://s123.ipcamlive.com/private',
    target + '?token=x',
  ]) {
    let calls = 0;
    assert.equal(
      await fetchWithinHost(alias, {}, async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      }),
      null,
    );
    assert.equal(calls, 1, location);
  }
  let calls = 0;
  assert.equal(
    await fetchWithinHost(
      'https://camera.example/snapshot.jpg',
      {},
      async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: target },
        });
      },
    ),
    null,
  );
  assert.equal(
    calls,
    1,
    'other registered hosts keep their original origin pin',
  );
  calls = 0;
  assert.equal(
    await fetchWithinHost(alias + '&token=private', {}, async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: target } });
    }),
    null,
  );
  assert.equal(
    calls,
    1,
    'only the exact public alias contract receives the exception',
  );
  calls = 0;
  assert.equal(
    await fetchWithinHost(alias, {}, async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: target } });
    }),
    null,
  );
  assert.equal(
    calls,
    3,
    'the existing two-redirect limit also bounds alias loops',
  );
});

test('every active feed has a dated receipt and unavailable media stays out', () => {
  const receipts = new Map(
    survey.runtimeVerification.map((r) => [r.cameraId, r]),
  );
  assert.equal(receipts.size, survey.runtimeVerification.length);
  assert.equal(receipts.size, catalog.length);
  const counts = {};
  for (const camera of catalog) {
    counts[camera.feedType] = (counts[camera.feedType] || 0) + 1;
    const receipt = receipts.get(camera.id);
    assert.ok(receipt, camera.id);
    assert.equal(camera.checkedAt, survey.checkedAt);
    assert.equal(receipt.checkedAt.slice(0, 10), survey.checkedAt);
    if (camera.feedType === 'embed') {
      const url = new URL(camera.embedUrl);
      if (url.hostname.endsWith('.roundshot.com')) {
        assert.equal(receipt.provider, 'roundshot');
        assert.equal(receipt.captureDate, survey.checkedAt);
        assert.ok(receipt.canvasSize.every((n) => n > 0));
      } else {
        if (url.hostname === 'www.youtube.com') {
          assert.equal(receipt.videoId, url.searchParams.get('v'));
          assert.equal(receipt.isLiveNow, true);
        } else if (url.hostname === 'www.twitch.tv') {
          assert.equal(receipt.provider, 'twitch');
          assert.equal(receipt.channel, url.pathname.slice(1));
          assert.equal(receipt.isLiveNow, true);
        } else {
          assert.equal(receipt.provider, 'angelcam');
          // Angelcam's 256x144 connecting animation is not camera video.
          assert.ok(receipt.videoSize[0] > 256);
        }
        assert.ok(receipt.playbackAdvancedSeconds > 0.5);
        assert.ok(receipt.videoSize.every((n) => n > 0));
      }
    } else {
      assert.equal(receipt.httpStatus, 200);
      assert.equal(receipt.decoded, true);
      if (camera.feedType === 'image') {
        assert.equal(
          new Date(receipt.lastModified).toISOString().slice(0, 10),
          survey.checkedAt,
        );
      }
    }
  }
  assert.deepEqual(counts, survey.runtimeCounts);
  assert.equal(
    new Set(survey.otherSources.map((r) => r.id)).size,
    survey.otherSources.length,
  );
  const active = new Set(catalog.map(mediaUrl));
  for (const finding of survey.otherSources) {
    assert.ok(finding.reason && finding.sourcePageUrl && finding.status);
    assert.equal(finding.checkedAt, survey.checkedAt);
    if (finding.publishedUrl)
      assert.ok(!active.has(finding.publishedUrl), finding.id);
  }
});

test('survey dispositions preserve the original leads and resolve only active feeds', () => {
  const findings = [...survey.otherSources, ...survey.resolvedSources];
  assert.equal(new Set(findings.map((r) => r.id)).size, findings.length);
  assert.equal(findings.length, survey.resolutionSummary.originalFindings);
  const activeIds = new Set(catalog.map((camera) => camera.id));
  const recoveredIds = survey.resolvedSources.flatMap((finding) => {
    assert.equal(finding.status, 'included');
    assert.ok(finding.previousStatus && finding.reason);
    assert.ok(finding.cameraIds.length > 0);
    for (const id of finding.cameraIds) assert.ok(activeIds.has(id), id);
    return finding.cameraIds;
  });
  assert.equal(new Set(recoveredIds).size, recoveredIds.length);
  assert.equal(recoveredIds.length, survey.resolutionSummary.addedRuntimeFeeds);
  assert.equal(
    survey.resolvedSources.length,
    survey.resolutionSummary.resolvedFindings,
  );
  assert.equal(
    survey.otherSources.length,
    survey.resolutionSummary.remainingFindings,
  );
  const dispositions = {};
  for (const finding of survey.otherSources) {
    assert.ok(
      [
        'discarded',
        'unavailable',
        'stale',
        'multi-location',
        'covered-by-pr',
      ].includes(finding.status),
    );
    dispositions[finding.status] = (dispositions[finding.status] || 0) + 1;
    if (finding.status === 'discarded') {
      assert.ok(
        ['republication-restricted', 'no-current-public-feed'].includes(
          finding.discardReason,
        ),
      );
      if (finding.discardReason === 'republication-restricted') {
        assert.equal(new URL(finding.termsUrl).protocol, 'https:');
      }
    }
    if (finding.provider === 'Cámaras de Misiones') {
      assert.equal(finding.status, 'covered-by-pr');
      assert.ok(!activeIds.has(finding.id));
    }
  }
  assert.deepEqual(dispositions, survey.resolutionSummary.dispositions);
});

test('IPCamLive redirect exception still enforces raster MIME validation', async () => {
  const alias =
    'https://ipcamlive.com/player/snapshot.php?alias=telecabina1500';
  const target = 'https://s12.ipcamlive.com/streams/abc123/snapshot.jpg';
  for (const type of [
    'image/jpeg',
    'image/svg+xml',
    'text/html',
    'application/octet-stream',
    '',
  ]) {
    const requests = [];
    const result = await fetchCctvImageFromUpstream(alias, {
      fetchImpl: async (url) => {
        requests.push(url);
        return url === alias
          ? new Response(null, { status: 302, headers: { location: target } })
          : new Response('fixture', { headers: { 'content-type': type } });
      },
    });
    assert.deepEqual(requests, [alias, target]);
    assert.equal(
      result?.contentType ?? null,
      type === 'image/jpeg' ? type : null,
    );
  }
});
