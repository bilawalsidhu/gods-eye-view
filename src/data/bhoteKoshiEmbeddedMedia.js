import * as Cesium from 'cesium';
import { appendIcon } from '../ui/icons/layerIcon.js';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);
const FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
  'fb.watch',
  'www.fb.watch',
]);
const X_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
]);
const X_WIDGET_URL = 'https://platform.twitter.com/widgets.js';
const FACEBOOK_SDK_ID = 'facebook-jssdk';
const FACEBOOK_SDK_URL =
  'https://connect.facebook.net/en_US/sdk.js#xfbml=0&version=v24.0';
const EMBED_TIMEOUT_MS = 15000;
const CARD_EXIT_DURATION_MS = 620;
const MEDIA_PRECONNECT_ORIGINS = Object.freeze({
  youtube: Object.freeze([
    'https://www.youtube-nocookie.com',
    'https://www.youtube.com',
    'https://i.ytimg.com',
  ]),
  facebook: Object.freeze(['https://www.facebook.com']),
});

let _xWidgetsPromise = null;
let _facebookSdkPromise = null;
let _facebookEmbedSequence = 0;
const youtubeApis = new WeakMap();

function loadYouTubeApi(documentRef, globalRef) {
  if (typeof globalRef.YT?.Player === 'function')
    return Promise.resolve(globalRef.YT);
  if (youtubeApis.has(documentRef)) return youtubeApis.get(documentRef);
  const pending = new Promise((resolve, reject) => {
    const previous = globalRef.onYouTubeIframeAPIReady;
    let timer;
    let settled = false;
    const script = documentRef.createElement('script');
    const finish = (error) => {
      if (settled) return;
      settled = true;
      globalRef.clearTimeout(timer);
      if (globalRef.onYouTubeIframeAPIReady === ready)
        globalRef.onYouTubeIframeAPIReady = previous;
      if (error) {
        script.remove();
        reject(error);
      } else resolve(globalRef.YT);
    };
    const ready = () => {
      try {
        previous?.();
      } finally {
        finish(
          typeof globalRef.YT?.Player === 'function'
            ? null
            : new Error('YouTube API unavailable'),
        );
      }
    };
    globalRef.onYouTubeIframeAPIReady = ready;
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.addEventListener(
      'error',
      () => finish(new Error('YouTube API unavailable')),
      { once: true },
    );
    timer = globalRef.setTimeout(
      () => finish(new Error('YouTube API timed out')),
      5000,
    );
    documentRef.head.append(script);
  }).catch((error) => {
    youtubeApis.delete(documentRef);
    throw error;
  });
  youtubeApis.set(documentRef, pending);
  return pending;
}

/** A trimmed clip follows provider time, never time spent loading its iframe. */
export function createTrimmedYouTubePlayback({
  iframe,
  endAtSec,
  startAtSec = 0,
  loadApi,
  globalRef = globalThis,
  isCurrent = () => true,
  onStatus = () => {},
}) {
  let player = null;
  let phase = 'starting';
  let active = true;
  let started = false;
  let currentTime = startAtSec;
  let poll = null;
  let deadline = null;
  const live = () =>
    active && isCurrent() && ['starting', 'playing'].includes(phase);
  const clear = () => {
    globalRef.clearTimeout(deadline);
    globalRef.clearTimeout(poll);
    deadline = poll = null;
  };
  const finish = (outcome) => {
    if (!live()) return;
    phase = outcome;
    clear();
    try {
      player?.pauseVideo?.();
    } catch {
      /* Removed provider frame. */
    }
    onStatus(outcome);
  };
  const sample = (stateHint) => {
    if (!live()) return;
    globalRef.clearTimeout(poll);
    poll = null;
    try {
      const previousTime = currentTime;
      const time = player?.getCurrentTime?.();
      if (Number.isFinite(time)) currentTime = time;
      const state = stateHint ?? player?.getPlayerState?.();
      if (
        currentTime >= endAtSec ||
        (state === 0 && currentTime >= endAtSec - 0.1)
      ) {
        finish('completed');
        return;
      }
      if (state === 0) {
        finish('unavailable');
        return;
      }
      // Autoplay can begin before the API attaches, without a new PLAYING edge.
      if (!started && (state === 1 || currentTime > previousTime)) {
        started = true;
        phase = 'playing';
        globalRef.clearTimeout(deadline);
        deadline = globalRef.setTimeout(
          () => finish('timeout'),
          (endAtSec - startAtSec) * 1000 + 5000,
        );
      }
    } catch {
      finish('unavailable');
      return;
    }
    poll = globalRef.setTimeout(() => sample(), 100);
  };
  deadline = globalRef.setTimeout(() => finish('timeout'), 5000);
  Promise.resolve()
    .then(loadApi)
    .then((api) => {
      if (!live()) return;
      player = new api.Player(iframe, {
        events: {
          onReady(event) {
            if (!live()) return;
            player = event.target;
            sample();
            if (!live()) return;
            try {
              event.target.mute();
              event.target.playVideo();
            } catch {
              finish('unavailable');
            }
          },
          onStateChange(event) {
            if (!live()) return;
            if (event.target) player = event.target;
            sample(event.data);
          },
          onError: () => finish('unavailable'),
          onAutoplayBlocked: () => finish('blocked'),
        },
      });
    })
    .catch(() => finish('unavailable'));
  return {
    getState: () => ({ phase, currentTime }),
    destroy() {
      active = false;
      phase = 'cancelled';
      clear();
      try {
        player?.destroy?.();
      } catch {
        /* Detached frame already released. */
      }
      player = null;
    },
  };
}

