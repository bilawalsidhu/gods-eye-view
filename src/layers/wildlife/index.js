import * as Cesium from 'cesium';
import { formatNumber, msg, t, tn, translateKnown } from '../../i18n/index.js';
import {
  cameraPoseSignature,
  screenProjectedRotation,
} from '../../data/iconOrientation.js';
import {
  WILDLIFE_MAX_STALE_MS,
  WILDLIFE_PAGE_SIZE,
  WILDLIFE_WINDOWS,
  wildlifeAgeParts,
  wildlifeHeading,
  wildlifeRecentRun,
  wildlifeShortName,
  wildlifeSpeciesName,
  wildlifeTime,
} from './records.js';
export * from './records.js';
export { createWildlifeSource } from './source.js';

const LAYER_ID = 'wildlife';
const ENTITY_PREFIX = `${LAYER_ID}:`;
/** Okabe-Ito, so species stay apart for colour-blind viewers too. */
const SPECIES_COLORS = Object.freeze({
  'Ciconia ciconia': '#E69F00',
  'Ichthyaetus melanocephalus': '#CC79A7',
  'Larus argentatus': '#56B4E9',
  'Larus armenicus': '#F0E442',
  'Larus fuscus': '#D55E00',
  'Platalea leucorodia': '#009E73',
});
const DEFAULT_COLOR = '#d0d0d0';
/** Older thirds of a recent path fade out behind the animal. */
const TRACK_ALPHAS = Object.freeze([0.2, 0.45, 0.85]);
const GLYPH_SCALE = 0.8;
const SELECTED_SCALE = 1.25;
const ANIMAL_FOCUS_HEIGHT_M = 300_000;
/** While studies are still on their way from Movebank, look again this soon. */
const PENDING_POLL_MS = 20_000;
const MOVEBANK_PAGE = 'https://www.movebank.org/';
const CAVEAT = msg('Datasets CC0 · fixes may lag hours');
const DISCLAIMER = msg(
  'Latest GPS fixes of tagged animals from public Movebank studies whose published datasets are CC0. Movebank shows the licence an owner sets on the study itself only to signed-in users, so that setting was not checked. Owners can hide animals or hold back recent data; only what Movebank shows publicly appears here. Tags report every few minutes to hours, and a study can go quiet for months. Arrows point along the last move; a dot means the animal has not moved or has one fix. Not for locating or disturbing animals.',
);

const animals = (count) =>
  tn(count, '{count} animal', '{count} animals', {
    count: formatNumber(count),
  });
const studies = (count) =>
  tn(count, '{count} study', '{count} studies', { count: formatNumber(count) });
/** Species names are ours (msg) unless Movebank names a taxon we do not list. */
const speciesName = (taxon) => translateKnown(wildlifeSpeciesName(taxon));
const shortName = (taxon) => translateKnown(wildlifeShortName(taxon));
const lastFix = (animal) => animal.track[animal.track.length - 1];
const speciesColor = (taxon) => SPECIES_COLORS[taxon] || DEFAULT_COLOR;

/** A failed refresh, said in 45 characters or fewer. */
export function wildlifeErrorReason(message) {
  const status = /HTTP (\d{3})/.exec(String(message))?.[1];
  if (status) return t('Tracking proxy error (HTTP {status})', { status });
  if (/malformed/i.test(String(message)))
    return t('Unexpected data from the proxy');
  return t('Network error, retrying');
}

/** "3 h ago" style age of a fix; "just now" under a minute. */
export function wildlifeAge(ms, now) {
  const { unit, count } = wildlifeAgeParts(ms, now);
  if (unit === 'now') return t('just now');
  if (unit === 'minute') return t('{count} min ago', { count });
  if (unit === 'hour') return t('{count} h ago', { count });
  if (unit === 'day') return tn(count, '{count} day ago', '{count} days ago');
  if (unit === 'month')
    return tn(count, '{count} month ago', '{count} months ago');
  return tn(count, '{count} year ago', '{count} years ago');
}

/** A list-lead age: "now", "45m", "3h", "12d", "4mo", "2y". */
export function wildlifeAgeShort(ms, now) {
  const { unit, count } = wildlifeAgeParts(ms, now);
  if (unit === 'now') return t('now', { context: 'age' });
  if (unit === 'minute') return t('{count}m', { count });
  if (unit === 'hour') return t('{count}h', { count });
  if (unit === 'day') return t('{count}d', { count });
  if (unit === 'month') return t('{count}mo', { count });
  return t('{count}y', { count });
}

