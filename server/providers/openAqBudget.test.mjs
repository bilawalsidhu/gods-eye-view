import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqBudget } from './openAqBudget.js';
const start = Date.parse('2026-10-24T12:00:00Z');
const response = (headers, status = 200) =>
  new Response('', { status, headers });

test('shared conservative minute and hourly budgets recover when their windows expire', () => {
  let time = start;
  const budget = createOpenAqBudget(() => time);
  for (let minute = 0; minute < 40; minute++) {
    for (let i = 0; i < 45; i++) budget.take();
    assert.throws(
      () => budget.take(),
      (e) => e.status === 429,
    );
    time += 60_000;
  }
  assert.equal(budget.state().retryAt, start + 3600_000);
  assert.throws(
    () => budget.take(),
    (e) => e.status === 429,
  );
  time = start + 3600_000;
  budget.take();
  assert.equal(budget.state().remaining, 44);
});

test('provider remaining/reset headers reserve requests before 429 and resist reordered responses', () => {
  for (const reset of [
    '60',
    String((start + 60_000) / 1000),
    String(start + 60_000),
  ]) {
    let time = start;
    const budget = createOpenAqBudget(() => time);
    budget.observe(
      response({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': reset }),
    );
    budget.take();
    budget.observe(
      response({ 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': reset }),
    );
    assert.equal(budget.state().remaining, 0);
    assert.throws(
      () => budget.take(),
      (e) => e.retryAt === start + 60_000,
    );
    time += 60_000;
    budget.take();
  }
});

test('429 respects numeric and HTTP-date Retry-After, with a bounded default', () => {
  for (const retry of [
    '120',
    new Date(start + 120_000).toUTCString(),
    'invalid',
  ]) {
    let time = start;
    const budget = createOpenAqBudget(() => time);
    budget.observe(response({ 'retry-after': retry }, 429));
    const deadline = start + (retry === 'invalid' ? 60_000 : 120_000);
    assert.equal(budget.state().retryAt, deadline);
    time = deadline - 1;
    assert.throws(
      () => budget.take(),
      (e) => e.status === 429,
    );
    time++;
    budget.take();
  }
});
