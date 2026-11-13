import * as Cesium from 'cesium';
import { markRaw, toRaw } from 'vue';
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

const PARAM_STORIES = 'stories';
const PARAM_STORY = 'story';

/**
 * Stories: Explore (the story list over the person's own Cesium globe, with
 * a pin per story) and the Story player. Every story is a GEV scene played
 * through SceneDirector: the scenes GEV ships and the ones the person saved
 * to Stories from the AUTHORING panel.
 * Leaving Stories puts back the globe, camera and clock the person had.
 *
 * The share state owns the URL hash, so Stories keeps its place in the query
 * (`?stories=explore`, `?story=<id>`) and pushes one history entry per
 * screen, so Back steps Story → Explore → GEV. Closing steps back over those
 * entries, so Back after Close does not reopen Stories.
 *
 * @param {{viewer: Cesium.Viewer,
 *   director: import('../scenes/director.js').SceneDirector,
 *   store: ReturnType<typeof import('../ui/stores/stories.js').useStoriesStore>}} options
 */
export function createStoriesController({ viewer, director, store }) {
  let player = null;
  let saved = null;
  // The view a Close is about to restore, once a stopping scene has settled.
  let pendingView = null;
  let removeReadout = null;
  let destroyed = false;
  // Close steps back over Stories' own entries; the landing popstate is ours.
  let closingHistory = false;
  // A Back to Explore traversal is on its way.
  let steppingBack = false;
  // A call made while a traversal is landing runs from the entry it lands on,
  // so two traversals never stack (Close after Back to Explore would step
  // one entry too far).
  let afterTraversal = null;
  const traversing = () => steppingBack || closingHistory;
  const canvas = viewer.scene.canvas;

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
  const unsubscribeScenes = director.subscribe?.((change) => {
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
  // Steps back over Stories' entries; `landed` runs once the page Stories
  // opened from is current (or at once when Stories pushed nothing). A
  // traversal that never lands (cross-document, blocked) gives up after 2 s.
  const LANDING_LIMIT_MS = 2000;
  let landed = null;
  let landingTimer = 0;
  function finishLanding() {
    clearTimeout(landingTimer);
    const then = landed;
    landed = null;
    then?.();
  }
  function leaveHistory(then = null) {
    const steps = depth();
    if (steps > 0) {
      closingHistory = true;
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
  const onPopState = () => {
    if (destroyed) return;
    const queued = afterTraversal;
    afterTraversal = null;
    try {
      handlePopState();
    } finally {
      queued?.();
    }
  };
  function handlePopState() {
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
    if (id && storyById(id)) controller.openStory(id, { fromHistory: true });
    else if (params.has(PARAM_STORIES))
      store.mode === 'closed'
        ? controller.open({ fromHistory: true })
        : controller.backToExplore({ fromHistory: true });
    else if (store.mode !== 'closed') controller.close({ fromHistory: true });
  }
  addEventListener('popstate', onPopState);

  // ── The person's own view, kept for when Stories closes ──
  function saveView() {
    const c = viewer.camera;
    saved = {
      position: c.positionWC.clone(),
      heading: c.heading,
      pitch: c.pitch,
      roll: c.roll,
      time: viewer.clock.currentTime.clone(),
      animate: viewer.clock.shouldAnimate,
      openedAt: Date.now(),
      // The share state (layers, style, camera) as it was, for after a GEV
      // scene has changed it.
      hash: location.hash,
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
    if (!keepCamera)
      viewer.camera.setView({
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

  /** A running clock carries on as if Stories had never paused it. */
  function restoreClock(saved) {
    viewer.clock.currentTime = saved.animate
      ? Cesium.JulianDate.addSeconds(
          saved.time,
          (Date.now() - saved.openedAt) / 1000,
          new Cesium.JulianDate(),
        )
      : saved.time;
    viewer.clock.shouldAnimate = saved.animate;
  }

  // A GEV scene turns on its own layers and look. Put the person's back by
  // handing the share state saved on open to GEV's own restore, the path a
  // pasted share link takes.
  function restoreShareState(saved) {
    if (!saved?.ranScene || !saved.hash) return;
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
  let places = [];
  // Pins follow the camera on every frame it draws. A change in which pins
  // show goes through the store (Vue renders them); a move alone is written
  // straight to each pin's transform, so a flight does not re-render Explore.
  function placePins() {
    const occluder = new Cesium.EllipsoidalOccluder(
      viewer.scene.globe.ellipsoid,
      viewer.camera.positionWC,
    );
    const rect = canvas.getBoundingClientRect();
    const pins = places.map(({ id, at }) => {
      const win = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        at,
      );
      const visible = !!win && occluder.isPointVisible(at);
      return {
        id,
        x: rect.left + (win?.x ?? -9999),
        y: rect.top + (win?.y ?? -9999),
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
    const layer = document.getElementById('pins');
    const origin = layer?.getBoundingClientRect();
    if (!origin) return;
    for (const el of layer.querySelectorAll('.pin[data-id]')) {
      const n = pins.find((pin) => pin.id === el.dataset.id);
      if (!n) continue;
      el.style.transform = `translate(${n.x - origin.left}px, ${n.y - origin.top}px) translate(-50%, -100%)`;
    }
    // Kept in step for the next render, without telling Vue.
    for (let k = 0; k < pins.length; k++)
      Object.assign(toRaw(before[k]), pins[k]);
  }
  function startPins() {
    stopPins();
    places = listStories().map((s) => {
      const { lat, lon } = areaOf(s);
      return { id: s.id, at: Cesium.Cartesian3.fromDegrees(lon, lat) };
    });
    removePins = viewer.scene.postRender.addEventListener(placePins);
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
  // Cesium draws on request, so the finer tiles for a view that has just
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
    removeTiles = viewer.scene.postRender.addEventListener(() => {
      if (viewer.scene.globe?.tilesLoaded) stopSettling();
    });
    holdContinuousRender('stories-tiles');
    tilesTimer = setTimeout(stopSettling, 10000);
  }
  function flyTo({ lat, lon, alt }, duration = 1.6) {
    // The whole globe straight down; a story's place at an angle, framed in
    // the middle of the view rather than under the camera.
    if (alt > 2e6) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration,
        complete: settleTiles,
      });
      return;
    }
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat), 0),
      {
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-60),
          alt,
        ),
        duration,
        complete: settleTiles,
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

  // ── GEV scenes: the camera readout comes from Cesium ──
  let lastReadout = 0;
  function startCesiumReadout() {
    stopCesiumReadout();
    removeReadout = viewer.scene.postRender.addEventListener(() => {
      const now = performance.now();
      if (now - lastReadout < 120) return;
      lastReadout = now;
      const c = viewer.camera.positionCartographic;
      store.camera = {
        lat: Cesium.Math.toDegrees(c.latitude),
        lon: Cesium.Math.toDegrees(c.longitude),
        altKm: Math.round(c.height / 1000),
      };
    });
  }
  function stopCesiumReadout() {
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
    stopCesiumReadout();
    player?.destroy();
    player = null;
  }

  function onTick(state) {
    store.playback = {
      wallMs: state.wallMs,
      worldMs: state.worldMs,
      durationMs: state.durationMs,
      playing: state.playing,
      exploring: state.exploring,
      chapterIndex: state.chapterIndex,
    };
    if (state.playing) store.bigPlay = false;
  }

  // A story's tap plays or pauses, and a tap on empty Explore map lets go of
  // the picked story; on a phone, touching the map drops the context sheet
  // back to its peek.
  let downAt = null;
  const onDown = (e) => {
    downAt = [e.clientX, e.clientY];
    if (store.mode === 'story' && innerWidth <= 700 && store.sheet !== 'peek')
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
    if (store.playback.playing) {
      player.pause();
      store.bigPlay = true;
    } else player.play();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  /** @returns {boolean} False when the camera is not free (Cockpit). */
  function enterStories() {
    // Stories owns the camera now. The shared navigation claim releases a
    // tracked contact, orbit or flight, as a scene's does; Cockpit refuses,
    // and the policy shows GEV's own toast for it.
    const nav = director.styleManager;
    if (nav?.runImmediateNavigation?.('stories', () => true) === false)
      return false;
    if (director.running) director.stopScene();
    viewer.trackedEntity = undefined;
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
      saved = pendingView;
      pendingView = null;
    } else saveView();
    document.body.classList.add('stories-mode');
    return true;
  }

  // ── Card images: drawn once per story place from the base imagery ──
  const ESRI_IMAGERY =
    /arcgisonline\.com\/arcgis\/rest\/services\/world_imagery/i;
  const thumbKeys = new Map();
  let drawingThumbs = false;
  let thumbsAgain = false;
  async function drawThumbs() {
    // A list that changes while cards are drawing is drawn again after.
    if (drawingThumbs) return void (thumbsAgain = true);
    drawingThumbs = true;
    thumbsAgain = false;
    try {
      for (const story of listStories()) {
        if (destroyed || store.mode === 'closed') break;
        // Drawn only from the keyless Esri World Imagery, whose terms allow
        // showing it with its credit; any other imagery leaves the
        // placeholder unless the scene has its own image.
        const base = viewer.imageryLayers?.get?.(0)?.imageryProvider;
        const provider = ESRI_IMAGERY.test(base?.url ?? '') ? base : null;
        if (!provider && !story.thumb) {
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
        const key = story.thumb
          ? story.thumb.slice(-32)
          : `${c.lat},${c.lon},${c.range}`;
        if (thumbKeys.get(story.id) === key && store.thumbs?.[story.id])
          continue;
        // A card image the person captured in AUTHORING wins.
        const url = story.thumb || (await drawThumb(provider, c));
        if (!url || destroyed) continue;
        thumbKeys.set(story.id, key);
        store.thumbs = { ...store.thumbs, [story.id]: url };
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
    if (!saved?.ranScene) return frame();
    // Back from a scene: once it has torn down, the person's own layers,
    // style and clock come back before Explore frames the globe, as on
    // Close. The address keeps naming only Stories' place.
    directorSettled(director).then(() => {
      if (entry !== exploreEntry || store.mode !== 'explore' || destroyed)
        return;
      if (viewer.isDestroyed?.()) return;
      const query = location.pathname + location.search;
      restoreShareState(saved);
      if (location.hash) history.replaceState(history.state, '', query);
      restoreClock(saved);
      saved.ranScene = false;
      frame();
    });
  }

  const controller = {
    open({ fromHistory = false } = {}) {
      if (!fromHistory && traversing()) {
        afterTraversal = () => controller.open();
        return;
      }
      if (store.mode !== 'closed') return;
      if (!enterStories()) return;
      store.picked = null;
      showExplore();
      if (!fromHistory) navigate({ [PARAM_STORIES]: 'explore' }, true);
    },
    close({ fromHistory = false, keepCamera = false } = {}) {
      if (store.mode === 'closed') return;
      if (!fromHistory && traversing()) {
        afterTraversal = () => controller.close({ keepCamera });
        return;
      }
      dropPlayer();
      stopPins();
      viewer.camera.cancelFlight();
      // GEV comes back on screen now; `stories-mode` (keyboard guard, voice
      // refusal) stays until the view is back, so nothing acts on GEV under
      // a scene that is still tearing down.
      document.body.classList.remove('stories-scene');
      store.mode = 'closed';
      store.storyId = null;
      store.picked = null;
      store.expanded = false;
      const was = saved;
      saved = null;
      pendingView = was;
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
        if (pendingView !== was || destroyed || viewer.isDestroyed?.()) return;
        pendingView = null;
        document.body.classList.remove('stories-mode');
        if (!navigated) restoreView(was, { keepCamera });
        // AUTHORING shows what it showed before, unless the person opened
        // the story there.
        if (!keepCamera && was.playedScene && was.authoring)
          director.selectShot?.(was.authoring.sceneId, was.authoring.shotId);
        const afterLanding = () => {
          // Open in GEV keeps this place and look: the live view is written
          // over the earlier entry instead.
          if (!keepCamera && !navigated) restoreShareState(was);
          shareLink()?.holdWrites?.(false);
        };
        if (fromHistory) afterLanding();
        else leaveHistory(afterLanding);
      };
      return directorSettled(director).then(finish);
    },
    pick(id) {
      if (store.picked === id) return;
      const s = id ? storyById(id) : null;
      store.picked = s ? id : null;
      flyTo(s ? pickView(s) : startView(), s ? 1.6 : 1.4);
      if (s) stopTour();
      else armTour(1400 + TOUR_DWELL_MS);
    },
    /**
     * @param {string} id
     * @param {{autoplay?: boolean, fromHistory?: boolean, atMs?: number}} [opts]
     */
    openStory(id, { autoplay = false, fromHistory = false, atMs = 0 } = {}) {
      const story = storyById(id);
      if (!story) return;
      if (!fromHistory && traversing()) {
        afterTraversal = () => controller.openStory(id, { autoplay, atMs });
        return;
      }
      if (store.mode === 'closed' && !enterStories()) return;
      dropPlayer();
      stopPins();
      viewer.camera.cancelFlight();
      store.storyId = id;
      store.picked = id;
      store.mode = 'story';
      store.expanded = false;
      store.ctxOpen = false;
      store.sheet = 'peek';
      store.bigPlay = !autoplay;
      syncSceneShots(story);
      store.playback = {
        wallMs: atMs,
        worldMs: null,
        durationMs: story.durationMs,
        playing: false,
        exploring: false,
        chapterIndex: 0,
      };
      // A GEV scene plays on the person's own globe and layers.
      if (saved) saved.ranScene = saved.playedScene = true;
      // The scene's own labels, videos and cards stay visible.
      document.body.classList.add('stories-scene');
      player = createGevPlayer(director, story, { onTick });
      // Related stories show their card images too, after a link.
      drawThumbs();
      startCesiumReadout();
      // Opened paused, a scene frames its first shot (or the moment asked).
      if (atMs || !autoplay) player.seek(atMs);
      if (autoplay) player.play();
      if (!fromHistory) navigate({ [PARAM_STORY]: story.id }, true);
      if (!store.hintSeen) {
        store.hintSeen = true;
        store.flashHint(t('Drag the map to explore · Resume any time'), 4200);
      }
    },
    backToExplore({ fromHistory = false } = {}) {
      // A second press while the first is landing does nothing more.
      if (!fromHistory && traversing()) return;
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
          setTimeout(() => {
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
      }
      showExplore();
    },
    play: () => player?.play(),
    pause: () => player?.pause(),
    seek: (ms) => player?.seek(ms),
    resume: () => player?.resume(),
    focusEvent: (event) => player?.focus(event),
    get kind() {
      return player ? 'gev' : null;
    },
    /** Layout changed (panel width, sheet, feed size): place the pins again. */
    reframe() {
      if (removePins) governorRequestRender('stories-layout');
    },
    /**
     * A GEV scene leaves Stories for GEV's own Scenes panel: the globe stays
     * where the story was, and the scene and its current shot are selected
     * there for authoring.
     */
    async openInGev() {
      const s = player?.story;
      if (!s) return;
      const atMs = store.playback.wallMs;
      const shotId = s.chapters[store.playback.chapterIndex]?.id ?? null;
      player.pause();
      // After Close has settled: the scene's teardown restores GEV's look
      // and panels, which would fold the Scenes panel again.
      await controller.close({ keepCamera: true });
      director.selectShot?.(s.sceneId, shotId);
      director.styleManager?.setPanelCollapsed?.('scene-panel', false, {
        explicit: true,
      });
      store.hostedToast = {
        id: s.id,
        title: s.title,
        atMs,
        when: anchorStamp(s, atMs, null),
      };
    },
    /** The Stories place only: not the sender's camera, layers or style. */
    shareLink() {
      const here = new URL(location.href);
      const url = new URL(here.pathname, here.origin);
      for (const key of [PARAM_STORIES, PARAM_STORY])
        if (here.searchParams.has(key))
          url.searchParams.set(key, here.searchParams.get(key));
      return url.toString();
    },
    destroy() {
      if (destroyed) return;
      controller.close();
      destroyed = true;
      // Torn down mid-close: what the close would undo once settled is
      // undone now (keyboard and voice guard, held share writes).
      document.body.classList.remove('stories-mode', 'stories-scene');
      shareLink()?.holdWrites?.(false);
      unsubscribeScenes?.();
      useSavedScenes(null);
      useInstalledScenes(null);
      removeEventListener('popstate', onPopState);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerdown', onExploreInput);
      canvas.removeEventListener('pointerup', onExploreInput);
      canvas.removeEventListener('pointercancel', onExploreInput);
      canvas.removeEventListener('wheel', onExploreInput);
      stopTour();
      canvas.removeEventListener('pointerup', onUp);
    },
  };

  // A shared link opens where it points once GEV has finished loading.
  const params = new URLSearchParams(location.search);
  if (params.has(PARAM_STORY) || params.has(PARAM_STORIES)) {
    const id = params.get(PARAM_STORY);
    const started = Date.now();
    const whenReady = () => {
      if (destroyed) return;
      const loading = document.getElementById('loading-screen');
      if (
        loading &&
        !loading.classList.contains('hidden') &&
        Date.now() - started < 30000
      ) {
        setTimeout(whenReady, 300);
        return;
      }
      // A reload, or Back/Forward into a Stories entry: its history is
      // already Stories' own, so open it as it stands.
      if (history.state?.gevStories) {
        // GEV's boot wrote its share hash onto the entry: Stories' entries
        // carry none.
        const own = Object.fromEntries(
          [...params].filter(([k]) => k === PARAM_STORIES || k === PARAM_STORY),
        );
        history.replaceState(history.state, '', urlFor(own));
        if (id && storyById(id))
          controller.openStory(id, { fromHistory: true });
        else {
          controller.open({ fromHistory: true });
          if (id) store.flashToast(t('That story is not available here'));
        }
        return;
      }
      // A new link: Explore sits under a story it opens, so Back lands there.
      const landing = { stories: 'explore', depth: 0, explore: 0 };
      history.replaceState(
        { ...(history.state ?? {}), gevStories: landing },
        '',
        urlFor({ [PARAM_STORIES]: 'explore' }),
      );
      if (id && storyById(id)) controller.openStory(id);
      else {
        controller.open({ fromHistory: true });
        // A story saved on someone else's device, or no longer here.
        if (id) store.flashToast(t('That story is not available here'));
      }
    };
    setTimeout(whenReady, 300);
  }

  if (import.meta.env?.DEV) globalThis.__gevStories = { viewer, controller };
  return controller;
}
