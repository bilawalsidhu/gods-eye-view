import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCyberEnrichment,
  normalizeCyberKevSnapshot,
  normalizeCyberOtxResult,
  normalizeCyberSnapshot,
  normalizeShodanSearchResult,
} from './records.js';

const base = {
  schemaVersion: 1,
  provider: 'dshield',
  attribution: 'SANS Internet Storm Center / DShield',
  fetchedAt: '2026-09-20T12:00:00Z',
  observations: [
    {
      id: 'dshield:1',
      provider: 'dshield',
      category: 'reported-top-source-ip',
      source: 'SANS ISC / DShield',
      observedAt: null,
      indicator: { type: 'ipv4', value: '192.0.2.1' },
    },
  ],
  ports: [
    { rank: 1, port: 443, protocol: 'tcp', label: 'https', sources: null },
  ],
};

test('normalizes DShield as attributable, non-geographic records', () => {
  const snapshot = normalizeCyberSnapshot(base, 'dshield');
  assert.equal(snapshot.observations[0].latitude, null);
  assert.equal(snapshot.observations[0].longitude, null);
  assert.equal(snapshot.observations[0].indicator.value, '192.0.2.1');
  assert.equal(snapshot.ports[0].port, 443);
  assert.ok(Object.isFrozen(snapshot.observations));
});

test('rejects invalid geography, provider spoofing, excess rows and malformed ports', () => {
  assert.throws(
    () =>
      normalizeCyberSnapshot(
        {
          ...base,
          observations: [
            { ...base.observations[0], latitude: 40, longitude: -70 },
          ],
        },
        'dshield',
      ),
    /Malformed Cyber/,
  );
  assert.throws(
    () =>
      normalizeCyberSnapshot(
        {
          ...base,
          observations: [
            { ...base.observations[0], provider: 'cloudflare-radar' },
          ],
        },
        'dshield',
      ),
    /Malformed Cyber/,
  );
  assert.throws(
    () =>
      normalizeCyberSnapshot(
        { ...base, observations: Array(33).fill(base.observations[0]) },
        'dshield',
      ),
    /Malformed Cyber/,
  );
  assert.throws(
    () =>
      normalizeCyberSnapshot(
        { ...base, ports: [{ rank: 1, port: 70000, label: 'bad' }] },
        'dshield',
      ),
    /Malformed Cyber/,
  );
});

test('accepts country aggregate coordinates only with explicit provenance', () => {
  const radar = {
    ...base,
    provider: 'cloudflare-radar',
    observations: [
      {
        id: 'radar:origin:US',
        provider: 'cloudflare-radar',
        category: 'layer7-attack-origin',
        source: 'Cloudflare Radar',
        observedAt: '2026-09-20T12:00:00Z',
        latitude: 39.8,
        longitude: -98.6,
        geographicPrecision: 'country',
        geographicMethod: 'Country reference point',
        geographicProvenance: 'United States (US); country-level aggregation',
        locationCode: 'US',
        locationName: 'United States',
        share: 12.5,
        rank: 1,
      },
    ],
    flows: [
      {
        id: 'radar:flow:US:BE',
        provider: 'cloudflare-radar',
        origin: {
          code: 'US',
          name: 'United States',
          latitude: 39.8,
          longitude: -98.6,
        },
        target: { code: 'BE', name: 'Belgium', latitude: 50.5, longitude: 4.5 },
        share: 3.6,
        rank: 1,
        observedAt: '2026-09-20T12:00:00Z',
        windowStart: '2026-09-20T00:00:00Z',
        windowEnd: '2026-09-20T12:00:00Z',
        geographicPrecision: 'country',
        geographicMethod: 'Cloudflare country reference coordinates',
        geographicProvenance: 'Cloudflare Radar country-level pair',
      },
    ],
    ports: [],
  };
  const snapshot = normalizeCyberSnapshot(radar, 'cloudflare-radar');
  assert.equal(snapshot.observations[0].geographicPrecision, 'country');
  assert.equal(snapshot.flows[0].origin.code, 'US');
  assert.equal(snapshot.flows[0].target.code, 'BE');
  assert.equal(snapshot.flows[0].share, 3.6);
  assert.ok(Object.isFrozen(snapshot.flows));
  assert.throws(
    () =>
      normalizeCyberSnapshot(
        {
          ...radar,
          observations: [{ ...radar.observations[0], longitude: 190 }],
        },
        'cloudflare-radar',
      ),
    /Malformed Cyber/,
  );
  assert.throws(
    () =>
      normalizeCyberSnapshot(
        { ...radar, flows: [{ ...radar.flows[0], target: null }] },
        'cloudflare-radar',
      ),
    /Malformed Cyber/,
  );
});