function facebookSdkReady(api) {
  return (
    typeof api?.XFBML?.parse === 'function' &&
    typeof api?.Event?.subscribe === 'function'
  );
}

function loadFacebookSdk(documentRef, globalRef = globalThis) {
  if (facebookSdkReady(globalRef.FB)) return Promise.resolve(globalRef.FB);
  if (_facebookSdkPromise) return _facebookSdkPromise;
  _facebookSdkPromise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const prior = globalRef.fbAsyncInit;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      globalRef.clearTimeout?.(timer);
      if (globalRef.fbAsyncInit === ready) globalRef.fbAsyncInit = prior;
      if (error) reject(error);
      else resolve(globalRef.FB);
    };
    const ready = () => {
      try {
        prior?.();
      } finally {
        if (facebookSdkReady(globalRef.FB)) finish();
        else finish(new Error('Facebook player API did not initialize.'));
      }
    };
    globalRef.fbAsyncInit = ready;
    let script = documentRef.getElementById?.(FACEBOOK_SDK_ID);
    if (!script) {
      script = documentRef.createElement('script');
      script.id = FACEBOOK_SDK_ID;
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      script.src = FACEBOOK_SDK_URL;
      documentRef.head?.append(script);
    }
    script.addEventListener?.(
      'error',
      () => finish(new Error('Facebook player API could not load.')),
      { once: true },
    );
    timer =
      globalRef.setTimeout?.(
        () => finish(new Error('Facebook player API timed out.')),
        EMBED_TIMEOUT_MS,
      ) ?? null;
  }).catch((error) => {
    _facebookSdkPromise = null;
    throw error;
  });
  return _facebookSdkPromise;
}

/** Accept a public HTTPS media URL without allowing iframe markup or credentials. */
export function publicEmbeddedMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !host.includes('.') ||
    host.includes(':') ||
    /^\d+(\.\d+){3}$/.test(host) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  )
    return null;
  return url;
}

function youtubeVideoId(url) {
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (host === 'youtu.be')
    return /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] || null;
  if (url.pathname === '/watch') return url.searchParams.get('v');
  return /^\/(?:embed|shorts)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] || null;
}

function isFacebookVideoUrl(url) {
  const host = url.hostname.toLowerCase();
  if (!FACEBOOK_HOSTS.has(host)) return false;
  if (host === 'fb.watch' || host === 'www.fb.watch')
    return /^\/[\w.-]+\/?$/.test(url.pathname);
  return (
    /^\/reel\/[\w.-]+\/?$/.test(url.pathname) ||
    (url.pathname === '/watch/' && Boolean(url.searchParams.get('v'))) ||
    /\/videos\/[\w.-]+\/?$/.test(url.pathname) ||
    /^\/share\/(?:v|r)\/[\w.-]+\/?$/.test(url.pathname)
  );
}

