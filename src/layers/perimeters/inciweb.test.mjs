import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findInciwebLink,
  resolveInciwebNodeLink,
  createInciwebIndexSource,
  createInciwebPublicationSource,
  isCurrentPublication,
  inciwebNodeId,
} from './inciweb.js';

const catalog = [
  {
    incident_id: '322812',
    tau: 'NMSNF Gobernador Pile Burn Coyote Ranger District',
    incident_title: 'Gobernador Pile Burn - Coyote Ranger District',
  },
  {
    incident_id: '327504',
    tau: 'SDBKF Coyote Flats Fire',
    incident_title: 'Coyote Flats Fire',
  },
  {
    incident_id: '328922',
    tau: 'OR95S Coyote Fire',
    incident_title: 'Coyote Fire',
  },
  {
    incident_id: '329195',
    tau: 'ORBUD Second Flat',
    incident_title: 'Second Flat',
  },
  {
    incident_id: '329273',
    tau: 'ORBUD 2026 Coleman Creek',
    incident_title: '2026 Coleman Creek',
  },
  {
    incident_id: '328923',
    tau: 'ORPRD Rowe Creek Complex',
    incident_title: 'Rowe Creek Complex',
  },
  {
    incident_id: '291765',
    tau: 'CALPF Timber Fire',
    incident_title: 'Timber Fire',
  },
];

test('incidents resolve by exact normalized title to a node link', () => {
  // Title formats vary: with/without a 'Fire' suffix, with/without a year
  // prefix ('2026 Coleman Creek'). All normalize to the WFIGS name.
  assert.equal(
    resolveInciwebNodeLink(catalog, { name: 'Second Flat', state: 'US-OR' }),
    'https://inciweb.wildfire.gov/node/329195',
  );
  assert.equal(
    resolveInciwebNodeLink(catalog, { name: 'Coleman Creek', state: 'US-OR' }),
    'https://inciweb.wildfire.gov/node/329273',
  );
  assert.equal(
    resolveInciwebNodeLink(catalog, { name: 'Timber', state: 'US-CA' }),
    'https://inciweb.wildfire.gov/node/291765',
  );
  assert.equal(
    resolveInciwebNodeLink(catalog, { name: 'Coyote', state: 'US-OR' }),
    'https://inciweb.wildfire.gov/node/328922',
  );
  // Substring-style near-misses never match.
  assert.equal(
    resolveInciwebNodeLink(catalog, { name: 'Gobernador', state: 'US-NM' }),
    null,
  );
  assert.equal(
    resolveInciwebNodeLink(catalog, { name: 'Nope', state: null }),
    null,
  );
  assert.equal(
    resolveInciwebNodeLink(null, { name: 'Coyote', state: 'US-OR' }),
    null,
  );
});

test('a unique candidate in the wrong state is rejected, not linked', () => {
  // The catalog is all-time and nationwide: a current Arizona "Willow"
  // must not link to the only "Willow Fire" on file when it's a Montana
  // incident.
  const willow = [
    {
      incident_id: '300001',
      tau: 'MTFNF Willow Fire',
      incident_title: 'Willow Fire',
    },
  ];
  assert.equal(
    resolveInciwebNodeLink(willow, { name: 'Willow', state: 'US-AZ' }),
    null,
  );
  assert.equal(
    resolveInciwebNodeLink(willow, { name: 'Willow', state: 'US-MT' }),
    'https://inciweb.wildfire.gov/node/300001',
  );
});

test('ambiguous titles disambiguate by state, then newest id', () => {
  const twoCoyotes = [
    {
      incident_id: '100',
      tau: 'AZASF Coyote Fire',
      incident_title: 'Coyote Fire',
    },
    {
      incident_id: '328922',
      tau: 'OR95S Coyote Fire',
      incident_title: 'Coyote Fire',
    },
  ];
  assert.equal(
    resolveInciwebNodeLink(twoCoyotes, { name: 'Coyote', state: 'US-AZ' }),
    'https://inciweb.wildfire.gov/node/100',
  );
  assert.equal(
    resolveInciwebNodeLink(twoCoyotes, { name: 'Coyote', state: null }),
    null,
  );
  const twoSameState = [
    {
      incident_id: '100',
      tau: 'ORXXX Coyote Fire',
      incident_title: 'Coyote Fire',
    },
    {
      incident_id: '328922',
      tau: 'OR95S Coyote Fire',
      incident_title: 'Coyote Fire',
    },
  ];
  // Same-state duplicates are usually reburns of the same name — newest wins.
  assert.equal(
    resolveInciwebNodeLink(twoSameState, { name: 'Coyote', state: 'US-OR' }),
    'https://inciweb.wildfire.gov/node/328922',
  );
});

