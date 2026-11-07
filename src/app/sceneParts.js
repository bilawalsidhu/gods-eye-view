// Parts of the application bound to one globe engine (see sceneHost.js).
// A page that switches engines gives its phases a scene with a `sceneHost`:
// each part registers there and attaches to every engine the page shows.
// A host that never switches gives a plain scene: the part attaches to it
// once and detaches with the application.

/** The concrete scene a phase was built on (a switching scene's current one). */
export function currentSceneOf(scene) {
  return typeof scene?.current === 'function' ? scene.current() : scene;
}

/**
 * Attach `part` ({ name, attachScene(scene, { signal, defer }),
 * detachScene(options) }) to `scene` and keep it attached for the
 * application: through the scene host when the page switches engines,
 * else once, released by the phase's `defer`. Resolves with the first
 * attachment's result.
 */
export function attachScenePart(scene, part, { defer }) {
  if (scene?.sceneHost)
    return scene.sceneHost.register(part, scene.transaction);
  const controller = new AbortController();
  const cleanups = [];
  defer(async () => {
    controller.abort();
    const errors = [];
    while (cleanups.length) {
      try {
        await cleanups.pop()();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await part.detachScene?.({ handoff: false });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, `${part.name} could not detach`);
  });
  return part.attachScene?.(scene, {
    signal: controller.signal,
    defer(cleanup) {
      if (typeof cleanup !== 'function')
        throw new TypeError('A scene part defers a function');
      cleanups.push(cleanup);
    },
  });
}

/**
 * Detach every part when the application is torn down, before the phase's
 * own session cleanup runs (a no-op without a scene host, or once detached).
 */
export function detachPartsOnTeardown(scene, defer, options) {
  const host = scene?.sceneHost;
  if (!host) return;
  defer(() =>
    host.detach(
      typeof options === 'function' ? options() : options,
      scene.transaction,
    ),
  );
}