function xPostId(url) {
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  return (
    /^\/[A-Za-z0-9_]{1,15}\/status\/(\d+)\/?$/.exec(url.pathname)?.[1] || null
  );
}

/** Resolve only providers that can render inside a Bhote Koshi callout. */
export function resolveEmbeddedMediaSource(value) {
  const url = publicEmbeddedMediaUrl(value);
  if (!url) return null;
  const youtubeId = youtubeVideoId(url);
  if (youtubeId && /^[\w-]{11}$/.test(youtubeId)) {
    return {
      provider: 'youtube',
      id: youtubeId,
      url: `https://www.youtube.com/watch?v=${youtubeId}`,
    };
  }
  if (isFacebookVideoUrl(url)) {
    return { provider: 'facebook', url: url.href };
  }
  const postId = xPostId(url);
  if (postId) {
    return { provider: 'x', id: postId, url: url.href };
  }
  return null;
}

/** Provider-owned iframe URL for YouTube or Facebook callouts. */
export function embeddedMediaFrameUrl(
  source,
  { autoplay = false, startAtSec = 0, endAtSec = null } = {},
) {
  if (source?.provider === 'youtube') {
    const url = new URL(`https://www.youtube-nocookie.com/embed/${source.id}`);
    url.searchParams.set('playsinline', '1');
    url.searchParams.set('rel', '0');
    const startSeconds = Math.max(0, Math.floor(Number(startAtSec) || 0));
    if (startSeconds > 0) url.searchParams.set('start', String(startSeconds));
    const endSeconds = Math.floor(Number(endAtSec));
    if (Number.isFinite(endSeconds) && endSeconds > startSeconds) {
      url.searchParams.set('end', String(endSeconds));
    }
    if (autoplay) {
      url.searchParams.set('autoplay', '1');
      url.searchParams.set('mute', '1');
    }
    return url.href;
  }
  if (source?.provider === 'facebook') {
    const url = new URL('https://www.facebook.com/plugins/video.php');
    url.searchParams.set('href', source.url);
    url.searchParams.set('show_text', 'false');
    url.searchParams.set('width', '500');
    url.searchParams.set('autoplay', autoplay ? 'true' : 'false');
    url.searchParams.set('mute', autoplay ? 'true' : 'false');
    return url.href;
  }
  return null;
}

function xWidgetsReady(api) {
  return typeof api?.widgets?.createTweet === 'function';
}

function loadXWidgets(documentRef, globalRef = globalThis) {
  if (xWidgetsReady(globalRef.twttr)) return Promise.resolve(globalRef.twttr);
  if (_xWidgetsPromise) return _xWidgetsPromise;
  _xWidgetsPromise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(globalRef.twttr);
    };
    const ready = () => {
      if (xWidgetsReady(globalRef.twttr)) finish();
      else finish(new Error('X embed API did not initialize.'));
    };
    let script = documentRef.querySelector?.(`script[src="${X_WIDGET_URL}"]`);
    if (!script) {
      script = documentRef.createElement('script');
      script.src = X_WIDGET_URL;
      script.async = true;
      script.charset = 'utf-8';
      script.dataset.gevXWidgets = 'true';
      documentRef.head?.append(script);
    }
    script.addEventListener?.(
      'error',
      () => finish(new Error('X embed could not load.')),
      {
        once: true,
      },
    );
    const waitForApi = () => {
      if (xWidgetsReady(globalRef.twttr)) {
        finish();
        return;
      }
      if (typeof globalRef.twttr?.ready === 'function')
        globalRef.twttr.ready(ready);
      else ready();
    };
    script.addEventListener?.('load', waitForApi, { once: true });
    if (typeof globalRef.twttr?.ready === 'function')
      globalRef.twttr.ready(ready);
    if (script.dataset?.gevXLoaded === 'true') waitForApi();
    else
      script.addEventListener?.(
        'load',
        () => {
          script.dataset.gevXLoaded = 'true';
        },
        {
          once: true,
        },
      );
    timer = setTimeout(
      () => finish(new Error('X embed timed out.')),
      EMBED_TIMEOUT_MS,
    );
  }).catch((error) => {
    _xWidgetsPromise = null;
    throw error;
  });
  return _xWidgetsPromise;
}

