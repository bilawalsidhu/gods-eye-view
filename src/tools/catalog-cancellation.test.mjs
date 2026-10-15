import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCatalog, defineTool } from './catalog.js';

for (const intercept of [false, true]) {
  test(`cancelled query refuses execution${intercept ? ' after an awaited interceptor' : ''}`, async () => {
    let calls = 0;
    const controller = new AbortController();
    const query = defineTool({
      name: 'fixture_query',
      kind: 'query',
      title: 'Fixture',
      description: 'Offline fixture',
      inputSchema: { type: 'object' },
      run: async () => {
        calls++;
        return { summary: 'fixture', data: {} };
      },
    });
    const catalog = composeCatalog({
      tools: [query],
      interceptors: intercept
        ? [
            async (call, next) => {
              await Promise.resolve();
              controller.abort();
              return next(call);
            },
          ]
        : [],
    });
    if (!intercept) controller.abort();
    await assert.rejects(
      catalog.call('fixture_query', {}, { signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.equal(calls, 0);
    const fresh = composeCatalog({ tools: [query] });
    assert.equal(
      (
        await fresh.call(
          'fixture_query',
          {},
          { signal: new AbortController().signal },
        )
      ).summary,
      'fixture',
    );
    assert.equal(calls, 1);
  });
}
