import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectReflexCandidates,
  normalizeActionEpisode,
} from './actionEpisodes.js';

function episode({
  context = 'selected:local-firms',
  actions = [
    {
      name: 'open_recent_imagery',
      args: { longitude: -97.7, latitude: 30.2 },
      outcome: 'success',
    },
    {
      name: 'focus_nearest_camera',
      args: { latitude: 30.2, longitude: -97.7 },
      outcome: 'success',
    },
  ],
  correctedOrUndone = false,
  startedAt = 100,
  completedAt = 200,
} = {}) {
  return {
    contextFingerprint: context,
    actions,
    correctedOrUndone,
    startedAt,
    completedAt,
  };
}

test('episode normalization keeps only bounded semantic action receipts', () => {
  assert.deepEqual(normalizeActionEpisode(episode()), episode());
  assert.equal(
    normalizeActionEpisode(
      episode({
        actions: [
          {
            name: 'open_recent_imagery',
            args: { latitude: Number.NaN },
            outcome: 'success',
          },
        ],
      }),
    ),
    null,
  );
  assert.equal(
    normalizeActionEpisode(episode({ completedAt: 50 })),
    null,
  );
  assert.equal(
    normalizeActionEpisode(
      episode({
        actions: [{ name: 'x', args: {}, outcome: 'invented' }],
      }),
    ),
    null,
  );
});

test('exact repeated successful sequences become candidates', () => {
  const candidates = detectReflexCandidates([
    episode(),
    episode({ startedAt: 300, completedAt: 420 }),
    episode({ startedAt: 500, completedAt: 640 }),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contextFingerprint, 'selected:local-firms');
  assert.equal(candidates[0].occurrences, 3);
  assert.equal(candidates[0].verifiedSuccesses, 3);
  assert.equal(candidates[0].successRate, 1);
  assert.deepEqual(
    candidates[0].steps.map((step) => step.name),
    ['open_recent_imagery', 'focus_nearest_camera'],
  );
});

test('argument key order does not split an otherwise identical sequence', () => {
  const reversed = episode({
    actions: [
      {
        name: 'open_recent_imagery',
        args: { latitude: 30.2, longitude: -97.7 },
        outcome: 'success',
      },
      {
        name: 'focus_nearest_camera',
        args: { longitude: -97.7, latitude: 30.2 },
        outcome: 'success',
      },
    ],
    startedAt: 300,
    completedAt: 400,
  });
  const candidates = detectReflexCandidates(
    [episode(), reversed],
    { minOccurrences: 2 },
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].occurrences, 2);
});

test('context, corrections, and observed failures prevent unsafe promotion', () => {
  const differentContext = episode({
    context: 'selected:earthquakes',
    startedAt: 300,
    completedAt: 400,
  });
  assert.equal(
    detectReflexCandidates(
      [episode(), episode({ startedAt: 210, completedAt: 280 }), differentContext],
      { minOccurrences: 3 },
    ).length,
    0,
  );

  const corrected = episode({
    correctedOrUndone: true,
    startedAt: 300,
    completedAt: 400,
  });
  assert.equal(
    detectReflexCandidates(
      [episode(), episode({ startedAt: 210, completedAt: 280 }), corrected],
    ).length,
    0,
  );

  const failed = episode({
    actions: [
      {
        name: 'open_recent_imagery',
        args: { longitude: -97.7, latitude: 30.2 },
        outcome: 'failed',
      },
      {
        name: 'focus_nearest_camera',
        args: { latitude: 30.2, longitude: -97.7 },
        outcome: 'success',
      },
    ],
    startedAt: 300,
    completedAt: 400,
  });
  assert.equal(
    detectReflexCandidates(
      [episode(), episode({ startedAt: 210, completedAt: 280 }), failed],
    ).length,
    0,
  );
});
