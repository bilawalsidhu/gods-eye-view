import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { watchBrowserPage } from '../../scripts/qa-browserEvidence.mjs';
const baseUrl = 'http://127.0.0.1:4195/';
const message = (type, text, url) => ({
  type: () => type,
  text: () => text,
  location: () => ({ url }),
});
test('Browser main and share pages aggregate console, runtime and crash errors', () => {
  const report = {},
    main = new EventEmitter(),
    shared = new EventEmitter();
  watchBrowserPage(main, report, { name: 'main', baseUrl });
  watchBrowserPage(shared, report, { name: 'share', baseUrl });
  main.emit('console', message('warning', 'ordinary warning', baseUrl));
  shared.emit(
    'console',
    message('error', 'late error', baseUrl + 'api/x?key=sample-secret'),
  );
  shared.emit('pageerror', new Error('runtime failure'));
  shared.emit('error', new Error('renderer crashed'));
  assert.deepEqual(report.runtimePages, ['main', 'share']);
  assert.equal(report.browserErrors.length, 3);
  assert.match(report.browserErrors[0], /\[share\] late error/);
  assert.ok(!JSON.stringify(report).includes('sample-secret'));
});
test('Browser preview exception stays exact on a share page', () => {
  const report = {},
    shared = new EventEmitter();
  watchBrowserPage(shared, report, { name: 'share', baseUrl, preview: true });
  const failure = (url) =>
    shared.emit(
      'console',
      message(
        'error',
        'Failed to load resource: the server responded with a status of 404',
        url,
      ),
    );
  failure(baseUrl + 'api/setup/status');
  failure(baseUrl + 'api/other');
  failure('https://example.invalid/api/setup/status');
  assert.deepEqual(report.expectedPreviewErrors, ['/api/setup/status: 404']);
  assert.equal(report.browserErrors.length, 2);
});
test('Browser response diagnostics retain page/status/path without query credentials', () => {
  const report = {},
    shared = new EventEmitter();
  watchBrowserPage(shared, report, { name: 'share', baseUrl });
  shared.emit('response', {
    status: () => 503,
    url: () => baseUrl + 'api/vessels?token=sample-secret',
  });
  assert.deepEqual(report.failedResponses, [
    { page: 'share', status: 503, resource: baseUrl + 'api/vessels' },
  ]);
  assert.ok(!JSON.stringify(report).includes('sample-secret'));
});
