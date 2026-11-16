import { markRaw, nextTick, toRaw } from 'vue';
import { t } from '../i18n/index.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { createGevPlayer, directorSettled } from './gevPlayer.js';
import { drawThumb } from './thumbs.js';
import {
  listStories,
  storyById,
  useInstalledScenes,
  useSavedScenes,
} from './catalog.js';
import { anchorStamp } from './storyMeta.js';
import { registerNavigationAuthorityListener } from '../navigationPolicy.js';
import {
  canvasOf,
  findCamera,
  findFrame,
  findGlobe,
  findQuery,
} from '../render/rendererOf.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import { stopFollowing } from '../data/followed.js';
import { worldClock } from '../time/worldClock.js';

const PARAM_STORIES = 'stories';
const PARAM_STORY = 'story';
const PARAM_STORY_TIME = 'storyTime';
const PARAM_SELECTED_STORY = 'selectedStory';

function exploreSelection(params) {
  const id = params.get(PARAM_SELECTED_STORY);
  const story = id ? storyById(id) : null;
  return story && !story.mine ? story.id : null;
}

function storyTime(params) {
  const value = params.get(PARAM_STORY_TIME);
  const ms = Number(value);
  return value && /^\d+$/.test(value) && Number.isSafeInteger(ms) ? ms : 0;
}

/**
 * Stories: Explore (the story list over the person's own globe, with
 * a pin per story) and the Story player. Every story is a GEV scene played
 * through SceneDirector: the scenes GEV ships and the ones the person saved
 * to Stories from the AUTHORING panel.
 * Leaving Stories puts back the globe, camera and world clock the person had.
 * The globe is reached only through the renderer's ports (`rendererOf.js`).
 *
 * The share state owns the URL hash, so Stories keeps its place in the query
 * (`?stories=explore`, `?story=<id>`) and pushes one history entry per
 * screen, so Back steps Story → Explore → GEV. Closing steps back over those
 * entries, so Back after Close does not reopen Stories.
 *
 * @param {{viewer: object,
 *   director: import('../scenes/director.js').SceneDirector,
 *   store: ReturnType<typeof import('../ui/stores/stories.js').useStoriesStore>,
 *   onEnter?: () => void,
 *   clock?: typeof worldClock}} options `viewer` is the scene object the
 *   renderer is bound to; `clock` is the page's world clock (tests replace
 *   it).
 */
