import { SCENE_APPEND_RECIPES } from '../recipes.js';
import { createScenePackRegistry } from './registry.js';
import { nepalScenePresentation } from './nepal.js';

/** Compose the installed scene recipes and their trusted presentation rules. */
export function createDefaultScenePacks() {
  return createScenePackRegistry({
    recipes: SCENE_APPEND_RECIPES,
    adapters: [nepalScenePresentation],
  });
}
