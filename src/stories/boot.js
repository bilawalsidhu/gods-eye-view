const STORIES_PARAMS = ['stories', 'story'];
const wantsStories = () => {
  const params = new URLSearchParams(location.search);
  return STORIES_PARAMS.some((p) => params.has(p));
};

/**
 * Stories, loaded on first use. The controller, the story catalog, the
 * screens and their styles are separate chunks, fetched when the person
 * opens Stories, follows a Stories link or
 * steps into Stories with Back or Forward. Until then the store holds this
 * shell, whose calls load the controller and then run.
 *
 * @param {{viewer: import('cesium').Viewer,
 *   director: import('../scenes/director.js').SceneDirector,
 *   store: ReturnType<typeof import('../ui/stores/stories.js').useStoriesStore>,
 *   onLoadFailed?: () => void,
 *   loadModules?: () => Promise<[object, object]>}} options `onLoadFailed`
 *   tells the person a click did nothing because Stories could not load;
 *   `available` is false where Stories is not offered (an inline embed:
 *   its URL and history are the host page's);
 *   `loadModules` fetches the controller, catalog and Stories' styles
 *   (tests replace it).
 */
export function bootStories({
  viewer,
  director,
  store,
  onLoadFailed,
  available = true,
  loadModules = () =>
    Promise.all([
      import('./controller.js'),
      import('./catalog.js'),
      // Stories' screen styles, in place before the screens show, and the
      // screens themselves, so opening does not wait on a second fetch.
      import('../ui/styles/stories.css'),
      import('../ui/views/stories/ExploreScreen.vue'),
      import('../ui/views/stories/StoryScreen.vue'),
    ]),
}) {
  store.available = available;
  if (!available) {
    const off = {
      open: async () => {},
      openStory: async () => {},
      backToExplore: async () => {},
      close: () => {},
      reframe: () => {},
      kind: null,
      load: async () => null,
      destroy: () => {},
    };
    store.connect(off, []);
    return off;
  }
  let real = null;
  let loading = null;
  let destroyed = false;

  function load() {
    loading ??= loadModules().then(
      ([{ createStoriesController }, { listStories }]) => {
        if (destroyed) return null;
        removeEventListener('popstate', onPopState);
        real = createStoriesController({
          viewer,
          director,
          store,
        });
        store.connect(real, listStories());
        return real;
      },
    );
    // A failed fetch (offline, or a deploy replaced the chunk) is reported
    // once, whatever asked (a click, a link, Back or Forward), and not kept:
    // the next attempt tries again.
    loading.catch((error) => {
      loading = null;
      console.warn('Stories could not load', error);
      onLoadFailed?.();
    });
    return loading;
  }
  // The controller reads a Stories link on creation and opens it.
  const onPopState = () => {
    if (wantsStories()) load();
  };
  addEventListener('popstate', onPopState);
  if (wantsStories()) load();

  const later =
    (name) =>
    (...args) =>
      load().then(
        (c) => c?.[name](...args),
        () => {}, // reported by load()
      );
  const shell = {
    open: later('open'),
    openStory: later('openStory'),
    backToExplore: later('backToExplore'),
    close: () => real?.close(),
    reframe: () => real?.reframe(),
    get kind() {
      return real?.kind ?? null;
    },
    /** Resolves to the controller once it has loaded. */
    load,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeEventListener('popstate', onPopState);
      real?.destroy();
    },
  };
  store.connect(shell, []);
  return shell;
}
