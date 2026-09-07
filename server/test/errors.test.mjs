import assert from 'node:assert/strict';
import test from 'node:test';
import { asProblem, HttpProblem } from '../dist/errors.js';

test('maps explicit HTTP problems without leaking internals', () => {
  const problem = asProblem(new HttpProblem(404, 'Not Found', 'missing'), '/api/nope', 'cid');
  assert.deepEqual(problem, {
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: 'missing',
    instance: '/api/nope',
    correlationId: 'cid',
  });
});

test('hides unexpected error details', () => {
  const problem = asProblem(new Error('sensitive detail'), '/api/fail', 'cid');
  assert.equal(problem.status, 500);
  assert.equal(problem.detail, 'An unexpected error occurred.');
});