/** One glyph image per color and shape, shared by every billboard. */
const _glyphs = new Map();
export function wildlifeGlyph(color, moving) {
  const key = `${color}:${moving}`;
  if (!_glyphs.has(key)) {
    const shape = moving
      ? `<path d="M12 2 L20 21 L12 16 L4 21 Z" fill="${color}" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>`
      : `<circle cx="12" cy="12" r="6" fill="${color}" stroke="#000" stroke-width="1.5"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${shape}</svg>`;
    _glyphs.set(key, `data:image/svg+xml;base64,${globalThis.btoa(svg)}`);
  }
  return _glyphs.get(key);
}

/**
 * Split the newest unbroken stretch of a path into overlapping thirds so
 * each can fade on its own.
 */
export function wildlifeTrackChunks(fullTrack) {
  const track = wildlifeRecentRun(fullTrack);
  if (track.length < 2) return [];
  const count = Math.min(TRACK_ALPHAS.length, track.length - 1);
  const chunks = [];
  for (let index = 0; index < count; index++) {
    const start = Math.floor((index * (track.length - 1)) / count);
    const end = Math.floor(((index + 1) * (track.length - 1)) / count);
    chunks.push({
      fixes: track.slice(start, end + 1),
      alpha: TRACK_ALPHAS[TRACK_ALPHAS.length - count + index],
    });
  }
  return chunks;
}

/**
 * Own one wildlife display: the latest GPS fix of each tagged animal in the
 * curated Movebank studies as a glyph pointing along its last move, a short
 * fading path behind it, and a row that lists studies and their animals.
 */
