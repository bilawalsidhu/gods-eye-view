/**
 * Wikidata dossier: a vertical column of facts that types out beside a
 * selected aircraft, satellite or rocket launch and follows it on screen.
 *
 * Aircraft and satellites arrive on the tracking layers' selection lane
 * (`gev:awareness-subject-selected`); their lookup key (aircraft type, NORAD
 * id) is read from the shared context record, which the layer refreshes as
 * enrichment lands, and must settle before Wikidata is asked. Launches arrive
 * on `gev:launch-mission-selected` and sit at their pad. Like the selection
 * reticle it is a DOM surface positioned on `postRender`, so it never keeps
 * the render loop busy on its own.
 */
import * as Cesium from 'cesium';
import { getSelectedEntityContext } from '../data/contextStore.js';
import { createAircraftWikidataSource } from '../sources/aircraftWikidata.js';
import { createSpaceWikidataSource } from '../sources/spaceWikidata.js';
import { isLockTargetEnabled } from './selectionReticle.js';

export const WIKIDATA_DOSSIER_ROOT_ID = 'wikidata-dossier-root';
export const LAUNCH_MISSION_EVENT = 'gev:launch-mission-selected';
const LAUNCH_LAYER = 'rocket-launches';
const ACTIVE_CLASS = 'is-active';
const FLIP_CLASS = 'is-left';
/** How long the type must stay unchanged before it is looked up. */
const TYPE_SETTLE_MS = 700;
const TYPE_INTERVAL_MS = 18;
const CHARS_PER_TICK = 2;
/**
 * Clearance from the aircraft: past the lock reticle's arrows when shown,
 * otherwise past the tracked readout card centred above the aircraft.
 */
const OFFSET_LOCK_PX = 168;
const OFFSET_PLAIN_PX = 140;
const TRACKED_MATCH_RADIUS_M = 5000;
const ACCENT_PROPERTY = '--dossier-color';
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/]+\))$/i;

/**
 * Build the display rows for a lookup state.
 * @param {{status: string, query?: string, result?: object|null}} state
 * @returns {{title: string, image?: {url: string, file: string}|null,
 *   lines: ({label: string, value: string}|{section: string})[]}}
 */
export function dossierContent(state) {
  const type = state.query || 'subject';
  if (state.status === 'loading')
    return {
      title: 'Wikidata',
      lines: [{ label: 'Query', value: `${type} …` }],
    };
  if (state.status === 'error')
    return {
      title: 'Wikidata',
      lines: [{ label: 'Status', value: 'Unavailable — try again shortly' }],
    };
  if (state.status === 'empty' || !state.result?.lines?.length)
    return {
      title: 'Wikidata',
      lines: [{ label: 'Status', value: `No match for ${type}` }],
    };
  return {
    title: state.result.title,
    image: state.result.image?.url ? state.result.image : null,
    lines: [
      ...state.result.lines.filter((line) => line.label !== 'Model'),
      { label: 'Source', value: `Wikidata ${state.result.id} (CC0)` },
    ],
  };
}

/**
 * Per-layer subject kinds: how the lookup key and query text are read from
 * the context record, and how the dossier is fetched.
 */
const RECORD_KINDS = {
  flights: 'aircraft',
  military: 'aircraft',
  satellites: 'satellite',
};

function recordQuery(kind, record) {
  const properties = record?.properties || {};
  if (kind === 'aircraft') {
    const type = String(properties.type || '').trim();
    return type ? { key: type, query: type } : null;
  }
  const norad = String(properties.noradId || record?.id || '').trim();
  if (!norad) return null;
  const name = String(properties.name || record?.label || '').trim();
  return { key: norad, query: name || `NORAD ${norad}`, name };
}

/**
 * Install the Wikidata dossier on a viewer.
 * @param {object} viewer Cesium viewer.
 * @param {object} [options]
 * @param {object} [options.cesium]
 * @param {{lookup: Function}} [options.aircraftSource]
 * @param {{lookupSatellite: Function, lookupLaunch: Function}} [options.spaceSource]
 * @param {() => object|null} [options.getContext]
 * @param {Document} [options.doc]
 * @param {Window} [options.win]
 * @returns {() => void} Uninstall.
 */
