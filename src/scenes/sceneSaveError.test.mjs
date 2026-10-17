// «Scene not saved — {reason}» never shows the validator's JSON path: known
// failures read as a sentence, the rest get a general reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLocale } from '../i18n/index.js';
import {
  SceneDocumentError,
  validateSceneDocument,
} from '../director/document.js';
import { sceneSaveFailureReason } from './sceneSaveError.js';

const caught = (project) => {
  try {
    validateSceneDocument(project);
  } catch (error) {
    return error;
  }
  return assert.fail('expected a validation error');
};

test('an empty scene title is named with its 1-based scene number', () => {
  setLocale('en');
  const scenes = Array.from({ length: 7 }, (_, i) => ({
    id: `s${i}`,
    title: i === 6 ? '   ' : `Scene ${i + 1}`,
    shots: [],
  }));
  const error = caught({ version: 6, scenes });
  assert.ok(error instanceof SceneDocumentError);
  assert.equal(error.path, '$.scenes[6].title');
  assert.equal(
    sceneSaveFailureReason(error),
    'the title of scene 7 is empty or longer than 4,096 characters',
  );
});

test('a shot title names the shot and its scene', () => {
  setLocale('en');
  const error = caught({
    version: 6,
    scenes: [
      {
        id: 'a',
        title: 'A',
        shots: [{ id: 'x' }, { id: 'y', title: 'z'.repeat(4097) }],
      },
    ],
  });
  assert.equal(
    sceneSaveFailureReason(error),
    'the title of shot 2 in scene 1 is empty or longer than 4,096 characters',
  );
});

test('size and shot-count limits read as sentences', () => {
  setLocale('en');
  assert.equal(
    sceneSaveFailureReason(new SceneDocumentError('$', 'file exceeds 5 MiB')),
    'the project is larger than 5 MiB',
  );
  assert.equal(
    sceneSaveFailureReason(
      new SceneDocumentError('$.scenes[3].shots', 'too many shots in project'),
    ),
    'the project has too many shots',
  );
});

test('any other validation failure: English keeps the field, a translation never shows the path', () => {
  const errors = [
    new SceneDocumentError(
      '$.scenes[0].shots[2].layers.x.enabled',
      'expected a boolean',
    ),
    new SceneDocumentError('$.scenes[1].anchors[0].id', 'duplicate ID'),
    new Error('$.scenes[0]: odd'),
  ];
  setLocale('en');
  for (const error of errors)
    assert.equal(sceneSaveFailureReason(error), error.message);
  assert.equal(
    sceneSaveFailureReason(null),
    'the scene data failed validation',
  );
  for (const locale of ['ru', 'es']) {
    setLocale(locale);
    try {
      for (const error of [...errors, null]) {
        const text = sceneSaveFailureReason(error);
        assert.doesNotMatch(
          text,
          /\$\.|expected|duplicate|odd/,
          `${locale}: ${text}`,
        );
      }
    } finally {
      setLocale('en');
    }
  }
});