function providerLabel(provider) {
  return (
    { youtube: 'YOUTUBE', facebook: 'FACEBOOK', x: 'X' }[provider] || 'SOURCE'
  );
}

function isPortraitMedia(media = {}) {
  const width = Number(media.width);
  const height = Number(media.height);
  return (
    String(media.orientation || '').toLowerCase() === 'portrait' ||
    (Number.isFinite(width) && Number.isFinite(height) && height > width)
  );
}

function ensureProviderConnections(documentRef, provider) {
  for (const origin of MEDIA_PRECONNECT_ORIGINS[provider] || []) {
    if (
      documentRef.querySelector?.(`link[data-gev-media-preconnect="${origin}"]`)
    )
      continue;
    const link = documentRef.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    link.dataset.gevMediaPreconnect = origin;
    documentRef.head?.append(link);
  }
}

function anchorOnScreen(viewer, anchor, root) {
  if (!viewer?.scene || !anchor || !root) return null;
  const camera = viewer.camera;
  if (camera?.positionWC && camera?.directionWC) {
    const delta = Cesium.Cartesian3.subtract(
      anchor,
      camera.positionWC,
      new Cesium.Cartesian3(),
    );
    if (Cesium.Cartesian3.dot(delta, camera.directionWC) <= 0) return null;
  }
  const pixel = Cesium.SceneTransforms.worldToWindowCoordinates(
    viewer.scene,
    anchor,
  );
  if (!pixel) return null;
  const canvasBounds = viewer.canvas?.getBoundingClientRect?.();
  const rootBounds = root.getBoundingClientRect?.();
  if (!canvasBounds || !rootBounds) return null;
  const x = pixel.x + canvasBounds.left - rootBounds.left;
  const y = pixel.y + canvasBounds.top - rootBounds.top;
  if (
    x < -40 ||
    y < -40 ||
    x > rootBounds.width + 40 ||
    y > rootBounds.height + 40
  )
    return null;
  return { x, y, width: rootBounds.width, height: rootBounds.height };
}

function placeCard(card, leader, anchor) {
  const margin = 18;
  const gap = 42;
  const width = card.offsetWidth || 392;
  const height = card.offsetHeight || 360;
  const rootBounds = card.parentElement?.getBoundingClientRect?.();
  const documentRef = card.ownerDocument;
  let laneLeft = margin;
  let laneRight = anchor.width - margin;
  let laneBottom = anchor.height - margin;
  if (rootBounds && documentRef?.querySelector) {
    const leftPanel = documentRef
      .querySelector('#scene-panel')
      ?.getBoundingClientRect?.();
    const rightRail = documentRef
      .querySelector('#right-context-rail')
      ?.getBoundingClientRect?.();
    const commandDock = documentRef
      .querySelector('#command-dock')
      ?.getBoundingClientRect?.();
    if (leftPanel?.width > 0)
      laneLeft = Math.max(laneLeft, leftPanel.right - rootBounds.left + margin);
    if (rightRail?.width > 0)
      laneRight = Math.min(
        laneRight,
        rightRail.left - rootBounds.left - margin,
      );
    if (commandDock?.height > 0)
      laneBottom = Math.min(
        laneBottom,
        commandDock.top - rootBounds.top - margin,
      );
    if (laneRight - laneLeft < width) {
      laneLeft = margin;
      laneRight = anchor.width - margin;
    }
  }
  let left = anchor.x + gap;
  if (left + width > laneRight) left = anchor.x - width - gap;
  left = Math.max(laneLeft, Math.min(laneRight - width, left));
  const belowAnchor = anchor.y + gap;
  const prefersBelow =
    card.classList.contains('is-youtube') ||
    card.classList.contains('is-portrait');
  const desiredTop =
    prefersBelow && belowAnchor + height <= laneBottom
      ? belowAnchor
      : anchor.y - height * 0.42;
  const top = Math.max(margin, Math.min(laneBottom - height, desiredTop));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  const localX = anchor.x - left;
  const localY = anchor.y - top;
  const edgeX = localX < 0 ? 0 : width;
  const edgeY = Math.max(16, Math.min(height - 16, localY));
  leader
    .querySelector('path')
    ?.setAttribute('d', `M ${localX} ${localY} L ${edgeX} ${edgeY}`);
  const dot = leader.querySelector('circle');
  dot?.setAttribute('cx', String(localX));
  dot?.setAttribute('cy', String(localY));
}

