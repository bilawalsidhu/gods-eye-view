/**
 * @module render/cesium/pickMemo
 * @description Each scene's `pick` passes made in the task running now, as
 * Cesium gave them, so a click's own Cesium picks (`nativeClick.js`) reuse
 * the query port's pick of the same pixel and window rather than draw the
 * pick buffer again. Nothing draws between them: they are forgotten once
 * the task that made them ends. No imports.
 */

/**
 * Each scene's passes in this task, by pixel and window.
 * @type {WeakMap<object, Map<string, unknown>>}
 */
let taskPicks = new WeakMap();
let clearing = false;

const keyOf = (x, y, width, height) => `${x},${y},${width},${height}`;

/**
 * Note a `pick` pass `scene.pick` just made, for `recentPick`.
 * @param {object} scene
 */
export function rememberPick(scene, x, y, width, height, picked) {
  let picks = taskPicks.get(scene);
  if (!picks) {
    picks = new Map();
    taskPicks.set(scene, picks);
  }
  picks.set(keyOf(x, y, width, height), picked);
  if (!clearing) {
    clearing = true;
    queueMicrotask(() => {
      clearing = false;
      taskPicks = new WeakMap();
    });
  }
}

/**
 * What the query port's `pick` on `scene` found at exactly this pixel and
 * window in the task running now; undefined when it made none there.
 * @param {object} scene
 * @returns {{picked: unknown} | undefined}
 */
export function recentPick(scene, x, y, width = 3, height = 3) {
  const picks = taskPicks.get(scene);
  const key = keyOf(x, y, width, height);
  return picks?.has(key) ? { picked: picks.get(key) } : undefined;
}