export function createStoriesController({
  viewer,
  director,
  store,
  onEnter,
  clock = worldClock,
}) {
  let player = null;
  let saved = null;
  let entryReady = null;
  // The view a Close is about to restore, once a stopping scene has settled.
  let pendingView = null;
  // Reopening reuses the saved view, but supersedes the old close request.
  let closeGeneration = 0;
  let removeReadout = null;
  let destroyed = false;
  // Close steps back over Stories' own entries; the landing popstate is ours.
  let closingHistory = false;
  let keepLandingView = false;
  // A Back to Explore traversal is on its way.
  let steppingBack = false;
  let backTimer = 0;
  let readyTimer = 0;
  function cancelInitialLink() {
    clearTimeout(readyTimer);
    readyTimer = 0;
  }
  // A call made while a traversal is landing runs from the entry it lands on,
  // so two traversals never stack (Close after Back to Explore would step
  // one entry too far).
  let afterTraversal = null;
  const traversing = () => steppingBack || closingHistory;
  const canvas = canvasOf(viewer);
  // The renderer's ports, asked for as they are used.
  const camera = () => findCamera(viewer);
  const frame = () => findFrame(viewer);

  // The scenes the person saved to Stories (AUTHORING panel) join the list,
  // and a save or removal shows at once.
  useSavedScenes(() => [
    ...(director.storyScenes?.() ?? []),
    // The person's other scenes, as drafts only they see.
    ...(director.draftScenes?.() ?? []).map((scene) => ({
      ...scene,
      draft: true,
    })),
  ]);
  // A shipped scene lists only while it is in the person's project (it can
  // be deleted, or missing from an imported one).
  useInstalledScenes((sceneId) => director.hasScene?.(sceneId) ?? true);
  const LIST_CHANGES = new Set([
    'stories-changed',
    'scene-deleted',
    'project-imported',
    // A draft appears, changes or goes with its shots.
    'shot-captured',
    'shot-updated',
    'shot-deleted',
    // A draft's THUMBNAIL or tags.
    'story-details-changed',
  ]);
  const unsubscribeScenes = director.subscribe?.(({ change }) => {
    if (!LIST_CHANGES.has(change?.type) || destroyed) return;
    store.stories = markRaw(listStories());
    if (removePins) {
      startPins();
      drawThumbs();
      if (store.mode === 'explore' && !store.picked && !pressing)
        armTour(TOUR_DWELL_MS);
    }
  });

  // ── URL and history ──
  // Stories' own entries carry no share hash: the address bar while Stories
  // is open names the story, not the person's camera and layers.
  function urlFor(params) {
    const url = new URL(location.href);
    url.searchParams.delete(PARAM_STORIES);
    url.searchParams.delete(PARAM_STORY);
    url.searchParams.delete(PARAM_STORY_TIME);
    url.searchParams.delete(PARAM_SELECTED_STORY);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (Object.keys(params).length) url.hash = '';
    return url.toString();
  }
  const shareLink = () => director.styleManager?.shareLinkManager;
  // Each Stories entry records how many entries Stories has pushed above the
  // page it opened from (`depth`) and the depth of the nearest Explore entry
  // at or below it (`explore`), so Close and Back to Explore step back the
  // right distance whatever was opened in between.
  const depth = () => history.state?.gevStories?.depth ?? 0;
  const exploreDepth = () => {
    const own = history.state?.gevStories?.explore;
    if (own != null) return own;
    return new URLSearchParams(location.search).has(PARAM_STORIES)
      ? depth()
      : null;
  };
  function navigate(params, push) {
    const url = urlFor(params);
    if (url === location.href) return;
    const next = depth() + (push ? 1 : 0);
    const state = {
      ...(history.state ?? {}),
      gevStories: {
        ...params,
        depth: next,
        explore: params[PARAM_STORIES] ? next : exploreDepth(),
      },
    };
    if (push) history.pushState(state, '', url);
    else history.replaceState(state, '', url);
  }
  // Without Stories in the URL: the entry a Stories link landed on.
  function clearStoriesUrl() {
    const state = { ...(history.state ?? {}) };
    delete state.gevStories;
    history.replaceState(state, '', urlFor({}));
  }
  // Without the story of an entry whose story is gone.
  function dropMissingStory(params) {
    if (!params.has(PARAM_STORIES)) {
      clearStoriesUrl();
      return;
    }
    const url = new URL(location.href);
    url.searchParams.delete(PARAM_STORY);
    url.searchParams.delete(PARAM_STORY_TIME);
    const state = { ...(history.state ?? {}) };
    if (state.gevStories) {
      state.gevStories = { ...state.gevStories };
      delete state.gevStories.story;
    }
    history.replaceState(state, '', url);
  }
  // Steps back over Stories' entries; `landed` runs once the page Stories
  // opened from is current (or at once when Stories pushed nothing). A
  // traversal that never lands (cross-document, blocked) gives up after 2 s.
  const LANDING_LIMIT_MS = 2000;
  let landed = null;
  let landingTimer = 0;
  function finishLanding() {
    clearTimeout(landingTimer);
    keepLandingView = false;
    const then = landed;
    landed = null;
    then?.();
  }
  function leaveHistory(then, keepView) {
    const steps = depth();
    if (steps > 0) {
      closingHistory = true;
      keepLandingView = keepView;
      landed = then;
      clearTimeout(landingTimer);
      landingTimer = setTimeout(() => {
        if (!closingHistory) return;
        closingHistory = false;
        finishLanding();
        const queued = afterTraversal;
        afterTraversal = null;
        queued?.();
      }, LANDING_LIMIT_MS);
      history.go(-steps);
    } else {
      clearStoriesUrl();
      then?.();
    }
  }
  // Open in GEV deliberately keeps the scene view. Clear the earlier
  // entry's hash before the share manager sees popstate or hashchange;
  // releasing its write hold will put the current view at this address.
  const onLandingCapture = () => {
    if (!closingHistory || !keepLandingView || !location.hash) return;
    const url = new URL(location.href);
    if (
      url.searchParams.has(PARAM_STORY) ||
      url.searchParams.has(PARAM_STORIES)
    )
      return;
    url.hash = '';
    history.replaceState(history.state, '', url);
  };
  const onPopState = () => {
    if (destroyed) return;
    cancelInitialLink();
    const queued = afterTraversal;
    afterTraversal = null;
    try {
      handlePopState();
    } finally {
      queued?.();
    }
  };
  function handlePopState() {
    const returningToExplore = steppingBack;
    clearTimeout(backTimer);
    backTimer = 0;
    steppingBack = false;
    if (closingHistory) {
      closingHistory = false;
      if (store.mode === 'closed') {
        if (new URLSearchParams(location.search).has(PARAM_STORIES))
          clearStoriesUrl();
        finishLanding();
        return;
      }
    }
    const params = new URLSearchParams(location.search);
    const id = params.get(PARAM_STORY);
    // An entry for a story that is gone (deleted since) opens nothing, in
    // any mode; its ?story= must not stay in the address for the next share
    // link. The entry's own Explore and the globe hash stay.
    if (id && !storyById(id)) dropMissingStory(params);
    if (id && storyById(id))
      controller.openStory(id, {
        fromHistory: true,
        atMs: storyTime(params),
      });
    else if (params.has(PARAM_STORIES))
      store.mode === 'closed'
        ? controller.open({ fromHistory: true })
        : controller.backToExplore({ fromHistory: true, returningToExplore });
    else if (store.mode !== 'closed') controller.close({ fromHistory: true });
    else {
      if (pendingView) {
        // Another browser navigation landed while the scene was stopping.
        // The destination owns the globe now, so discard the earlier restore.
        pendingView = null;
        closeGeneration += 1;
        document.body.classList.remove('stories-mode');
        shareLink()?.holdWrites?.(false);
      }
    }
  }
  addEventListener('popstate', onPopState);
  addEventListener('popstate', onLandingCapture, true);

  // ── The person's own view, kept for when Stories closes ──
  function saveView() {
    const pose = camera()?.pose();
    const world = clock.getState();
    saved = {
      position: pose ? { ...pose.position } : null,
      heading: pose?.heading ?? 0,
      pitch: pose?.pitch ?? -Math.PI / 2,
      roll: pose?.roll ?? 0,
      clock: {
        live: world.live,
        timeMs: world.timeMs,
        playing: world.playing,
        rate: world.rate,
        stepping: world.stepping,
        jumps: world.jumps,
      },
      openedAt: Date.now(),
      // Story history entries have no hash. Capture the live globe state.
      hash: shareLink()?.snapshotHash?.() ?? location.hash,
      ranScene: false,
      // Whether a scene played during this visit, which selects it in
      // AUTHORING (ranScene clears once Back to Explore has undone the look).
      playedScene: false,
      // What AUTHORING had selected: playing a scene selects it there.
      authoring: director.selection?.() ?? null,
    };
  }

  function restoreView(saved, { keepCamera = false } = {}) {
    if (!saved) return;
    if (!keepCamera && saved.position)
      camera()?.setView({
        destination: saved.position,
        orientation: {
          heading: saved.heading,
          pitch: saved.pitch,
          roll: saved.roll,
        },
      });
    // Opened in GEV, the globe stays at the story's moment.
    if (keepCamera) return;
    restoreClock(saved);
  }

  /**
   * The world clock as the person left it: live stays live, and a playing
   * clock carries on as if Stories had never paused it. A clock nothing
   * moved while Stories was open (no jump, same mode and rate) is left
   * alone, so its layers see no jump.
   */
  function restoreClock(saved) {
    const was = saved?.clock;
    if (!was) return;
    const now = clock.getState();
    // Nothing moved it while Stories was open (no jump, same mode and
    // rate): a clock playing at its own pace, held by buffering or stepped
    // by a driver, is left as it is.
    if (
      Number.isFinite(was.jumps) &&
      now.jumps === was.jumps &&
      now.live === was.live &&
      now.playing === was.playing &&
      now.rate === was.rate
    )
      return;
    if (was.live) {
      if (!now.live) clock.goLive();
      return;
    }
    const at = was.playing
      ? was.timeMs + (Date.now() - saved.openedAt) * was.rate
      : was.timeMs;
    if (
      !now.live &&
      now.playing === was.playing &&
      Math.abs(now.timeMs - at) < 1000
    )
      return;
    if (!was.playing) clock.pause();
    clock.seek(at);
    if (was.playing && !now.playing)
      clock.play({ rate: was.rate, continuous: !was.stepping });
  }

  // A GEV scene turns on its own layers and look. Put the person's back by
  // handing the share state saved on open to GEV's own restore, the path a
  // pasted share link takes.
  function restoreShareState(saved) {
    if ((!saved?.ranScene && !saved?.restoreOnExit) || !saved?.hash) return;
    // Directly, not by a hashchange: the share link skips a hash it already
    // restored as Back landed, while the scene was still tearing down.
    const share = director.styleManager?.shareLinkManager;
    if (share?.restore?.(saved.hash.replace(/^#/, ''))) return;
    const url = new URL(location.href);
    url.hash = saved.hash;
    history.replaceState(history.state, '', url.toString());
    dispatchEvent(new HashChangeEvent('hashchange'));
  }

  // ── Explore on the person's globe: a pin per story, kept on its place ──
  // Where a story sits: its framed area, else its cover shot.
  const areaOf = (s) =>
    s.area ?? { lat: s.cover.lat, lon: s.cover.lon, alt: s.cover.range };
  let removePins = null;
  let pinLayer = null;
  let pinObserver = null;
  let pinOffset = null;
  let places = [];
  // Pins follow the camera on every frame it draws. A change in which pins
  // show goes through the store (Vue renders them); a move alone is written
  // straight to each pin's transform, so a flight does not re-render Explore.
  function placePins() {
    const query = findQuery(viewer);
    if (!query) return;
    if (!pinLayer) {
      pinLayer = document.getElementById('pins');
      if (pinLayer) pinOffset = null;
      if (pinLayer && globalThis.ResizeObserver) {
        pinObserver = new ResizeObserver(refreshPinLayout);
        pinObserver.observe(pinLayer);
        pinObserver.observe(canvas);
      }
    }
    if (!pinOffset) {
      const rect = canvas.getBoundingClientRect();
      const origin = pinLayer?.getBoundingClientRect();
      pinOffset = {
        x: rect.left - (origin?.left ?? 0),
        y: rect.top - (origin?.top ?? 0),
      };
    }
    const pins = places.map(({ id, at }) => {
      const win = query.project(at);
      const visible = !!win && !query.isOccluded(at);
      return {
        id,
        x: pinOffset.x + (win?.x ?? -9999),
        y: pinOffset.y + (win?.y ?? -9999),
        visible,
      };
    });
    const before = toRaw(store.pins);
    const sameSet =
      before.length === pins.length &&
      pins.every(
        (n, i) => n.id === before[i].id && n.visible === before[i].visible,
      );
    if (!sameSet) {
      store.pins = pins;
      return;
    }
    for (const el of pinLayer?.querySelectorAll('.pin[data-id]') ?? []) {
      const n = pins.find((pin) => pin.id === el.dataset.id);
      if (!n) continue;
      el.style.transform = `translate(${n.x}px, ${n.y}px) translate(-50%, -100%)`;
    }
    // Kept in step for the next render, without telling Vue.
    for (let k = 0; k < pins.length; k++)
      Object.assign(toRaw(before[k]), pins[k]);
  }
  function refreshPinLayout() {
    pinOffset = null;
    if (removePins) governorRequestRender('stories-layout');
  }
  function startPins() {
    stopPins();
    places = listStories().map((s) => {
      const { lat, lon } = areaOf(s);
      return { id: s.id, at: fromDegrees(lon, lat) };
    });
    removePins = frame()?.on('postRender', placePins) ?? (() => {});
    addEventListener('resize', refreshPinLayout);
    governorRequestRender('stories-pins');
  }
  // ── Explore's idle tour: the globe turns from one story to the next ──
  // Once a fly-in or the person's last touch has settled, Explore flies on to
  // the next story in the feed every few seconds, at the same country-level
  // view it opened at. Never with a story picked or with reduced motion, and
  // it stops on its own a minute later. Each flight asks only for its own
  // frames, and the tiles of each stop settle as any landing's do.
  const TOUR_MS = 60000;
  const TOUR_FLIGHT_S = 2.5;
  const TOUR_DWELL_MS = 6000;
  let tourTimer = 0;
  // A press on the globe is under way (a drag): nothing restarts the tour.
  let pressing = false;
  let tourUntil = 0;
  let tourIndex = 0;
  const reduceMotion = () =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ??
    false;
  const touring = () =>
    store.mode === 'explore' &&
    !store.picked &&
    !reduceMotion() &&
    !destroyed &&
    !viewer.isDestroyed?.();
  function stopTour() {
    clearTimeout(tourTimer);
    tourTimer = 0;
  }
  function tourStep() {
    tourTimer = 0;
    const list = store.stories ?? [];
    if (!touring() || Date.now() > tourUntil || list.length < 2) return;
    tourIndex = (tourIndex + 1) % list.length;
    const { lat, lon } = areaOf(list[tourIndex]);
    flyTo({ lat, lon, alt: START_ALT }, TOUR_FLIGHT_S);
    tourTimer = setTimeout(tourStep, TOUR_FLIGHT_S * 1000 + TOUR_DWELL_MS);
  }
  /** Tour on after `delayMs`, unless Explore is left or a story picked. */
  function armTour(delayMs) {
    stopTour();
    tourTimer = setTimeout(() => {
      if (!touring()) return (tourTimer = 0);
      tourUntil = Date.now() + TOUR_MS;
      tourStep();
    }, delayMs);
  }
  // A touch, drag or wheel on Explore's globe stops the tour; it goes on
  // once the person has let go for a while.
  // A press stops it outright (a drag can last any time); letting go or a
  // wheel turn starts the wait again.
  const onExploreInput = (e) => {
    pressing = e?.type === 'pointerdown';
    if (store.mode !== 'explore' || store.picked) return;
    if (pressing) stopTour();
    else armTour(TOUR_DWELL_MS);
  };
  canvas.addEventListener('pointerdown', onExploreInput);
  canvas.addEventListener('pointerup', onExploreInput);
  canvas.addEventListener('pointercancel', onExploreInput);
  canvas.addEventListener('wheel', onExploreInput, { passive: true });

  function stopPins() {
    stopTour();
    stopSettling();
    removePins?.();
    removePins = null;
    removeEventListener('resize', refreshPinLayout);
    pinObserver?.disconnect();
    pinLayer = pinObserver = pinOffset = null;
    store.pins = [];
  }
  /**
   * Where Explore opens and goes back to: country level, straight down over
   * the first story in the feed (the whole globe's centre when there is
   * none).
   */
  const START_ALT = 2.5e6;
  const WORLD_CENTRE = { lat: 22, lon: 30 };
  function startView() {
    const first = store.stories?.[0];
    const at = first ? areaOf(first) : WORLD_CENTRE;
    return { lat: at.lat, lon: at.lon, alt: START_ALT };
  }
  // The globe draws on request, so the finer tiles for a view that has just
  // landed would wait for the next change: keep frames coming until they
  // have loaded, for at most 10 s.
  let tilesTimer = 0;
  let removeTiles = null;
  function stopSettling() {
    clearTimeout(tilesTimer);
    tilesTimer = 0;
    removeTiles?.();
    removeTiles = null;
    releaseContinuousRender('stories-tiles');
  }
  function settleTiles() {
    stopSettling();
    if (destroyed || viewer.isDestroyed?.()) return;
    removeTiles =
      frame()?.on('postRender', () => {
        if (findGlobe(viewer)?.isSettled('base') === true) stopSettling();
      }) ?? null;
    holdContinuousRender('stories-tiles');
    tilesTimer = setTimeout(stopSettling, 10000);
  }
  /**
   * Where the map shows between Explore's own panels (the feed beside it on
   * a wide screen, its sheet below it on a phone): how far, in pixels, that
   * area's centre is from the canvas's, and the canvas height.
   */
  function visibleOffset() {
    const map = document
      .querySelector('#gev-stories .ex-map')
      ?.getBoundingClientRect();
    const view = canvas?.getBoundingClientRect?.();
    if (!map?.width || !map?.height || !view?.height) return null;
    return {
      right: map.left + map.width / 2 - (view.left + view.width / 2),
      up: view.top + view.height / 2 - (map.top + map.height / 2),
      height: view.height,
    };
  }
  /**
   * The point to aim at so that (lat, lon) lands in the middle of the visible
   * map rather than of the whole canvas, for a camera `distance` metres away
   * looking down at `pitch` (radians) with heading north.
   */
  function aimFor(lat, lon, distance, pitch, off = visibleOffset()) {
    if (!off || (!off.right && !off.up)) return { lat, lon };
    const fovy = camera()?.pose()?.fovy || Math.PI / 3;
    const perPx = (2 * distance * Math.tan(fovy / 2)) / off.height;
    const metresNorth = (off.up * perPx) / Math.max(0.2, Math.sin(-pitch));
    const metresEast = off.right * perPx;
    const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    return {
      lat: Math.max(-89, Math.min(89, lat - metresNorth / 111320)),
      lon: lon - metresEast / (111320 * cosLat),
    };
  }
  // The visible map can still be settling while a flight runs (the phone
  // sheet takes its height just after Explore opens): a flight that lands
  // with the map moved by more than a few pixels makes one short correction.
  const moved = (a, b) =>
    !a !== !b ||
    (a && (Math.abs(a.up - b.up) > 8 || Math.abs(a.right - b.right) > 8));
  function flyTo(place, duration = 1.6, corrected = false) {
    const { lat: lat0, lon: lon0, alt } = place;
    // The whole globe straight down; a story's place at an angle, framed in
    // the middle of the visible map rather than under the camera.
    const port = camera();
    if (!port) return;
    const top = alt > 2e6;
    const pitch = top ? -Math.PI / 2 : (-60 * Math.PI) / 180;
    const off = visibleOffset();
    const { lat, lon } = aimFor(lat0, lon0, alt, pitch, off);
    const onComplete = () => {
      if (!corrected && store.mode === 'explore' && moved(off, visibleOffset()))
        return flyTo(place, 0.5, true);
      settleTiles();
    };
    if (top) {
      port.flyTo(
        { lon, lat, height: alt },
        {
          orientation: { heading: 0, pitch, roll: 0 },
          durationS: duration,
          onComplete,
        },
      );
      return;
    }
    port.flyToBounds(
      { center: fromDegrees(lon, lat), radius: 0 },
      {
        offset: { heading: 0, pitch, range: alt },
        durationS: duration,
        onComplete,
      },
    );
  }
  /** A picked story's place, close enough to see it, far enough to place it. */
  const pickView = (s) => {
    const a = areaOf(s);
    return {
      lat: a.lat,
      lon: a.lon,
      alt: Math.min(4e6, Math.max(60000, a.alt ?? 1.6e6)),
    };
  };

  // ── GEV scenes: the camera readout comes from the renderer's camera ──
  let lastReadout = 0;
  function startCameraReadout() {
    stopCameraReadout();
    removeReadout =
      frame()?.on('postRender', () => {
        const now = performance.now();
        if (now - lastReadout < 120) return;
        lastReadout = now;
        const pose = camera()?.pose();
        if (!pose) return;
        store.camera = {
          lat: pose.lat,
          lon: pose.lon,
          altKm: Math.round(pose.height / 1000),
        };
      }) ?? null;
  }
  function stopCameraReadout() {
    removeReadout?.();
    removeReadout = null;
  }

  // A GEV scene's shots as installed (evidence packs add shots to a
  // recipe), so chapters and length match what plays.
  const untitled = (title, i) =>
    !title ||
    title === `Shot ${i + 1}` ||
    title === t('Shot {n}', { n: i + 1 });
  function syncSceneShots(story) {
    const shots = director.listShots?.(story.sceneId) ?? [];
    if (!shots.length) return;
    story.chapters = shots.map((shot, i) => ({
      id: shot.id,
      wallMs: Math.round(shot.startSec * 1000),
      shot: i + 1,
      // A shipped scene's untitled shots are named by where they go; a
      // title of the person's own stays.
      title:
        (untitled(shot.title, i) && story.places?.[i]) || shot.title || null,
      caption: '',
    }));
    const last = shots.at(-1);
    story.durationMs = Math.round((last.startSec + last.durationSec) * 1000);
    // Key moments sit on the chapters that show them.
    const fold = (text) =>
      String(text ?? '')
        .trim()
        .toLowerCase();
    story.events = (story.moments ?? []).flatMap(([color, label]) => {
      const names = new Set([fold(label), fold(t(label))]);
      const chapter = story.chapters.find((c) => names.has(fold(c.title)));
      return chapter ? [{ color, label, wallMs: chapter.wallMs }] : [];
    });
  }

  function dropPlayer() {
    document.body.classList.remove('stories-scene');
    stopCameraReadout();
    player?.destroy();
    player = null;
  }

  function onTick(state) {
    store.playback = {
      wallMs: state.wallMs,
      durationMs: state.durationMs,
      playing: state.playing,
      chapterIndex: state.chapterIndex,
    };
    if (state.playing) store.bigPlay = false;
  }

  // A story's tap plays or pauses, and a tap on empty Explore map lets go of
  // the picked story; on a phone, touching the map drops the context sheet
  // back to its peek.
  let downAt = null;
  // Whether the story was playing when the tap began: a camera move the
  // scene drives frame by frame stops on the press itself, before the tap
  // ends, and that tap still means pause. The press is read in the capture
  // phase, before the director's own listener can stop the run.
  let playingAtDown = false;
  const onDown = (e) => {
    downAt = [e.clientX, e.clientY];
    playingAtDown = store.playback.playing;
    if (store.mode === 'story' && innerWidth <= 720 && store.sheet !== 'peek')
      store.sheet = 'peek';
  };
  const onUp = (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved >= 6) return;
    if (store.mode === 'explore') {
      if (store.picked) controller.pick(null);
      return;
    }
    if (store.mode !== 'story' || !player) return;
    if (playingAtDown || store.playback.playing) {
      player.pause();
      store.bigPlay = true;
    } else player.play();
  };
  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointerup', onUp);

  /** @returns {boolean} False when the camera is not free (Cockpit). */
  function enterStories() {
    // Stories owns the camera now. The shared navigation claim releases a
    // tracked contact, orbit or flight, as a scene's does; Cockpit refuses,
    // and the policy shows GEV's own toast for it.
    const nav = director.styleManager;
    if (nav?.runImmediateNavigation?.('stories', () => true) === false)
      return false;
    const settling = director.busy || director.running;
    director.stopScene();
    stopFollowing(viewer);
    // Reopened while a scene from the last visit is still tearing down: the
    // person's view from before that visit is still the one to come back to.
    // The address keeps no share hash while Stories is open. Holding writes
    // first writes any pending view change, so the saved hash is current.
    shareLink()?.holdWrites?.(true);
    // That write lands on the current entry; when it is already Stories'
    // own (a Stories link, a reload), it carries no share hash.
    if (history.state?.gevStories && location.hash)
      history.replaceState(
        history.state,
        '',
        location.pathname + location.search,
      );
    if (pendingView) {
      saved = pendingView.view;
      pendingView = null;
    } else if (!settling) saveView();
    const generation = ++closeGeneration;
    // A temporarily unavailable card may be retried on the next visit.
    for (const id of thumbKeys.keys())
      if (!store.thumbs?.[id]) thumbKeys.delete(id);
    if (settling) {
      entryReady = directorSettled(director).then(() => {
        if (destroyed || generation !== closeGeneration) return;
        if (!saved) {
          saveView();
          saved.restoreOnExit = true;
        }
        entryReady = null;
      });
    }
    document.body.classList.add('stories-mode');
    onEnter?.();
    return true;
  }

  // ── Card images: drawn once per story place from the base imagery ──
  const ESRI_STACK = 'esri-imagery';
  const isEsri = () =>
    director.styleManager?.mapStackController?.getActiveId?.() === ESRI_STACK;
  const thumbKeys = new Map();
  let drawingThumbs = false;
  let thumbsAgain = false;
  async function drawThumbs() {
    // A list that changes while cards are drawing is drawn again after.
    if (drawingThumbs) return void (thumbsAgain = true);
    drawingThumbs = true;
    thumbsAgain = false;
    try {
      const stories = listStories();
      const currentIds = new Set(stories.map(({ id }) => id));
      for (const id of thumbKeys.keys())
        if (!currentIds.has(id)) thumbKeys.delete(id);
      const kept = Object.entries(store.thumbs ?? {}).filter(([id]) =>
        currentIds.has(id),
      );
      if (kept.length !== Object.keys(store.thumbs ?? {}).length)
        store.thumbs = Object.fromEntries(kept);
      for (const story of stories) {
        if (destroyed || store.mode === 'closed') break;
        // Drawn only from the keyless Esri World Imagery, whose terms allow
        // showing it with its credit; any other imagery leaves the
        // placeholder unless the scene has its own image.
        if (!isEsri() && !story.thumb) {
          // A card drawn from Esri earlier goes: its credit is not on
          // screen under another imagery.
          if (store.thumbs?.[story.id]) {
            const { [story.id]: _gone, ...rest } = store.thumbs;
            store.thumbs = rest;
          }
          thumbKeys.delete(story.id);
          continue;
        }
        // The place Explore frames for it, as its pin shows.
        const a = areaOf(story);
        const c = { lat: a.lat, lon: a.lon, range: a.alt };
        const key = story.thumb || `${c.lat},${c.lon},${c.range}`;
        if (thumbKeys.get(story.id) === key) continue;
        // A card image the person captured in AUTHORING wins.
        const url = story.thumb || (await drawThumb(c));
        if (destroyed || store.mode === 'closed' || !storyById(story.id))
          continue;
        if (!story.thumb && !isEsri()) continue;
        thumbKeys.set(story.id, key);
        if (url) store.thumbs = { ...store.thumbs, [story.id]: url };
        else if (store.thumbs?.[story.id]) {
          const { [story.id]: _gone, ...rest } = store.thumbs;
          store.thumbs = rest;
        }
      }
    } finally {
      drawingThumbs = false;
    }
    if (thumbsAgain && !destroyed) drawThumbs();
  }

  // Counts Explore entries, so a scene's late teardown restores the look only
  // for the Explore it was left for.
  let exploreEntry = 0;
  function showExplore() {
    // Feed lengths follow the scenes as installed.
    for (const s of listStories()) syncSceneShots(s);
    store.mode = 'explore';
    store.storyId = null;
    startPins();
    const entry = ++exploreEntry;
    const frame = () => {
      const s = store.picked && storyById(store.picked);
      flyTo(s ? pickView(s) : startView());
      // The tour starts from the story the fly-in landed on.
      if (!s) {
        tourIndex = 0;
        armTour(1600 + TOUR_DWELL_MS);
      }
      // Cards are drawn from the person's own imagery, so after their look
      // is back.
      drawThumbs();
    };
    // The aim centres the story in Explore's visible map, which is measured
    // once Explore has rendered.
    const root = document.getElementById('gev-stories');
    const whenLaidOut = (run) =>
      root && !root.querySelector('.ex-map')
        ? nextTick(() => {
            if (entry === exploreEntry && store.mode === 'explore') run();
          })
        : run();
    // Back from a scene: once it has torn down, the person's own layers,
    // style and clock come back before Explore frames the globe, as on
    // Close. The address keeps naming only Stories' place.
    const settled = () => {
      if (entry !== exploreEntry || store.mode !== 'explore' || destroyed)
        return;
      if (viewer.isDestroyed?.()) return;
      if (saved?.ranScene) {
        const query = location.pathname + location.search;
        restoreShareState(saved);
        if (location.hash) history.replaceState(history.state, '', query);
        restoreClock(saved);
        saved.ranScene = false;
      }
      whenLaidOut(frame);
    };
    if (entryReady) return entryReady.then(settled);
    if (saved?.ranScene) return directorSettled(director).then(settled);
    return whenLaidOut(frame);
  }

  async function openInAuthoring(story, shotId, atMs) {
    const closing = controller.close({ keepCamera: true });
    if (!closing) return;
    const generation = closeGeneration;
    await closing;
    if (destroyed || generation !== closeGeneration) return;
    director.selectShot?.(story.sceneId, shotId);
    director.styleManager?.setPanelCollapsed?.('scene-panel', false, {
      explicit: true,
    });
    store.openedToast = {
      id: story.id,
      title: story.title,
      atMs,
      when: anchorStamp(story, atMs),
    };
  }

  const controller = {
    open({ fromHistory = false, isCurrent } = {}) {
      if (destroyed || (isCurrent && !isCurrent())) return false;
      cancelInitialLink();
      if (!fromHistory && traversing()) {
        if (!isCurrent) afterTraversal = () => controller.open();
        return false;
      }
      if (store.mode !== 'closed' || !enterStories()) return false;
      store.picked = fromHistory
        ? exploreSelection(new URLSearchParams(location.search))
        : null;
      showExplore();
      if (!fromHistory) navigate({ [PARAM_STORIES]: 'explore' }, true);
      return true;
    },
    close({ fromHistory = false, keepCamera = false } = {}) {
      if (destroyed) return;
      cancelInitialLink();
      if (store.mode === 'closed') return;
      if (!fromHistory && traversing()) {
        afterTraversal = () => controller.close({ keepCamera });
        return;
      }
      const generation = ++closeGeneration;
      entryReady = null;
      dropPlayer();
      stopPins();
      camera()?.cancelFlight();
      // Close the Stories screens now and keep their input guard until the
      // scene and share view have finished restoring.
      document.body.classList.remove('stories-scene');
      store.mode = 'closed';
      store.storyId = null;
      store.picked = null;
      store.expanded = false;
      store.toast = '';
      const was = saved;
      saved = null;
      const pending = { view: was };
      pendingView = pending;
      // A camera owner that takes over during the wait (the person dragging
      // the globe, a layer's focus) keeps the camera: no snap back.
      let navigated = false;
      const onDrag = () => (navigated = true);
      canvas.addEventListener('pointerdown', onDrag);
      const stopWatching = registerNavigationAuthorityListener(
        globalThis.window,
        onDrag,
      );
      // Wait until the director is idle (a stopped scene, or one still
      // tearing down from before a quick reopen, has released its camera,
      // layers and look); put the camera and clock back; step history back
      // over Stories' entries; then, once that has landed, put the share
      // state back and let the address follow the live view again.
      const finish = () => {
        canvas.removeEventListener('pointerdown', onDrag);
        stopWatching();
        // Reopened meanwhile (the reopen took `was` over), or torn down.
        if (
          generation !== closeGeneration ||
          pendingView !== pending ||
          destroyed ||
          viewer.isDestroyed?.()
        )
          return;
        pendingView = null;
        if (!navigated) restoreView(was, { keepCamera });
        // AUTHORING shows what it showed before, unless the person opened
        // the story there.
        if (!keepCamera && was?.playedScene && was.authoring)
          director.selectShot?.(was.authoring.sceneId, was.authoring.shotId);
        const afterLanding = () => {
          // Open in GEV keeps this place and look: the live view is written
          // over the earlier entry instead.
          if (!keepCamera && !navigated) {
            restoreShareState(was);
            // A shared world time arrives paused: a clock that was playing
            // plays on, as on Back to Explore.
            restoreClock(was);
          }
          shareLink()?.holdWrites?.(false);
          document.body.classList.remove('stories-mode');
        };
        if (fromHistory) afterLanding();
        else leaveHistory(afterLanding, keepCamera || navigated);
      };
      return directorSettled(director).then(finish);
    },
    pick(id) {
      if (store.picked === id) return;
      const s = id ? storyById(id) : null;
      store.picked = s ? id : null;
      if (entryReady) return;
      flyTo(s ? pickView(s) : startView(), s ? 1.6 : 1.4);
      if (s) stopTour();
      else armTour(1400 + TOUR_DWELL_MS);
    },
    /**
     * @param {string} id
     * @param {{autoplay?: boolean, fromHistory?: boolean, atMs?: number}} [opts]
     */
    openStory(id, { autoplay = false, fromHistory = false, atMs = 0 } = {}) {
      if (destroyed) return;
      cancelInitialLink();
      const story = storyById(id);
      if (!story) return;
      if (!fromHistory && traversing()) {
        afterTraversal = () => controller.openStory(id, { autoplay, atMs });
        return;
      }
      if (store.mode === 'closed' && !enterStories()) return;
      dropPlayer();
      stopPins();
      camera()?.cancelFlight();
      store.storyId = id;
      store.picked = id;
      store.mode = 'story';
      store.expanded = false;
      store.ctxOpen = false;
      store.sheet = 'peek';
      store.bigPlay = !autoplay;
      syncSceneShots(story);
      atMs = Number.isFinite(atMs)
        ? Math.max(0, Math.min(story.durationMs, Math.round(atMs)))
        : 0;
      store.playback = {
        wallMs: atMs,
        durationMs: story.durationMs,
        playing: false,
        chapterIndex: 0,
      };
      const start = () => {
        // A GEV scene plays on the person's own globe and layers.
        if (saved) saved.ranScene = saved.playedScene = true;
        document.body.classList.add('stories-scene');
        player = createGevPlayer(director, story, { onTick });
        drawThumbs();
        startCameraReadout();
        // Explore may have restored a different look while this shot
        // remained selected. Reopening restores the authored look too.
        if (atMs || !autoplay) player.seek(atMs, { reloadShot: true });
        if (autoplay) player.play();
      };
      if (entryReady) {
        const opening = store.playback;
        entryReady.then(() => {
          if (
            !destroyed &&
            store.mode === 'story' &&
            store.playback === opening
          )
            start();
        });
      } else start();
      if (!fromHistory)
        navigate(
          atMs
            ? { [PARAM_STORY]: story.id, [PARAM_STORY_TIME]: atMs }
            : { [PARAM_STORY]: story.id },
          true,
        );
      if (!store.hintSeen) {
        store.hintSeen = true;
        store.flashHint(t('Drag the map to explore · Resume any time'), 4200);
      }
    },
    backToExplore({ fromHistory = false, returningToExplore = false } = {}) {
      if (destroyed) return;
      cancelInitialLink();
      // A second Back keeps the traversal and clears the queued action.
      if (!fromHistory && traversing()) {
        if (steppingBack) afterTraversal = null;
        return;
      }
      dropPlayer();
      store.expanded = false;
      if (!fromHistory) {
        // Back to Explore steps back to the Explore entry this story sits
        // on, past any related stories opened since; a story with no
        // Explore below it (a link) gets one.
        const params = new URLSearchParams(location.search);
        const to = exploreDepth();
        if (params.has(PARAM_STORY) && to != null && depth() > to) {
          steppingBack = true;
          // A step that never lands gives up, as Close's does.
          clearTimeout(backTimer);
          backTimer = setTimeout(() => {
            backTimer = 0;
            if (!steppingBack) return;
            steppingBack = false;
            const queued = afterTraversal;
            afterTraversal = null;
            queued?.();
          }, LANDING_LIMIT_MS);
          history.go(to - depth());
          return;
        }
        navigate({ [PARAM_STORIES]: 'explore' }, true);
      } else {
        const params = new URLSearchParams(location.search);
        if (returningToExplore && params.has(PARAM_SELECTED_STORY)) {
          const story = store.picked && storyById(store.picked);
          navigate(
            story && !story.mine
              ? { [PARAM_STORIES]: 'explore', [PARAM_SELECTED_STORY]: story.id }
              : { [PARAM_STORIES]: 'explore' },
            false,
          );
        } else if (params.has(PARAM_SELECTED_STORY)) {
          store.picked = exploreSelection(params);
        }
      }
      showExplore();
    },
    play: () => player?.play(),
    pause: () => player?.pause(),
    seek: (ms) => player?.seek(ms),
    focusEvent: (event) => player?.focus(event),
    get kind() {
      return player ? 'gev' : null;
    },
    /** Layout changed (panel width, sheet, feed size): place the pins again. */
    reframe: refreshPinLayout,
    /**
     * A GEV scene leaves Stories for GEV's own Scenes panel: the globe stays
     * where the story was, and the scene and its current shot are selected
     * there for authoring.
     */
    async openInGev() {
      const s = store.storyId && storyById(store.storyId);
      if (!s) return;
      const atMs = store.playback.wallMs;
      const shotId = s.chapters[store.playback.chapterIndex]?.id ?? null;
      if (steppingBack) {
        afterTraversal = () => openInAuthoring(s, shotId, atMs);
        return;
      }
      if (entryReady) {
        await entryReady;
        if (destroyed || player?.story !== s) return;
      }
      player?.pause();
      return openInAuthoring(s, shotId, atMs);
    },
    /** The Stories place only: not the sender's camera, layers or style. */
    shareLink() {
      const here = new URL(location.href);
      const url = new URL(here.pathname, here.origin);
      const id = store.mode === 'story' ? store.storyId : store.picked;
      const story = id ? storyById(id) : null;
      if (store.mode === 'story' && story && !story.mine) {
        url.searchParams.set(PARAM_STORY, story.id);
        const ms = Math.round(store.playback.wallMs);
        if (Number.isSafeInteger(ms) && ms > 0)
          url.searchParams.set(PARAM_STORY_TIME, String(ms));
      } else {
        url.searchParams.set(PARAM_STORIES, 'explore');
        if (story && !story.mine)
          url.searchParams.set(PARAM_SELECTED_STORY, story.id);
      }
      return url.toString();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      entryReady = null;
      cancelInitialLink();
      clearTimeout(backTimer);
      clearTimeout(landingTimer);
      steppingBack = closingHistory = false;
      keepLandingView = false;
      afterTraversal = landed = null;
      dropPlayer();
      stopPins();
      camera()?.cancelFlight();
      store.mode = 'closed';
      store.storyId = null;
      store.picked = null;
      store.expanded = false;
      // Torn down mid-close: what the close would undo once settled is
      // undone now (keyboard and voice guard, held share writes).
      document.body.classList.remove('stories-mode', 'stories-scene');
      shareLink()?.holdWrites?.(false);
      unsubscribeScenes?.();
      useSavedScenes(null);
      useInstalledScenes(null);
      removeEventListener('popstate', onPopState);
      removeEventListener('popstate', onLandingCapture, true);
      canvas.removeEventListener('pointerdown', onDown, true);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerdown', onExploreInput);
      canvas.removeEventListener('pointerup', onExploreInput);
      canvas.removeEventListener('pointercancel', onExploreInput);
      canvas.removeEventListener('wheel', onExploreInput);
      canvas.removeEventListener('pointerup', onUp);
    },
  };

  // A shared link opens where it points once GEV has finished loading.
  const params = new URLSearchParams(location.search);
  if (params.has(PARAM_STORY) || params.has(PARAM_STORIES)) {
    const started = Date.now();
    const whenReady = () => {
      readyTimer = 0;
      if (destroyed) return;
      const params = new URLSearchParams(location.search);
      if (!params.has(PARAM_STORY) && !params.has(PARAM_STORIES)) return;
      const id = params.get(PARAM_STORY);
      const atMs = storyTime(params);
      const loading = document.getElementById('loading-screen');
      if (
        loading &&
        !loading.classList.contains('hidden') &&
        Date.now() - started < 30000
      ) {
        readyTimer = setTimeout(whenReady, 300);
        return;
      }
      // A reload, or Back/Forward into a Stories entry: its history is
      // already Stories' own, so open it as it stands.
      if (history.state?.gevStories) {
        // GEV's boot wrote its share hash onto the entry: Stories' entries
        // carry none.
        const own = Object.fromEntries(
          [...params].filter(
            ([key]) =>
              key === PARAM_STORIES ||
              key === PARAM_STORY ||
              (key === PARAM_STORY_TIME && id && atMs) ||
              (key === PARAM_SELECTED_STORY &&
                !id &&
                params.has(PARAM_STORIES)),
          ),
        );
        history.replaceState(history.state, '', urlFor(own));
        if (id && storyById(id))
          controller.openStory(id, { fromHistory: true, atMs });
        else {
          controller.open({ fromHistory: true });
          if (id) store.flashToast(t('That story is not available here'));
        }
        return;
      }
      // A new link: Explore sits under a story it opens, so Back lands there.
      const landing = { stories: 'explore', depth: 0, explore: 0 };
      const selected =
        !id && params.has(PARAM_STORIES) ? exploreSelection(params) : null;
      history.replaceState(
        { ...(history.state ?? {}), gevStories: landing },
        '',
        urlFor({
          [PARAM_STORIES]: 'explore',
          ...(selected ? { [PARAM_SELECTED_STORY]: selected } : {}),
        }),
      );
      if (id && storyById(id)) controller.openStory(id, { atMs });
      else {
        controller.open({ fromHistory: true });
        // A story saved on someone else's device, or no longer here.
        if (id) store.flashToast(t('That story is not available here'));
      }
    };
    readyTimer = setTimeout(whenReady, 300);
  }

  if (import.meta.env?.DEV) globalThis.__gevStories = { viewer, controller };
  return controller;
}