function createRoot(documentRef, viewer) {
  const root = documentRef.createElement('div');
  root.id = 'bhote-koshi-embedded-media-root';
  root.setAttribute('aria-live', 'polite');
  (viewer?.container || documentRef.body)?.append(root);
  return root;
}

/**
 * Render one provider-owned player/post in a geographically anchored DOM card.
 * YouTube and Facebook sources use their provider player; approved local clips
 * remain available to bhoteKoshiEvent as a fallback when no embed is supported.
 */
export function createBhoteKoshiEmbeddedMedia({
  viewer,
  documentRef = globalThis.document,
  globalRef = globalThis,
  xLoader = loadXWidgets,
  facebookLoader = loadFacebookSdk,
  youtubeLoader = loadYouTubeApi,
} = {}) {
  // Pinokio externalizes HTTPS iframe navigation, including hidden preloads.
  // Use the existing source-card/local-clip fallback before allocating provider
  // resources. Browsers visiting the same Pinokio-launched server keep embeds.
  const pinokioShell = /(?:^|\s)Pinokio\/[^\s]+/i.test(
    globalRef.navigator?.userAgent || '',
  );
  if (pinokioShell || !documentRef?.createElement || !viewer) {
    return {
      supportsPlayback: false,
      warm: () => false,
      show: () => false,
      play: () => false,
      pause: () => false,
      hide: () => {},
      destroy: () => {},
    };
  }
  const root = createRoot(documentRef, viewer);
  let record = null;
  let warmRecord = null;
  let generation = 0;
  const leavingRecords = new Set();

  const prefersReducedMotion = () =>
    globalRef.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ===
    true;
  const scheduleFrame = (callback) => {
    if (typeof globalRef.requestAnimationFrame === 'function') {
      return { kind: 'frame', id: globalRef.requestAnimationFrame(callback) };
    }
    if (typeof globalRef.setTimeout === 'function') {
      return { kind: 'timer', id: globalRef.setTimeout(callback, 0) };
    }
    callback();
    return null;
  };
  const cancelScheduledFrame = (scheduled) => {
    if (!scheduled) return;
    if (scheduled.kind === 'frame')
      globalRef.cancelAnimationFrame?.(scheduled.id);
    else globalRef.clearTimeout?.(scheduled.id);
  };

  function unsubscribeFacebook(session) {
    if (!session?.readyListener) return;
    try {
      session.api?.Event?.unsubscribe?.('xfbml.ready', session.readyListener);
    } catch {
      // Provider teardown is best effort.
    }
    session.readyListener = null;
  }

  function setFacebookSessionPlayback(session, playing) {
    if (!session?.active) return false;
    session.shouldPlay = playing === true;
    if (!session.player) return false;
    try {
      if (session.shouldPlay) {
        session.player.mute?.();
        const result = session.player.play?.();
        result?.catch?.(() => {
          if (!session.active || !session.shouldPlay) return;
          session.onPlaybackBlocked?.();
        });
      } else {
        session.player.pause?.();
      }
      return true;
    } catch {
      if (session.shouldPlay) session.onPlaybackBlocked?.();
      return false;
    }
  }

  function destroyFacebookSession(session) {
    if (!session) return;
    session.shouldPlay = false;
    globalRef.clearTimeout?.(session.timer);
    session.timer = null;
    try {
      session.player?.pause?.();
    } catch {
      // Provider teardown is best effort.
    }
    session.active = false;
    unsubscribeFacebook(session);
    session.host?.remove?.();
    session.player = null;
  }

  function createFacebookSession(source, host) {
    const session = {
      active: true,
      api: null,
      embed: null,
      host,
      player: null,
      ready: false,
      error: null,
      readyListener: null,
      shouldPlay: false,
      timer: null,
      onReady: null,
      onError: null,
      onPlaybackBlocked: null,
    };
    const embed = documentRef.createElement('div');
    embed.id = `bhote-koshi-facebook-${++_facebookEmbedSequence}`;
    embed.className = 'fb-video';
    embed.dataset.href = source.url;
    embed.dataset.width = '500';
    embed.dataset.showText = 'false';
    embed.dataset.allowfullscreen = 'true';
    embed.dataset.autoplay = 'false';
    session.embed = embed;
    host.append(embed);
    void facebookLoader(documentRef, globalRef)
      .then((api) => {
        if (!session.active) return;
        session.api = api;
        session.readyListener = (message) => {
          if (
            !session.active ||
            message?.type !== 'video' ||
            (message.id && message.id !== embed.id)
          )
            return;
          globalRef.clearTimeout?.(session.timer);
          session.timer = null;
          session.player = message.instance;
          session.ready = true;
          session.error = null;
          session.onReady?.();
          setFacebookSessionPlayback(session, session.shouldPlay);
        };
        api.Event.subscribe('xfbml.ready', session.readyListener);
        api.XFBML.parse(session.host);
        session.timer =
          globalRef.setTimeout?.(() => {
            if (!session.active || session.ready) return;
            session.error = new Error(
              'Facebook embed unavailable. The post may be private, removed, region-restricted, or blocked.',
            );
            session.onError?.(session.error);
          }, EMBED_TIMEOUT_MS) ?? null;
      })
      .catch((error) => {
        if (!session.active) return;
        session.error = error;
        session.onError?.(error);
      });
    return session;
  }

  function removeRecord(current) {
    if (!current) return;
    cancelScheduledFrame(current.enterFrame);
    if (current.exitTimer != null) globalRef.clearTimeout?.(current.exitTimer);
    destroyFacebookSession(current.facebookSession);
    current.youtubeSession?.destroy();
    current.card?.remove?.();
    leavingRecords.delete(current);
  }

  const position = () => {
    if (!record) return;
    const projected = anchorOnScreen(viewer, record.anchor, root);
    record.card.hidden = !projected;
    if (projected) {
      placeCard(record.card, record.leader, projected);
      if (!record.entered) {
        record.entered = true;
        const current = record;
        const token = generation;
        current.enterFrame = scheduleFrame(() => {
          current.enterFrame = null;
          if (token !== generation || record !== current) return;
          current.card.classList.add('is-entering');
        });
      }
    }
  };
  const removePostRender =
    viewer.scene?.postRender?.addEventListener?.(position);

  function hide({ immediate = false, preserveWarm = false } = {}) {
    if (!preserveWarm) clearWarm();
    generation += 1;
    const current = record;
    record = null;
    if (!current) return;
    current.youtubeSession?.destroy();
    setFacebookSessionPlayback(current.facebookSession, false);
    cancelScheduledFrame(current.enterFrame);
    current.enterFrame = null;
    if (immediate || current.card.hidden || prefersReducedMotion()) {
      removeRecord(current);
      return;
    }
    current.card.classList.remove('is-entering');
    current.card.classList.add('is-leaving');
    leavingRecords.add(current);
    current.exitTimer =
      globalRef.setTimeout?.(
        () => removeRecord(current),
        CARD_EXIT_DURATION_MS,
      ) ?? null;
  }

  function clearWarm(key = null) {
    if (!warmRecord || (key && warmRecord.key !== key)) return;
    if (warmRecord.facebookSession)
      destroyFacebookSession(warmRecord.facebookSession);
    else warmRecord.iframe?.remove?.();
    warmRecord = null;
  }

  function takeWarmFacebook(key, host) {
    if (warmRecord?.key !== key || !warmRecord.facebookSession) return null;
    const session = warmRecord.facebookSession;
    warmRecord = null;
    const warmHost = session.host;
    warmHost.classList.remove('bhote-embedded-media-warmup');
    warmHost.classList.add('bhote-facebook-player-host');
    warmHost.removeAttribute?.('aria-hidden');
    host.append(warmHost);
    return session;
  }

  function warm({ observation, sourceUrl } = {}) {
    const media = observation?.media || {};
    const source = resolveEmbeddedMediaSource(sourceUrl || media.sourceUrl);
    if (!source || source.provider === 'x') {
      clearWarm();
      return false;
    }
    const startAtSec =
      source.provider === 'youtube'
        ? Math.max(0, Number(media.embedStartAtSec ?? media.clipInSec) || 0)
        : 0;
    ensureProviderConnections(documentRef, source.provider);
    const endAtSec = media.embedEndAtSec;
    const key = `${source.provider}:${source.id || source.url}:${startAtSec}:${endAtSec ?? ''}`;
    if (warmRecord?.key === key) return true;
    clearWarm();
    if (source.provider === 'facebook') {
      const host = documentRef.createElement('div');
      host.className = 'bhote-embedded-media-warmup';
      host.setAttribute('aria-hidden', 'true');
      root.append(host);
      const facebookSession = createFacebookSession(source, host);
      warmRecord = { key, facebookSession };
      return true;
    }
    const iframe = documentRef.createElement('iframe');
    iframe.className = 'bhote-embedded-media-warmup';
    iframe.src = embeddedMediaFrameUrl(source, {
      autoplay: false,
      startAtSec,
      endAtSec,
    });
    iframe.title = `Preloading ${providerLabel(source.provider)} media`;
    iframe.tabIndex = -1;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.loading = 'eager';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    root.append(iframe);
    warmRecord = { key, iframe };
    return true;
  }

  async function mountX(current, token) {
    current.status.textContent = 'LOADING X POST…';
    try {
      const api = await xLoader(documentRef, globalRef);
      if (token !== generation || record !== current) return;
      const widget = await api.widgets.createTweet(
        current.source.id,
        current.player,
        {
          align: 'center',
          conversation: 'none',
          dnt: true,
          theme: 'dark',
          width: 390,
        },
      );
      if (token !== generation || record !== current) return;
      if (!widget)
        throw new Error('The X post is unavailable or cannot be embedded.');
      current.status.textContent = 'X POST · PROVIDER CONTROLS';
      position();
    } catch (error) {
      if (token !== generation || record !== current) return;
      current.card.classList.add('is-unavailable');
      current.status.textContent = `${String(error?.message || 'X embed unavailable')} OPEN ORIGINAL.`;
      position();
    }
  }

  function bindFacebook(current, token, warmKey, autoplay) {
    const session =
      takeWarmFacebook(warmKey, current.player) ||
      createFacebookSession(current.source, current.player);
    current.facebookSession = session;
    session.shouldPlay = autoplay === true;
    session.onReady = () => {
      if (token !== generation || record !== current) return;
      current.status.textContent = 'FACEBOOK · PROVIDER CONTROLS';
      current.card.classList.remove('is-unavailable');
      position();
    };
    session.onError = (error) => {
      if (token !== generation || record !== current) return;
      current.card.classList.add('is-unavailable');
      current.status.textContent = `${String(error?.message || 'Facebook embed unavailable')} OPEN ORIGINAL.`;
      position();
    };
    session.onPlaybackBlocked = () => {
      if (token !== generation || record !== current) return;
      current.status.textContent = 'AUTOPLAY BLOCKED · USE PROVIDER CONTROLS';
    };
    if (session.ready) session.onReady();
    else if (session.error) session.onError(session.error);
    setFacebookSessionPlayback(session, autoplay);
  }

  function setPlayback(playing) {
    if (!playing) clearWarm();
    // Removing an uncontrolled provider frame also cancels delayed autoplay.
    // Provider commands alone cannot stop a frame that has not loaded yet.
    if (!playing && record && !record.facebookSession) {
      hide({ immediate: true });
      return true;
    }
    if (!record?.facebookSession) return false;
    return setFacebookSessionPlayback(record.facebookSession, playing);
  }

  function show({ observation, anchor, autoplay = false, sourceUrl } = {}) {
    const media = observation?.media || {};
    const source = resolveEmbeddedMediaSource(sourceUrl || media.sourceUrl);
    if (!source || !anchor) {
      hide();
      return false;
    }
    const startAtSec =
      source.provider === 'youtube'
        ? Math.max(0, Number(media.embedStartAtSec ?? media.clipInSec) || 0)
        : 0;
    ensureProviderConnections(documentRef, source.provider);
    const endAtSec = media.embedEndAtSec;
    const warmKey = `${source.provider}:${source.id || source.url}:${startAtSec}:${endAtSec ?? ''}`;
    const key =
      source.provider === 'facebook'
        ? warmKey
        : `${warmKey}:${autoplay ? 1 : 0}`;
    if (record?.key === key) {
      record.anchor = anchor;
      if (source.provider === 'facebook') setPlayback(autoplay);
      position();
      return true;
    }
    if (warmRecord && warmRecord.key !== warmKey) clearWarm();
    hide({ preserveWarm: true });
    const token = ++generation;
    const card = documentRef.createElement('section');
    const portraitClass = isPortraitMedia(media) ? ' is-portrait' : '';
    card.className = `bhote-embedded-callout is-${source.provider}${portraitClass}`;
    card.dataset.provider = source.provider;
    card.setAttribute(
      'aria-label',
      `Embedded ${providerLabel(source.provider)} media for ${observation?.title || 'witness source'}`,
    );
    const leader = documentRef.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg',
    );
    leader.classList.add('bhote-embedded-callout-leader');
    leader.setAttribute('aria-hidden', 'true');
    leader.innerHTML =
      '<path pathLength="1" fill="none" stroke="rgba(147,213,228,.72)" stroke-width="1.5"/><circle r="4" fill="#6be8ff" stroke="#ffffff" stroke-width="1.5"/>';
    const player = documentRef.createElement('div');
    player.className = 'bhote-embedded-callout-player';
    const footer = documentRef.createElement('footer');
    const title = documentRef.createElement('strong');
    title.textContent = String(
      observation?.shortTitle || observation?.title || 'Witness source',
    ).toUpperCase();
    const status = documentRef.createElement('small');
    status.setAttribute('role', 'status');
    status.textContent = `${providerLabel(source.provider)} · EMBEDDED SOURCE`;
    const link = documentRef.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'OPEN ORIGINAL';
    appendIcon(link, 'external-link', {}, documentRef);
    footer.append(title, status, link);
    const body = documentRef.createElement('div');
    body.className = 'bhote-embedded-callout-body';
    body.append(player, footer);
    card.append(leader, body);
    root.append(card);
    record = {
      key,
      source,
      anchor,
      card,
      leader,
      player,
      status,
      entered: false,
    };

    if (source.provider === 'x') {
      void mountX(record, token);
    } else if (source.provider === 'facebook') {
      bindFacebook(record, token, warmKey, autoplay);
    } else {
      const iframe = documentRef.createElement('iframe');
      iframe.src = embeddedMediaFrameUrl(source, {
        autoplay,
        startAtSec,
        endAtSec,
      });
      const controlled =
        autoplay &&
        Number.isFinite(Number(endAtSec)) &&
        Number(endAtSec) > startAtSec;
      if (controlled) {
        const url = new URL(iframe.src);
        url.searchParams.set('enablejsapi', '1');
        if (globalRef.location?.origin)
          url.searchParams.set('origin', globalRef.location.origin);
        iframe.src = url.href;
      }
      iframe.title = `${providerLabel(source.provider)} media: ${observation?.title || 'witness source'}`;
      iframe.allow =
        'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.allowFullscreen = true;
      iframe.loading = 'eager';
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.addEventListener?.(
        'load',
        () => {
          if (token !== generation || record?.key !== key) return;
          clearWarm(warmKey);
          if (
            !record.youtubeSession ||
            ['starting', 'playing'].includes(
              record.youtubeSession.getState().phase,
            )
          ) {
            status.textContent = `${providerLabel(source.provider)} · PROVIDER CONTROLS`;
          }
          position();
        },
        { once: true },
      );
      player.append(iframe);
      if (controlled) {
        const current = record;
        current.youtubeSession = createTrimmedYouTubePlayback({
          iframe,
          endAtSec: Number(endAtSec),
          startAtSec,
          globalRef,
          loadApi: () => youtubeLoader(documentRef, globalRef),
          isCurrent: () => token === generation && record === current,
          onStatus: (phase) => {
            if (phase !== 'completed')
              status.textContent = `YOUTUBE ${phase.toUpperCase()} · OPEN ORIGINAL`;
          },
        });
      }
    }
    position();
    return true;
  }

  function destroy() {
    hide({ immediate: true });
    for (const current of [...leavingRecords]) removeRecord(current);
    clearWarm();
    removePostRender?.();
    root.remove();
  }

  return {
    supportsPlayback: true,
    warm,
    show,
    getPlaybackState: () => record?.youtubeSession?.getState() || null,
    play: () => setPlayback(true),
    pause: () => setPlayback(false),
    hide,
    destroy,
  };
}