test('normalizes optional provider results and allows only explicit approximate host geography', () => {
  const shodan = normalizeCyberEnrichment(
    {
      provider: 'shodan',
      ip: '8.8.8.8',
      fetchedAt: '2026-09-20T01:00:00Z',
      attribution: 'Shodan',
      organization: 'Example',
      latitude: 37.4,
      longitude: -122.1,
      geographicPrecision: 'network-approximate',
      geographicProvenance: 'Approximate IP location',
      services: [{ port: 443, product: 'HTTPS', banner: 'banner' }],
    },
    'shodan',
  );
  assert.equal(shodan.geographicPrecision, 'network-approximate');
  assert.equal(shodan.services[0].port, 443);
  const grey = normalizeCyberEnrichment(
    {
      provider: 'greynoise',
      ip: '8.8.8.8',
      fetchedAt: '2026-09-20T01:00:00Z',
      attribution: 'GreyNoise Community API',
      noise: true,
      riot: false,
    },
    'greynoise',
  );
  assert.equal(grey.noise, true);
  assert.equal('latitude' in grey, false);
  assert.throws(() =>
    normalizeCyberEnrichment(
      {
        provider: 'shodan',
        ip: '8.8.8.8',
        fetchedAt: '2026-09-20T01:00:00Z',
        attribution: 'Shodan',
        latitude: 999,
        longitude: 0,
        geographicPrecision: 'network-approximate',
      },
      'shodan',
    ),
  );
});

test('Shodan search normalization accepts a full page and rejects provider spoofing', () => {
  const host = {
    provider: 'shodan',
    ip: '8.8.8.8',
    fetchedAt: '2026-09-20T01:00:00Z',
    attribution: 'Shodan',
    services: [],
  };
  const result = normalizeShodanSearchResult({
    provider: 'shodan',
    query: 'port:443',
    page: 1,
    fetchedAt: host.fetchedAt,
    attribution: 'Shodan',
    total: 1,
    matches: Array.from({ length: 100 }, (_, index) => ({
      ...host,
      ip: `8.8.${Math.floor(index / 256)}.${index + 1}`,
    })),
  });
  assert.equal(result.matches.length, 100);
  assert.equal(result.pageSize, 100);
  assert.throws(() =>
    normalizeShodanSearchResult({
      provider: 'other',
      query: 'x',
      page: 1,
      fetchedAt: host.fetchedAt,
      attribution: 'Other',
      total: 1,
      matches: [host],
    }),
  );
});

test('CISA KEV normalization retains bounded catalog records without geography', () => {
  const result = normalizeCyberKevSnapshot(kevSnapshot());
  assert.equal(result.count, 1);
  assert.equal(result.vulnerabilities[0].cveId, 'CVE-2024-12345');
  assert.equal(result.vulnerabilities[0].ransomware, 'Known');
  assert.equal('latitude' in result.vulnerabilities[0], false);
  assert.equal('longitude' in result.vulnerabilities[0], false);
  assert.throws(() =>
    normalizeCyberKevSnapshot({
      ...kevSnapshot(),
      vulnerabilities: [
        {
          ...kevSnapshot().vulnerabilities[0],
          cveId: 'not-a-cve',
        },
      ],
    }),
  );
});

function kevSnapshot() {
  return {
    schemaVersion: 1,
    provider: 'cisa-kev',
    attribution: 'CISA Known Exploited Vulnerabilities Catalog',
    catalogVersion: '2026.09.23',
    dateReleased: '2026-09-23T12:51:35.821Z',
    fetchedAt: '2026-09-23T13:00:00.000Z',
    stale: false,
    count: 1,
    vulnerabilities: [
      {
        cveId: 'CVE-2024-12345',
        vendor: 'Example Vendor',
        product: 'Example Product',
        name: 'Example vulnerability',
        dateAdded: '2026-09-22',
        shortDescription: 'A test vulnerability.',
        requiredAction: 'Apply the vendor update.',
        dueDate: '2026-10-01',
        ransomware: 'Known',
        forensicTriage: true,
        notes: null,
        cwes: ['CWE-20'],
      },
    ],
  };
}

test('normalizes OTX pulse context without accepting geographic fields', () => {
  const result = normalizeCyberOtxResult({
    schemaVersion: 1,
    provider: 'alienvault-otx',
    indicator: '8.8.8.8',
    indicatorType: 'IPv4',
    indicatorTypeLabel: 'IPv4',
    fetchedAt: '2026-09-20T12:00:00Z',
    attribution: 'AlienVault Open Threat Exchange (OTX)',
    pulseCount: 1,
    pulses: [{ id: 'a'.repeat(24), name: 'Example pulse', tags: ['phishing'] }],
    latitude: 40,
    longitude: -74,
  });
  assert.equal(result.pulses.length, 1);
  assert.equal(result.link, 'https://otx.alienvault.com/indicator/ip/8.8.8.8');
  assert.equal('latitude' in result, false);
  assert.equal('longitude' in result, false);
  assert.throws(() =>
    normalizeCyberOtxResult({
      ...{
        schemaVersion: 1,
        provider: 'alienvault-otx',
        indicator: '8.8.8.8',
        indicatorType: 'IPv4',
        fetchedAt: '2026-09-20T12:00:00Z',
        attribution: 'AlienVault Open Threat Exchange (OTX)',
        pulseCount: 0,
        pulses: [],
      },
      attribution: 'untrusted',
    }),
  );
});