export function installWikidataDossier(
  viewer,
  {
    cesium = Cesium,
    aircraftSource = null,
    spaceSource = null,
    getContext = () => getSelectedEntityContext(),
    doc = globalThis.document,
    win = globalThis.window,
  } = {},
) {
  const scene = viewer?.scene;
  if (!scene?.postRender || !doc) return () => {};
  let aircraft = aircraftSource;
  let space = spaceSource;
  const fetchDossier = (subjectKind, request, signal) => {
    if (subjectKind === 'aircraft') {
      aircraft ||= createAircraftWikidataSource();
      return aircraft.lookup(request.key, { signal });
    }
    space ||= createSpaceWikidataSource();
    return subjectKind === 'satellite'
      ? space.lookupSatellite(
          { noradId: request.key, name: request.name },
          { signal },
        )
      : space.lookupLaunch(request.launch, { signal });
  };

  const root = doc.createElement('div');
  root.id = WIKIDATA_DOSSIER_ROOT_ID;
  const panel = doc.createElement('section');
  panel.className = 'gev-dossier';
  panel.setAttribute('role', 'note');
  const title = doc.createElement('h2');
  title.className = 'gev-dossier__title';
  const list = doc.createElement('dl');
  list.className = 'gev-dossier__list';
  const figure = doc.createElement('figure');
  figure.className = 'gev-dossier__photo';
  figure.hidden = true;
  const photo = doc.createElement('img');
  photo.alt = '';
  photo.decoding = 'async';
  photo.setAttribute('referrerpolicy', 'no-referrer');
  const credit = doc.createElement('figcaption');
  credit.className = 'gev-dossier__credit';
  figure.append(photo, credit);
  photo.addEventListener?.('error', () => {
    figure.hidden = true;
  });
  panel.append(title, figure, list);
  root.appendChild(panel);
  const container = viewer.container;
  const parent = container?.parentElement || doc.body;
  if (container?.nextSibling) parent.insertBefore(root, container.nextSibling);
  else parent.appendChild(root);

  const scratchWindow = new cesium.Cartesian2();
  let subject = null;
  let shown = false;
  let typeTimer = null;
  let typingTimer = null;
  let lookupController = null;
  let accent = null;

  /** Match the subject's label color; null restores the CSS default. */
  function setAccent(color) {
    const value = SAFE_COLOR.test(String(color || '').trim())
      ? String(color).trim()
      : null;
    if (value === accent) return;
    accent = value;
    if (value) root.style.setProperty?.(ACCENT_PROPERTY, value);
    else root.style.removeProperty?.(ACCENT_PROPERTY);
  }

  const reducedMotion = () =>
    Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  function stopTyping() {
    if (typingTimer) win?.clearInterval?.(typingTimer);
    typingTimer = null;
    panel.classList.remove('is-typing');
  }

  function showPhoto(image, label) {
    if (!image?.url) {
      figure.hidden = true;
      photo.removeAttribute?.('src');
      credit.textContent = '';
      return;
    }
    photo.alt = `${label} (Wikimedia Commons)`;
    credit.textContent = `Photo: Wikimedia Commons · ${image.file}`;
    credit.title = image.file;
    if (photo.src !== image.url) photo.src = image.url;
    figure.hidden = false;
  }

  function render(state) {
    stopTyping();
    const content = dossierContent(state);
    title.textContent = '';
    showPhoto(content.image, content.title);
    list.replaceChildren();
    const segments = [{ node: title, text: content.title.toUpperCase() }];
    for (const line of content.lines) {
      if (line.section) {
        const heading = doc.createElement('dt');
        heading.className = 'gev-dossier__section';
        list.append(heading);
        segments.push({ node: heading, text: line.section.toUpperCase() });
        continue;
      }
      const term = doc.createElement('dt');
      const value = doc.createElement('dd');
      term.className = 'gev-dossier__label';
      value.className = 'gev-dossier__value';
      list.append(term, value);
      segments.push(
        { node: term, text: line.label.toUpperCase() },
        { node: value, text: line.value },
      );
    }
    panel.setAttribute(
      'aria-label',
      [
        content.title,
        ...content.lines.map((l) =>
          l.section ? l.section : `${l.label}: ${l.value}`,
        ),
      ]
        .join('. ')
        .slice(0, 600),
    );
    if (reducedMotion() || typeof win?.setInterval !== 'function') {
      for (const segment of segments) segment.node.textContent = segment.text;
      return;
    }
    let index = 0;
    let offset = 0;
    panel.classList.add('is-typing');
    typingTimer = win.setInterval(() => {
      let budget = CHARS_PER_TICK;
      while (budget > 0 && index < segments.length) {
        const segment = segments[index];
        const take = Math.min(budget, segment.text.length - offset);
        offset += take;
        budget -= take;
        segment.node.textContent = segment.text.slice(0, offset);
        segment.node.classList.add('is-cursor');
        if (offset >= segment.text.length) {
          segment.node.classList.remove('is-cursor');
          index += 1;
          offset = 0;
        }
      }
      if (index >= segments.length) stopTyping();
    }, TYPE_INTERVAL_MS);
  }

  function hide() {
    if (!shown) return;
    shown = false;
    root.classList.remove(ACTIVE_CLASS);
  }

  function clear() {
    subject = null;
    if (typeTimer) win?.clearTimeout?.(typeTimer);
    typeTimer = null;
    lookupController?.abort();
    lookupController = null;
    stopTyping();
    setAccent(null);
    hide();
  }

  function lookup(request) {
    lookupController?.abort();
    const controller = new AbortController();
    lookupController = controller;
    const current = subject;
    const { query } = request;
    render({ status: 'loading', query });
    Promise.resolve()
      .then(() => fetchDossier(current.kind, request, controller.signal))
      .then(
        (result) => ({ status: result ? 'ready' : 'empty', query, result }),
        () => ({ status: 'error', query }),
      )
      .then((state) => {
        if (controller.signal.aborted || subject !== current) return;
        render(state);
        scene.requestRender?.();
      });
  }

  function subjectRecord() {
    const record = getContext();
    if (
      !record ||
      record.layerId !== subject?.layerId ||
      String(record.id) !== subject.id
    )
      return null;
    return record;
  }

  function watchKey(record) {
    const request = recordQuery(subject.kind, record);
    if (!request) return;
    const { key } = request;
    if (key === subject.pendingKey || key === subject.key) return;
    subject.pendingKey = key;
    if (typeTimer) win?.clearTimeout?.(typeTimer);
    typeTimer = win?.setTimeout?.(() => {
      typeTimer = null;
      if (!subject || subject.pendingKey !== key) return;
      subject.key = key;
      lookup(request);
    }, TYPE_SETTLE_MS);
  }

  function subjectPosition(record) {
    if (subject.kind === 'launch') return subject.position;
    const tracked = viewer.trackedEntity;
    const trackedPosition = tracked?.position?.getValue?.(
      viewer.clock?.currentTime,
    );
    // Satellites outrun the radius match (~7.6 km/s), so prefer the tag.
    const isSubject = tracked?.gevTrackedId
      ? tracked.gevTrackedId === `${subject.layerId}:${subject.id}`
      : subject.position &&
        trackedPosition &&
        cesium.Cartesian3.distance(trackedPosition, subject.position) <=
          TRACKED_MATCH_RADIUS_M;
    if (trackedPosition && isSubject) {
      if (tracked.gevLabelModel?.accent)
        setAccent(tracked.gevLabelModel.accent);
      subject.position = cesium.Cartesian3.clone(
        trackedPosition,
        subject.position,
      );
      return trackedPosition;
    }
    if (
      Number.isFinite(record?.latitude) &&
      Number.isFinite(record?.longitude)
    ) {
      subject.position = cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        subject.height,
        undefined,
        subject.position || undefined,
      );
    }
    return subject.position;
  }

  function isVisibleFromCamera(position) {
    const cameraPosition = scene.camera?.positionWC;
    if (!cameraPosition || typeof cesium.EllipsoidalOccluder !== 'function')
      return true;
    const ellipsoid = scene.globe?.ellipsoid || cesium.Ellipsoid?.WGS84;
    if (!ellipsoid) return true;
    return new cesium.EllipsoidalOccluder(
      ellipsoid,
      cameraPosition,
    ).isPointVisible(position);
  }

  function place() {
    if (!subject) return;
    let record = null;
    if (subject.kind !== 'launch') {
      record = subjectRecord();
      if (!record) return clear();
      watchKey(record);
    }
    if (!subject.key) return hide();
    const position = subjectPosition(record);
    const point =
      position &&
      isVisibleFromCamera(position) &&
      scene.cartesianToCanvasCoordinates(position, scratchWindow);
    const width = scene.canvas?.clientWidth || 0;
    const height = scene.canvas?.clientHeight || 0;
    if (
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      (width && point.x > width) ||
      (height && point.y > height)
    )
      return hide();
    const offset = isLockTargetEnabled(doc) ? OFFSET_LOCK_PX : OFFSET_PLAIN_PX;
    const panelWidth = panel.offsetWidth || 260;
    const flip = width && point.x + offset + panelWidth > width - 8;
    const x = flip ? point.x - offset - panelWidth : point.x + offset;
    const panelHeight = panel.offsetHeight || 0;
    const y = Math.max(
      8,
      Math.min(
        point.y - panelHeight / 2,
        (height || Infinity) - panelHeight - 8,
      ),
    );
    root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    root.classList.toggle(FLIP_CLASS, Boolean(flip));
    if (!shown) {
      shown = true;
      root.classList.add(ACTIVE_CLASS);
    }
  }

  function onSelected(event) {
    const detail = event?.detail || {};
    const kind = RECORD_KINDS[detail.layerId];
    if (!kind || detail.id == null) {
      // Any other selection replaces the current subject.
      if (detail.layerId) clear();
      return;
    }
    const id = String(detail.id);
    if (subject?.layerId === detail.layerId && subject.id === id) return;
    clear();
    const position =
      detail.position && cesium.Cartesian3.clone(detail.position);
    const cartographic =
      position && cesium.Cartographic?.fromCartesian?.(position);
    subject = {
      kind,
      layerId: detail.layerId,
      id,
      position: position || null,
      height: Number.isFinite(cartographic?.height) ? cartographic.height : 0,
      key: null,
      pendingKey: null,
    };
    scene.requestRender?.();
  }

  function onLaunchSelected(event) {
    const detail = event?.detail || {};
    if (detail.id == null) {
      if (subject?.kind === 'launch') clear();
      return;
    }
    const id = String(detail.id);
    if (subject?.kind === 'launch' && subject.id === id) return;
    const lat = Number(detail.lat);
    const lon = Number(detail.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return clear();
    clear();
    const launch = {
      rocket: String(detail.rocket || ''),
      missionName: String(detail.missionName || ''),
      launchYear: Number.isFinite(Number(detail.launchYear))
        ? Number(detail.launchYear)
        : null,
    };
    const query =
      [launch.rocket, launch.missionName].filter(Boolean).join(' · ') ||
      String(detail.name || 'launch');
    subject = {
      kind: 'launch',
      layerId: LAUNCH_LAYER,
      id,
      position: cesium.Cartesian3.fromDegrees(lon, lat, 0),
      height: 0,
      key: id,
      pendingKey: null,
    };
    setAccent(detail.accent);
    lookup({ key: id, query, launch });
    scene.requestRender?.();
  }

  function onCleared(event) {
    const detail = event?.detail || {};
    if (!subject || detail.layerId !== subject.layerId) return;
    if (detail.reason === 'evicted') return;
    if (detail.id != null && String(detail.id) !== subject.id) return;
    clear();
  }

  function onEntitySelected(event) {
    if (subject && event?.detail?.layerId !== subject.layerId) clear();
  }

  const removePostRender = scene.postRender.addEventListener(place);
  const listeners = [
    ['gev:awareness-subject-selected', onSelected],
    ['gev:awareness-subject-cleared', onCleared],
    ['gev:entity-selected', onEntitySelected],
    [LAUNCH_MISSION_EVENT, onLaunchSelected],
  ];
  for (const [name, fn] of listeners) win?.addEventListener?.(name, fn);

  return () => {
    for (const [name, fn] of listeners) win?.removeEventListener?.(name, fn);
    removePostRender?.();
    clear();
    root.remove();
  };
}
