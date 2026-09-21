/** Register trusted scene-pack recipes and presentation adapters at composition time. */
export function createScenePackRegistry({ recipes = [], adapters = [] } = {}) {
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const rules = [...adapters];
  return {
    recipeForShot: (shot) => byId.get(shot?.sourcePackId) || null,
    minimumHoldSec(states) {
      return Math.max(
        0,
        ...rules.map((rule) => rule.minimumHoldSec?.(states) || 0),
      );
    },
    resolveVisual(shot, visual, isMapStackAvailable) {
      return rules.reduce(
        (result, rule) =>
          rule.resolveVisual?.(shot, result, isMapStackAvailable) || result,
        visual,
      );
    },
    cancelMotion(getLayerModule) {
      for (const rule of rules) rule.cancelMotion?.(getLayerModule);
    },
  };
}
