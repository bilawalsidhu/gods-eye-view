// Display helpers must not rewrite operator-typed scene/shot titles: only the
// generated "Scene N" / "Shot N" and the titles of recipe-sourced shots
// localize; everything else shows exactly as stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_RECIPES,
  displaySceneTitle,
  displayShotTitle,
} from './recipes.js';
import { setLocale } from '../i18n/index.js';

test.afterEach(() => setLocale('en'));

test('user-typed numbered titles keep their digits in en', () => {
  setLocale('en');
  assert.equal(
    displaySceneTitle({ id: 'scene-user', title: 'Scene 007' }),
    'Scene 007',
  );
  assert.equal(displayShotTitle('Shot 01'), 'Shot 01');
  // default generated names still work
  assert.equal(
    displaySceneTitle({ id: 'scene-user', title: 'Scene 3' }),
    'Scene 3',
  );
  assert.equal(displayShotTitle('Shot 2'), 'Shot 2');
});

test('generated numbered titles localize, typed ones with leading zeros do not', () => {
  setLocale('ru');
  assert.equal(
    displaySceneTitle({ id: 'scene-user', title: 'Scene 3' }),
    'Сцена 3',
  );
  assert.equal(displayShotTitle('Shot 2'), 'Кадр 2');
  assert.equal(
    displaySceneTitle({ id: 'scene-user', title: 'Scene 007' }),
    'Scene 007',
  );
  assert.equal(displayShotTitle('Shot 01'), 'Shot 01');
});

test('a built-in shot title localizes only for a recipe-sourced shot', () => {
  setLocale('ru');
  // A built-in shot title (BUILTIN_SHOT_TITLES in recipes.js).
  const title = 'Final view';
  const userScene = { id: 'scene-user' };
  // Operator-typed title that happens to match a built-in one: shown as typed.
  assert.equal(
    displayShotTitle(title, { id: 'shot-user', title }, userScene),
    title,
  );
  // A recipe-sourced shot: localized.
  const fromRecipe = displayShotTitle(
    title,
    { id: 'shot-recipe', title, sourcePackId: 'bhote-koshi-nepal-scene' },
    userScene,
  );
  assert.notEqual(fromRecipe, title);
  // Without provenance the title alone decides.
  assert.equal(displayShotTitle(title), fromRecipe);
  // A project saved before shots recorded their source pack: the scene's
  // recipe still vouches for a title its keyframes declare (only when such a
  // recipe ships in this build).
  const named = (keyframe) =>
    keyframe?.title && !/^Shot \d+$/.test(keyframe.title);
  const recipe = SCENE_RECIPES.find((item) => item.cameraPath?.some(named));
  if (recipe) {
    const declared = recipe.cameraPath.find(named).title;
    assert.equal(
      displayShotTitle(
        declared,
        { id: 'shot-old', title: declared },
        { id: recipe.id },
      ),
      displayShotTitle(declared),
    );
    assert.equal(
      displayShotTitle(
        declared,
        { id: 'shot-old', title: declared },
        userScene,
      ),
      declared,
    );
  }
});

test('the Scene status line shows an operator-typed shot title as typed', async () => {
  const { createScenePlaybackAdapter } = await import('./playbackAdapter.js');
  const statuses = [];
  const director = {
    _renderSceneSelect() {},
    _renderShotList() {},
    _updateStatus: (text) => statuses.push(text),
    _logEvent() {},
  };
  const adapter = createScenePlaybackAdapter(director, 4);
  const title = 'Final view';
  const scene = { id: 'scene-user', title: 'Scene 1', shots: [] };
  setLocale('ru');
  adapter.selectShot({
    scene,
    shot: { id: 'shot-user', title },
    index: 0,
    total: 1,
  });
  adapter.selectShot({
    scene,
    shot: { id: 'shot-recipe', title, sourcePackId: 'bhote-koshi-nepal-scene' },
    index: 0,
    total: 1,
  });
  assert.ok(statuses[0].endsWith(` / ${title}`), statuses[0]);
  assert.ok(
    statuses[1].endsWith(` / ${displayShotTitle(title)}`) &&
      !statuses[1].endsWith(` / ${title}`),
    statuses[1],
  );
});

test('the scene context of a shot carries its display title by provenance', async () => {
  const { layerStatesForShot } = await import('./shotPresentation.js');
  const title = 'Final view';
  const packs = { recipeForShot: () => null, minimumHoldSec: () => 0 };
  const contextFor = (shot) => {
    const scene = { id: 'scene-user', title: 'Scene 1', shots: [shot] };
    const states = layerStatesForShot(
      scene,
      { ...shot, layers: { a: { params: { presentation: 'scene-beat' } } } },
      packs,
    );
    return states.a.params.sceneContext;
  };
  setLocale('ru');
  assert.equal(contextFor({ id: 'u', title }).shotDisplayTitle, title);
  assert.notEqual(
    contextFor({ id: 'r', title, sourcePackId: 'bhote-koshi-nepal-scene' })
      .shotDisplayTitle,
    title,
  );
});