export function createWildlifeLayer({
  source,
  cesium = Cesium,
  rotate = screenProjectedRotation,
  poseSignature = cameraPoseSignature,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
  now = () => Date.now(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle),
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Wildlife requires a tracking source');
  const C = cesium;
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _studies = [];
  let _animals = [];
  let _window = 'year';
  let _studyId = null;
  let _animalId = null;
  let _page = 0;
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _pollTimer = null;
  let _listener = null;
  let _runNavigation = null;
  let _clickHandler = null;
  let _removePreRender = null;
  let _occluder = null;
  let _culledFrom = null;
  let _poseSignature = null;
  let _navigationGeneration = 0;
  /** entity id -> animal id, for glyphs and path pieces alike. */
  const _entityAnimals = new Map();
  /** animal id -> { entity, position, heading, animal, tracks } */
  const _markers = new Map();

  const notify = () => _listener?.();
  const requestRender = () => {
    if (!_viewer?.isDestroyed?.()) _viewer?.scene?.requestRender?.();
  };
  const studyOf = (id) => _studies.find((study) => study.id === id) || null;
  const inWindow = (animal) =>
    now() - lastFix(animal)[2] <= WILDLIFE_WINDOWS[_window].ms;
  /** Animals on the globe: inside the window, and the chosen study if any. */
  const shownAnimals = () =>
    _animals.filter(
      (animal) =>
        inWindow(animal) && (_studyId === null || animal.study === _studyId),
    );
  const listedAnimals = () =>
    shownAnimals().sort((a, b) => lastFix(b)[2] - lastFix(a)[2]);
  const noneShown = () => t(WILDLIFE_WINDOWS[_window].none);
  const selectedAnimal = () =>
    (_animalId && _markers.get(_animalId)?.animal) || null;

  function cullHorizon(force = false) {
    const camera = _viewer.camera;
    const position = camera.positionWC;
    const moved =
      force || !_culledFrom || !C.Cartesian3.equals(position, _culledFrom);
    if (moved) {
      _culledFrom = C.Cartesian3.clone(position, _culledFrom || undefined);
      _occluder.cameraPosition = position;
    }
    let changed = false;
    for (const marker of _markers.values()) {
      if (moved) {
        const show = _occluder.isPointVisible(marker.position);
        if (marker.entity.show !== show) {
          marker.entity.show = show;
          changed = true;
        }
      }
    }
    // Billboards face the camera, so pointing one along the ground course
    // needs the camera's basis: recompute only when the pose changed.
    const signature = poseSignature(camera);
    if (force || signature !== _poseSignature) {
      _poseSignature = signature;
      for (const marker of _markers.values()) {
        if (marker.heading === null || !marker.entity.show) continue;
        const billboard = marker.entity.billboard;
        const previous = billboard.rotation?.getValue?.() ?? 0;
        const next = rotate(
          _viewer.scene,
          marker.position,
          marker.heading,
          previous,
        );
        if (next !== null && Math.abs(next - previous) > 0.002) {
          billboard.rotation = next;
          changed = true;
        }
      }
    }
    if (changed) requestRender();
  }

  function syncHorizonListener() {
    const scene = _viewer?.scene;
    if (!_enabled || !_markers.size || !scene?.preRender) {
      _removePreRender?.();
      _removePreRender = null;
      return;
    }
    if (_removePreRender) return;
    _occluder ||= new C.EllipsoidalOccluder(
      C.Ellipsoid.WGS84,
      _viewer.camera.positionWC,
    );
    _removePreRender = scene.preRender.addEventListener(() => cullHorizon());
  }

  function styleMarker(marker) {
    const active = marker.animal.id === _animalId;
    marker.entity.billboard.scale = active ? SELECTED_SCALE : GLYPH_SCALE;
    for (const { entity, alpha } of marker.tracks) {
      entity.polyline.width = active ? 3.5 : 2;
      entity.polyline.material = C.Color.fromCssColorString(
        active ? '#ffffff' : speciesColor(marker.animal.taxon),
      ).withAlpha(active ? Math.max(alpha, 0.5) : alpha);
    }
  }

  function render() {
    const animals = shownAnimals();
    const signature = JSON.stringify(
      animals.map(({ id, track }) => [id, track.length, track.at(-1)]),
    );
    if (signature === _signature) return;
    _signature = signature;
    _dataSource.entities.removeAll();
    _entityAnimals.clear();
    _markers.clear();
    _poseSignature = null;
    for (const animal of animals) {
      const [lon, lat] = lastFix(animal);
      const heading = wildlifeHeading(animal.track);
      const color = speciesColor(animal.taxon);
      const id = `${ENTITY_PREFIX}${animal.id}`;
      const position = C.Cartesian3.fromDegrees(lon, lat, 0);
      const tracks = wildlifeTrackChunks(animal.track).map(
        ({ fixes, alpha }, index) => {
          const trackId = `${id}:track:${index}`;
          _entityAnimals.set(trackId, animal.id);
          return {
            alpha,
            entity: _dataSource.entities.add(
              new C.Entity({
                id: trackId,
                polyline: {
                  positions: fixes.map(([x, y]) =>
                    C.Cartesian3.fromDegrees(x, y),
                  ),
                  width: 2,
                  material: C.Color.fromCssColorString(color).withAlpha(alpha),
                  clampToGround: true,
                  classificationType: C.ClassificationType.BOTH,
                  arcType: C.ArcType.GEODESIC,
                },
              }),
            ),
          };
        },
      );
      const entity = _dataSource.entities.add(
        new C.Entity({
          id,
          name: `${speciesName(animal.taxon)} ${animal.name}`,
          position,
          billboard: {
            image: wildlifeGlyph(color, heading !== null),
            scale: GLYPH_SCALE,
            rotation: 0,
            alignedAxis: C.Cartesian3.ZERO,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
      _entityAnimals.set(id, animal.id);
      const marker = { entity, position, heading, animal, tracks };
      _markers.set(animal.id, marker);
      if (animal.id === _animalId) styleMarker(marker);
    }
    if (_animalId && !_markers.has(_animalId)) _animalId = null;
    syncHorizonListener();
    if (_removePreRender) cullHorizon(true);
    requestRender();
  }

  function selectAnimal(id) {
    if (_animalId === id) return;
    ++_navigationGeneration;
    const previous = _animalId;
    _animalId = id;
    for (const key of [previous, id]) {
      const marker = key && _markers.get(key);
      if (marker) styleMarker(marker);
    }
    requestRender();
  }

  function selectStudy(id) {
    ++_navigationGeneration;
    _studyId = id;
    _page = 0;
    _animalId = null;
    render();
  }

  /** Keep the page inside the list after it shrinks. */
  function clampPage() {
    const pages = Math.ceil(listedAnimals().length / WILDLIFE_PAGE_SIZE);
    _page = Math.max(0, Math.min(_page, pages - 1));
  }

  /**
   * Fail closed here too: while refreshes fail, a study's last positions leave
   * the globe when the proxy's copy of them would have expired. Each deadline
   * is set on this clock from the copy's age on the proxy's clock.
   */
  function holdStudies(studies, generatedAt) {
    const received = now();
    return studies.map((study) => {
      if (study.status !== 'fresh' && study.status !== 'stale') return study;
      const age =
        Number.isFinite(generatedAt) && Number.isFinite(study.fetchedAt)
          ? Math.max(0, generatedAt - study.fetchedAt)
          : 0;
      return { ...study, heldUntil: received + WILDLIFE_MAX_STALE_MS - age };
    });
  }

  function expireHeld() {
    const expired = new Set(
      _studies
        .filter(({ heldUntil }) => heldUntil <= now())
        .map(({ id }) => id),
    );
    if (!expired.size) return;
    _studies = _studies.map((study) =>
      expired.has(study.id)
        ? { ...study, status: 'unavailable', heldUntil: undefined }
        : study,
    );
    _animals = _animals.filter(({ study }) => !expired.has(study));
    clampPage();
    render();
  }

  /** Put the chosen animal on the current page of its study's list. */
  function pageTo(id) {
    const index = listedAnimals().findIndex((animal) => animal.id === id);
    if (index >= 0) _page = Math.floor(index / WILDLIFE_PAGE_SIZE);
  }

  const isSurfacePick = (picked) =>
    !picked ||
    (picked.id === undefined &&
      (picked.content !== undefined ||
        (typeof C.Cesium3DTileset === 'function' &&
          picked.primitive instanceof C.Cesium3DTileset)));

  function installSelection() {
    const canvas = _viewer?.scene?.canvas;
    if (
      _clickHandler ||
      !picking ||
      !canvas ||
      typeof C.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const owner = new C.ScreenSpaceEventHandler(canvas);
    _clickHandler = owner;
    owner.setInputAction((click) => {
      if (
        !_enabled ||
        _clickHandler !== owner ||
        (pointer && !pointer.isPointerFree()) ||
        !click?.position
      )
        return;
      const picked = _viewer.scene.pick(click.position);
      const pickedId = picking.resolvePickId(picked);
      const animalId = pickedId ? _entityAnimals.get(pickedId) : null;
      if (animalId) {
        layer.setParams({ animal: animalId });
        return;
      }
      if (pickedId && picking.isOwnedByOtherLayer(LAYER_ID, pickedId)) return;
      if (_animalId && isSurfacePick(picked)) layer.setParams({ animal: null });
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeSelection() {
    const owner = _clickHandler;
    _clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }

  function navigate(destination) {
    if (!_runNavigation) return;
    const generation = ++_navigationGeneration;
    const selection = `${_studyId}|${_animalId}`;
    _runNavigation(() => {
      if (
        !_enabled ||
        generation !== _navigationGeneration ||
        selection !== `${_studyId}|${_animalId}`
      )
        return;
      return _viewer.camera.flyTo({
        destination,
        duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
          ? 0
          : 1.4,
      });
    });
  }

  function focusAnimal(animal) {
    const [lon, lat] = lastFix(animal);
    navigate(C.Cartesian3.fromDegrees(lon, lat, ANIMAL_FOCUS_HEIGHT_M));
  }

  function focusShown() {
    const fixes = shownAnimals().map(lastFix);
    if (!fixes.length) return;
    const lons = fixes.map(([lon]) => lon);
    const lats = fixes.map(([, lat]) => lat);
    const pad = 1.5;
    navigate(
      C.Rectangle.fromDegrees(
        Math.max(-180, Math.min(...lons) - pad),
        Math.max(-90, Math.min(...lats) - pad),
        Math.min(180, Math.max(...lons) + pad),
        Math.min(90, Math.max(...lats) + pad),
      ),
    );
  }

  function schedulePoll(pending) {
    if (_pollTimer !== null) clearTimer(_pollTimer);
    _pollTimer = null;
    if (!_enabled || !pending) return;
    _pollTimer = setTimer(() => {
      _pollTimer = null;
      void layer.update();
    }, PENDING_POLL_MS);
  }

  /** The chosen animal: what, when, and whose data it is. */
  function animalLines(animal, study) {
    const [, , time] = lastFix(animal);
    return [
      `${shortName(animal.taxon)} ${animal.name} · ${wildlifeAge(time, now())} (${wildlifeTime(time)})`,
      `${t(study.label)} · ${study.owner} · ${t('{licence} (published dataset)', { licence: study.licence })}`,
    ];
  }

  function pendingLine() {
    const pending = _studies.filter(({ status }) => status === 'pending');
    if (!pending.length) return '';
    return tn(
      pending.length,
      'Fetching {count} study from Movebank…',
      'Fetching {count} studies from Movebank…',
      { count: formatNumber(pending.length) },
    );
  }

  /** Studies served from a copy past the cache TTL, oldest first. */
  function staleLine() {
    const stale = _studies.filter(({ status }) => status === 'stale');
    if (!stale.length) return '';
    const oldest = Math.min(
      ...stale.map(({ fetchedAt }) => fetchedAt ?? Infinity),
    );
    const count = formatNumber(stale.length);
    return Number.isFinite(oldest)
      ? tn(
          stale.length,
          '{count} study not refreshed since {age}',
          '{count} studies not refreshed since {age}',
          { count, age: wildlifeAge(oldest, now()) },
        )
      : tn(
          stale.length,
          '{count} study not refreshed for over an hour',
          '{count} studies not refreshed for over an hour',
          { count },
        );
  }

  const failedLine = () =>
    _lastError && _lastUpdate
      ? t('Refresh failed: {reason}', {
          reason: wildlifeErrorReason(_lastError),
        })
      : '';

  function summaryLines() {
    const shown = shownAnimals();
    const shownStudies = new Set(shown.map(({ study }) => study));
    const pending = _studies.some(({ status }) => status === 'pending');
    return [
      shown.length
        ? t('{animals} in {studies} · select an arrow', {
            animals: animals(shown.length),
            studies: studies(shownStudies.size),
          })
        : _lastUpdate
          ? pending
            ? ''
            : noneShown()
          : _lastError
            ? wildlifeErrorReason(_lastError)
            : t('Loading tracking data…'),
      pendingLine(),
      staleLine(),
      failedLine(),
      t(CAVEAT),
    ].filter(Boolean);
  }

  function studyLines(study) {
    const list = listedAnimals();
    const pages = Math.max(1, Math.ceil(list.length / WILDLIFE_PAGE_SIZE));
    const selected = selectedAnimal();
    if (selected)
      return [...animalLines(selected, study), failedLine()].filter(Boolean);
    const label = t(study.label);
    return [
      study.status === 'pending'
        ? t('{study} · fetching from Movebank…', { study: label })
        : study.status === 'withdrawn'
          ? t(
              '{study} · no longer public on Movebank; its tracks were removed',
              {
                study: label,
              },
            )
          : study.status === 'unavailable' && !list.length
            ? t('Movebank did not return this study')
            : !list.length
              ? `${label} · ${noneShown()}`
              : `${label} · ${animals(list.length)} · ${t('select a row')}${
                  pages > 1
                    ? ` · ${t('Page {page} of {pages}', { page: _page + 1, pages })}`
                    : ''
                }`,
      study.status === 'stale' && Number.isFinite(study.fetchedAt)
        ? t('Not refreshed since {age}', {
            age: wildlifeAge(study.fetchedAt, now()),
          })
        : '',
      failedLine(),
      t(CAVEAT),
    ].filter(Boolean);
  }

  function windowChips() {
    return Object.entries(WILDLIFE_WINDOWS).map(([id, { label, title }]) => ({
      id: `window-${id}`,
      label: t(label),
      title: t(title),
      active: _window === id,
      params: { window: id },
    }));
  }

  /** Colour is the only species cue on the globe, so the row names it. */
  function legend() {
    const counts = new Map();
    for (const animal of shownAnimals())
      counts.set(animal.taxon, (counts.get(animal.taxon) || 0) + 1);
    return [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([taxon, count], index) => ({
        label: shortName(taxon),
        color: speciesColor(taxon),
        count,
        ...(index === 0
          ? {
              blurb: t(
                'Colour shows species. Arrows point along the last move; a dot has not moved.',
              ),
            }
          : {}),
      }));
  }

  const layer = {
    id: LAYER_ID,
    name: 'Wildlife',
    icon: '🦢',
    source: 'Movebank',
    updateInterval: 1_800_000,

    init(viewer) {
      if (_viewer) throw new Error('Wildlife layer is already initialized');
      _viewer = viewer;
      _dataSource = new C.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    attachShellServices(services) {
      _runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
    },

    enable() {
      if (_enabled) return;
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      picking?.registerPickOwner(
        LAYER_ID,
        (id) => _enabled && _entityAnimals.has(String(id)),
      );
      installSelection();
      syncHorizonListener();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      schedulePoll(false);
      picking?.unregisterPickOwner(LAYER_ID);
      removeSelection();
      syncHorizonListener();
      _culledFrom = null;
      _poseSignature = null;
      if (_dataSource) {
        if (_studyId !== null) selectStudy(null);
        else selectAnimal(null);
        _dataSource.show = false;
      }
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      expireHeld();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _studies = holdStudies(snapshot.studies, snapshot.generatedAt);
        _animals = snapshot.animals;
        if (_studyId !== null && !studyOf(_studyId)) _studyId = null;
        clampPage();
        render();
        _lastUpdate = now();
        _lastError = null;
        schedulePoll(_studies.some(({ status }) => status === 'pending'));
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Wildlife] Fetch error:', e);
        _lastError = e?.message || msg('Tracking data unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
        notify();
      }
    },

    setParams(params = {}) {
      if (!_enabled) return;
      if (params.clear === true) {
        selectStudy(null);
        notify();
        return;
      }
      if (
        typeof params.window === 'string' &&
        WILDLIFE_WINDOWS[params.window]
      ) {
        _window = params.window;
        _page = 0;
        render();
        notify();
        return;
      }
      if (params.study !== undefined && studyOf(params.study)) {
        if (_studyId !== params.study) selectStudy(params.study);
        notify();
        if (params.focus === true) focusShown();
        return;
      }
      if (params.animal === null) {
        selectAnimal(null);
        notify();
        return;
      }
      if (typeof params.animal === 'string' && _markers.has(params.animal)) {
        const { animal } = _markers.get(params.animal);
        if (_studyId !== animal.study) selectStudy(animal.study);
        selectAnimal(animal.id);
        pageTo(animal.id);
        notify();
        if (params.focus === true) focusAnimal(animal);
        return;
      }
      if (params.page === 'next' || params.page === 'previous') {
        const pages = Math.ceil(listedAnimals().length / WILDLIFE_PAGE_SIZE);
        _page = Math.max(
          0,
          Math.min(pages - 1, _page + (params.page === 'next' ? 1 : -1)),
        );
        notify();
        return;
      }
      if (params.doi === true) {
        const study = studyOf(_studyId);
        if (study) openExternal(`https://doi.org/${study.doi}`);
        return;
      }
      if (params.movebank === true) openExternal(MOVEBANK_PAGE);
    },

    getRowControls() {
      const study = studyOf(_studyId);
      if (!study) {
        const counts = new Map();
        const latest = new Map();
        for (const animal of shownAnimals())
          counts.set(animal.study, (counts.get(animal.study) || 0) + 1);
        for (const animal of _animals)
          latest.set(
            animal.study,
            Math.max(latest.get(animal.study) || 0, lastFix(animal)[2]),
          );
        const ordered = [..._studies].sort(
          (a, b) =>
            (counts.get(b.id) || 0) - (counts.get(a.id) || 0) ||
            (latest.get(b.id) || 0) - (latest.get(a.id) || 0) ||
            a.name.localeCompare(b.name),
        );
        return {
          chips: [
            {
              id: 'movebank',
              // i18n-ignore: product name
              label: 'Movebank ↗',
              title: t(
                'Open Movebank, the source of the tracking data, in a new tab',
              ),
              params: { movebank: true },
            },
            ...windowChips(),
          ],
          legend: legend(),
          list: {
            ariaLabel: t('Tracking studies, most animals shown first'),
            items: ordered.map((entry, index) => {
              const age = latest.has(entry.id)
                ? wildlifeAge(latest.get(entry.id), now())
                : null;
              const state =
                entry.status === 'pending'
                  ? t('loading')
                  : entry.status === 'withdrawn'
                    ? t('no longer public')
                    : age !== null
                      ? entry.status === 'stale'
                        ? t('last fix {age} · not refreshed', { age })
                        : t('last fix {age}', { age })
                      : entry.status === 'unavailable'
                        ? t('unavailable')
                        : t('no public fixes');
              return {
                id: String(entry.id),
                ordinal: index + 1,
                lead: latest.has(entry.id)
                  ? String(counts.get(entry.id) || 0)
                  : '—',
                text: `${t(entry.label)} · ${state}`,
                params: { study: entry.id, focus: true },
              };
            }),
          },
          info: summaryLines().join(' · '),
          infoTitle: `${t('Select an animal on the globe, or a study in the list.')} ${t(DISCLAIMER)}`,
        };
      }
      const list = listedAnimals();
      const selected = selectedAnimal();
      const pages = Math.max(1, Math.ceil(list.length / WILDLIFE_PAGE_SIZE));
      const shown = list.slice(
        _page * WILDLIFE_PAGE_SIZE,
        (_page + 1) * WILDLIFE_PAGE_SIZE,
      );
      return {
        chips: [
          ...windowChips(),
          ...(pages > 1
            ? [
                {
                  id: 'previous',
                  label: t('‹ Prev'),
                  title: t('Previous page of animals'),
                  disabled: _page === 0,
                  params: { page: 'previous' },
                },
                {
                  id: 'next',
                  label: t('Next ›'),
                  title: t('Next page of animals'),
                  disabled: _page >= pages - 1,
                  params: { page: 'next' },
                },
              ]
            : []),
          {
            id: 'doi',
            // i18n-ignore: identifier scheme
            label: 'DOI ↗',
            title: t(
              'Open the published dataset and its citation (doi:{doi})',
              {
                doi: study.doi,
              },
            ),
            params: { doi: true },
          },
          {
            id: 'studies',
            label: t('All studies'),
            title: t('Back to the study list'),
            params: { clear: true },
          },
        ],
        legend: legend(),
        list: {
          ariaLabel: t(
            '{study} animals, latest fix first, page {page} of {pages}',
            { study: t(study.label), page: _page + 1, pages },
          ),
          items: shown.map((animal, index) => {
            const [, , time] = lastFix(animal);
            return {
              id: animal.id,
              ordinal: _page * WILDLIFE_PAGE_SIZE + index + 1,
              lead: wildlifeAgeShort(time, now()),
              text:
                study.species.length > 1
                  ? `${shortName(animal.taxon)} · ${animal.name}`
                  : animal.name,
              active: animal.id === _animalId,
              params: { animal: animal.id, focus: true },
            };
          }),
        },
        info: studyLines(study).join(' · '),
        infoTitle: `${selected ? `${speciesName(selected.taxon)}${selected.taxon ? ` (${selected.taxon})` : ''} ${selected.name}. ` : ''}${t(study.title)}. ${t(
          'Cite: {citation} {url} (Movebank study {id}; published dataset {licence}).',
          {
            citation: study.citation,
            url: `https://doi.org/${study.doi}`,
            id: study.id,
            licence: study.licence,
          },
        )} ${t(DISCLAIMER)}`,
      };
    },

    setRowControlsListener(value) {
      _listener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: _markers.size,
        lastUpdate: _lastUpdate,
        error: _lastError,
        partial: _studies.some(({ status }) => status !== 'fresh'),
      };
    },

    getDiagnostics() {
      return {
        enabled: _enabled,
        requestPending: Boolean(_request),
        pollScheduled: _pollTimer !== null,
        selectionActive: _clickHandler !== null,
        horizonCulling: _removePreRender !== null,
        window: _window,
        selectedStudy: _studyId,
        selectedAnimal: _animalId,
        studies: _studies.map(({ id, status }) => ({ id, status })),
        animals: _markers.size,
        tracks: [..._markers.values()].reduce(
          (sum, { tracks }) => sum + tracks.length,
          0,
        ),
      };
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _studies = [];
      _animals = [];
      _signature = null;
      _entityAnimals.clear();
      _markers.clear();
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _occluder = null;
      _listener = null;
      _runNavigation = null;
      _lastUpdate = null;
      _lastError = null;
    },
  };
  return layer;
}