test('a complex member falls back to its complex page', () => {
  assert.equal(
    findInciwebLink(catalog, {
      name: 'Crosswhite',
      state: 'US-OR',
      complexName: 'ROWE CREEK COMPLEX',
    }),
    'https://inciweb.wildfire.gov/node/328923',
  );
  // A fire with its own page keeps it even when it belongs to a complex.
  assert.equal(
    findInciwebLink(catalog, {
      name: 'Timber',
      state: 'US-CA',
      complexName: 'SOME COMPLEX',
    }),
    'https://inciweb.wildfire.gov/node/291765',
  );
  assert.equal(
    findInciwebLink(catalog, {
      name: 'Nope',
      state: 'US-NM',
      complexName: null,
    }),
    null,
  );
});

test('a node link exposes its publication id', () => {
  assert.equal(
    inciwebNodeId('https://inciweb.wildfire.gov/node/329195'),
    '329195',
  );
  assert.equal(inciwebNodeId('https://example.com/other'), null);
  assert.equal(inciwebNodeId(null), null);
});

test('publication currency accepts pages created around or after discovery', () => {
  const day = 24 * 3600000;
  const discovery = 1785000000000;
  // Created shortly before discovery (page opened as the fire started).
  assert.equal(
    isCurrentPublication(
      { createdMs: discovery - 10 * day, changedMs: discovery + 30 * day },
      { discoveredTime: discovery },
    ),
    true,
  );
  // Created years before discovery: an archived same-name incident.
  assert.equal(
    isCurrentPublication(
      { createdMs: discovery - 900 * day, changedMs: discovery - 800 * day },
      { discoveredTime: discovery },
    ),
    false,
  );
  // No discovery date: fall back to recent activity on the page.
  const now = 1787600000000;
  assert.equal(
    isCurrentPublication(
      { createdMs: now - 900 * day, changedMs: now - 20 * day },
      { discoveredTime: null, nowMs: now },
    ),
    true,
  );
  assert.equal(
    isCurrentPublication(
      { createdMs: now - 900 * day, changedMs: now - 400 * day },
      { discoveredTime: null, nowMs: now },
    ),
    false,
  );
  // Unusable timestamps fail closed.
  assert.equal(
    isCurrentPublication(
      { createdMs: null, changedMs: null },
      { discoveredTime: discovery },
    ),
    false,
  );
});

test('the publication source fetches timestamps and honors cancellation', async () => {
  let requested;
  const source = createInciwebPublicationSource({
    fetchImpl: async (url) => {
      requested = String(url);
      return {
        ok: true,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            createdMs: 1785025540000,
            changedMs: 1787589503000,
          }),
      };
    },
  });
  const publication = await source.getPublication('329195');
  assert.equal(requested, '/api/fire-perimeters/inciweb/publication/329195');
  assert.deepEqual(publication, {
    createdMs: 1785025540000,
    changedMs: 1787589503000,
  });

  const malformed = createInciwebPublicationSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      text: async () => JSON.stringify({ nope: 1 }),
    }),
  });
  assert.deepEqual(await malformed.getPublication('1'), {
    createdMs: null,
    changedMs: null,
  });

  const failing = createInciwebPublicationSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(failing.getPublication('1'), /InciWeb HTTP 503/);

  const abort = new AbortController();
  const cancelled = createInciwebPublicationSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      text: async () => {
        abort.abort();
        return JSON.stringify({});
      },
    }),
  });
  await assert.rejects(
    cancelled.getPublication('1', { signal: abort.signal }),
    {
      name: 'AbortError',
    },
  );
});

test('the index source requests the same-origin full catalog', async () => {
  let request;
  const source = createInciwebIndexSource({
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify(catalog),
      };
    },
  });
  const rows = await source.getIndex();
  assert.equal(rows.length, catalog.length);
  assert.equal(request.url, '/api/fire-perimeters/inciweb/index');
  assert.equal(request.options.method, undefined);
  assert.equal(request.options.body, undefined);
});

test('the index source rejects failures and honors cancellation', async () => {
  const failing = createInciwebIndexSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(failing.getIndex(), /InciWeb HTTP 503/);

  const malformed = createInciwebIndexSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      text: async () => JSON.stringify({ nope: 1 }),
    }),
  });
  assert.deepEqual(await malformed.getIndex(), []);

  const abort = new AbortController();
  const cancelled = createInciwebIndexSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      text: async () => {
        abort.abort();
        return JSON.stringify(catalog);
      },
    }),
  });
  await assert.rejects(cancelled.getIndex({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
