import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSocialAnalyzerReport } from './socialAnalyzerImport.js';

test('parses one detected row and discards unknown and failed report data', () => {
  const report = {
    detected: [
      {
        site: 'Example Social',
        url: 'https://example.com/alice',
        username: 'alice',
        rate: 97.5,
      },
    ],
    unknown: [
      {
        site: 'Ignored Social',
        url: 'https://ignored.example/bob',
        username: 'bob',
        rate: 20,
      },
    ],
    failed: [
      {
        site: 'Failed Social',
        url: 'https://failed.example/charlie',
        username: 'charlie',
        rate: 10,
      },
    ],
  };

  assert.deepEqual(parseSocialAnalyzerReport(JSON.stringify(report), {
    importedAtMs: 1_700_000_000_000,
    candidateIdFactory: () => '018f47f2-6fa8-7b01-9f30-9b6a9e676601',
  }), {
    source: 'social-analyzer',
    importedAtMs: 1_700_000_000_000,
    candidates: [
      {
        id: '018f47f2-6fa8-7b01-9f30-9b6a9e676601',
        sourceCategory: 'social-profile',
        provider: 'Example Social',
        url: 'https://example.com/alice',
        username: 'alice',
        confidence: 97.5,
        status: 'unverified',
        importedAtMs: 1_700_000_000_000,
      },
    ],
  });
});

test('rejects malformed shape, unsafe url, and oversize reports', () => {
  assert.throws(
    () => parseSocialAnalyzerReport(JSON.stringify({ detected: {} }), { importedAtMs: 1 }),
    (error) => error?.code === 'UNSUPPORTED_SCHEMA',
  );

  assert.throws(
    () => parseSocialAnalyzerReport(JSON.stringify({ detected: [], metadata: {} }), { importedAtMs: 1 }),
    (error) => error?.code === 'UNSUPPORTED_SCHEMA',
  );

  assert.throws(
    () => parseSocialAnalyzerReport(JSON.stringify({
      detected: [{ site: 'Example Social', url: 'https://example.com/alice', rate: 50, pageText: 'unexpected' }],
    }), { importedAtMs: 1 }),
    (error) => error?.code === 'UNSUPPORTED_SCHEMA',
  );

  for (const importedAtMs of [undefined, NaN, -1, 1.5]) {
    assert.throws(
      () => parseSocialAnalyzerReport('{"detected":[]}', { importedAtMs }),
      (error) => error?.code === 'INVALID_TIMESTAMP',
    );
  }

  assert.throws(
    () => parseSocialAnalyzerReport(JSON.stringify({ detected: [{ site: 'Example Social', url: 'http://example.com/alice', username: 'alice', rate: 50 }] }), { importedAtMs: 1 }),
    (error) => error?.code === 'UNSAFE_URL',
  );

  assert.throws(
    () => parseSocialAnalyzerReport(`"${'x'.repeat((2 * 1024 * 1024) + 1)}"`, { importedAtMs: 1 }),
    (error) => error?.code === 'REPORT_TOO_LARGE',
  );

  const tooManyCandidates = {
    detected: Array.from({ length: 501 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      site: 'Example Social',
      url: `https://example.com/${index + 1}`,
      username: `user-${index + 1}`,
      rate: 50,
    })),
  };

  assert.throws(
    () => parseSocialAnalyzerReport(JSON.stringify(tooManyCandidates), { importedAtMs: 1 }),
    (error) => error?.code === 'REPORT_TOO_LARGE',
  );
});

test('does not call fetch or process while parsing', () => {
  const report = JSON.stringify({
    detected: [
      {
        site: 'Example Social',
        url: 'https://example.com/alice',
        username: 'alice',
        rate: 88,
      },
    ],
  });

  const originalFetch = globalThis.fetch;
  const originalProcess = globalThis.process;
  let fetchCalls = 0;
  let processAccesses = 0;

  globalThis.fetch = (...args) => {
    fetchCalls += 1;
    return originalFetch?.(...args);
  };

  Object.defineProperty(globalThis, 'process', {
    configurable: true,
    value: new Proxy(originalProcess, {
      get(target, property, receiver) {
        processAccesses += 1;
        return Reflect.get(target, property, receiver);
      },
    }),
  });

  try {
    assert.deepEqual(parseSocialAnalyzerReport(report, {
      importedAtMs: 1_700_000_000_000,
      candidateIdFactory: () => '018f47f2-6fa8-7b01-9f30-9b6a9e676602',
    }), {
      source: 'social-analyzer',
      importedAtMs: 1_700_000_000_000,
      candidates: [
        {
          id: '018f47f2-6fa8-7b01-9f30-9b6a9e676602',
          sourceCategory: 'social-profile',
          provider: 'Example Social',
          url: 'https://example.com/alice',
          username: 'alice',
          confidence: 88,
          status: 'unverified',
          importedAtMs: 1_700_000_000_000,
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: originalProcess,
    });
  }

  assert.equal(fetchCalls, 0);
  assert.equal(processAccesses, 0);
});
