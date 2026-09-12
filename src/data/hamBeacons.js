/**
 * Beacons layer — the 18 NCDXF/IARU International Beacon Project HF beacons
 * plus HamRig's VHF/UHF beacon list, as globe markers you can watch and tune.
 *
 * The IBP table and slot maths live in `./ncdxfBeacons.js` (static, no
 * network). While the layer is enabled a 1 s ticker (aligned to the UTC
 * second) marks the beacon transmitting on each of the five bands with a
 * pulsing ring and the label `14.100 ▶ OH2B · 10W`. VHF beacons come from the
 * same-origin proxy `/api/hamrig/beacons/vhf`; that route is login-gated and
 * answers 403 when HamRig credentials are not configured — the layer treats
 * that as "no VHF beacons", not as an error.
 *
 * `tuneBeacon(call, band)` hands off to the Web Receivers layer: it makes
 * sure that layer is enabled (through the data manager given to
 * `setDataManager`) and loaded, picks the closest online receiver to the
 * current view centre that covers the beacon frequency, tunes it in CW and
 * opens the receiver dock with the same `gev:web-receiver-tune` event the
 * voice tools use. Beacons are heard far from where they stand, so the view
 * centre — not the beacon — is the anchor.
 *
 * Module state mirrors `./webReceivers.js`: a CustomDataSource of points, a
 * click owner registration held only while presentation is allowed, and a
 * small pub/sub for the panel. Pure helpers are in `./hamBeaconsLogic.js`.
 */

import * as Cesium from 'cesium';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import { HAMRIG_MY_STATION_CREDIT, registerDynamicCredit } from './dataCredits.js';
import { IBP_BEACONS, ibpSlot, isIbpOffAir } from './ncdxfBeacons.js';
import { WEB_RECEIVERS_LAYER_ID, webReceiversLayer } from './webReceivers.js';
import { formatHz } from './hamRadioShared.js';
import { deriveViewCentre } from './hamRepeatersLogic.js';
import {
  BEACON_BAND_FILTERS,
  BEACON_KIND_FILTERS,
  IBP_OFF_AIR_COLOR,
  LIST_LIMIT,
  TICK_MS,
  TUNE_MODE,
  VHF_ENDPOINT,
  beaconMatchesFilter,
  beaconTuneTarget,
  chooseBeaconReceiver,
  ibpId,
  ibpItems,
  ibpMarkerStyle,
  ibpTxLabel,
  normalizeBeaconFilter,
  parseVhfResponse,
  pulseRingPixels,
  resolveBeaconQuery,
  slotSummary,
  transmittingByCall,
  trimList,
  vhfItems,
  vhfMarkerStyle,
} from './hamBeaconsLogic.js';

export const HAM_BEACONS_LAYER_ID = 'ham-beacons';
const PREFIX = 'ham-beacon:';
const FETCH_TIMEOUT_MS = 20_000;
const GLOBE_INTERACTION_MAX_DISTANCE_M = 30_000_000;
const FLY_ALTITUDE_M = 600_000;
const HOVER_THROTTLE_MS = 80;
const OUTLINE_COLOR = '#06131a';
const LABEL_FONT = '12px "JetBrains Mono", monospace';

let _viewer = null;
let _dataSource = null;
let _clickHandler = null;
let _enabled = false;
let _managerPresentation = null;
let _loading = false;
let _error = null;
let _stale = false;
let _updatedAt = null;
let _vhf = Object.freeze([]);
let _vhfById = new Map();
let _vhfForbidden = false;
let _vhfLoaded = false;
const _ibpRender = new Map(); // call → { beacon, point, ring, signature }
const _vhfRender = new Map(); // item id → { beacon, entity }
let _selectedId = null;
let _selectedEntity = null;
let _hoverId = null;
let _hoverEntity = null;
let _lastHoverPick = 0;
let _filter = normalizeBeaconFilter();
let _slot = null;
let _ticker = null;
let _tickerLead = null;
let _lastTune = null;
let _dataManager = null;
let _abort = null;
let _requestGeneration = 0;
let _loadPromise = null;
const _listeners = new Set();

function cssColor(hex, alpha = 1) {
  return Cesium.Color.fromCssColorString(hex || '#ffffff').withAlpha(alpha);
}

function toDegrees(radians) {
  return Cesium.Math.toDegrees(radians);
}

function emitState() {
  const state = getHamBeaconsUIState();
  for (const listener of _listeners) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[ham-beacons] listener failed', error);
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  _listeners.add(listener);
  try {
    listener(getHamBeaconsUIState());
  } catch (error) {
    console.warn('[ham-beacons] listener failed', error);
  }
  return () => _listeners.delete(listener);
}

function presentationAllowed() {
  if (!_managerPresentation) return _enabled;
  return _managerPresentation.enabled && _managerPresentation.lifecycleState === 'enabled' && !_managerPresentation.uncertain;
}

function syncPresentation() {
  const visible = presentationAllowed();
  if (_dataSource) _dataSource.show = visible;
  if (_selectedEntity) _selectedEntity.show = visible && Boolean(_selectedId);
  if (_hoverEntity) _hoverEntity.show = visible && Boolean(_hoverId);
  if (visible && _viewer && !_clickHandler) installInteraction();
  if (!visible) removeInteraction();
}

function markerPosition(item) {
  return Cesium.Cartesian3.fromDegrees(item.lon, item.lat, 30);
}

function ibpEntityId(call) {
  return `${PREFIX}ibp:${call}`;
}

function ringEntityId(call) {
  return `${PREFIX}ring:${call}`;
}

function vhfEntityId(id) {
  return `${PREFIX}${id}`;
}

/** Entity id → item id (`ibp:OH2B` / `vhf:CALL:HZ`); rings map to their beacon; helpers → null. */
function itemIdFromEntityId(text) {
  const id = String(text || '');
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  if (rest === 'selected' || rest === 'hover') return null;
  if (rest.startsWith('ring:')) return `ibp:${rest.slice(5)}`;
  return rest;
}

function itemById(id) {
  if (!id) return null;
  if (String(id).startsWith('vhf:')) return _vhfById.get(id) || null;
  return resolveBeaconQuery(id, { vhf: _vhf });
}

/** UI row (with live transmit / heard state) for an item id. */
function uiItem(id, nowMs = Date.now()) {
  if (!id) return null;
  if (String(id).startsWith('ibp:')) return ibpItems(nowMs, { selectedId: _selectedId }).find((row) => row.id === id) || null;
  const beacon = _vhfById.get(id);
  return beacon ? vhfItems([beacon], nowMs, { selectedId: _selectedId })[0] : null;
}

function labelGraphics(pixelOffsetY) {
  return {
    text: '',
    font: LABEL_FONT,
    fillColor: Cesium.Color.WHITE,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, pixelOffsetY),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    showBackground: true,
    backgroundColor: cssColor(OUTLINE_COLOR, 0.75),
  };
}

function buildIbpEntities() {
  if (!_dataSource || _ibpRender.size) return;
  for (const beacon of IBP_BEACONS) {
    const style = ibpMarkerStyle({ offAir: isIbpOffAir(beacon.call) });
    const position = markerPosition(beacon);
    const point = _dataSource.entities.add({
      id: ibpEntityId(beacon.call),
      position,
      point: {
        pixelSize: style.pixelSize,
        color: cssColor(style.color, style.alpha),
        outlineColor: cssColor(OUTLINE_COLOR),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(100_000, 1.2, 12_000_000, 1),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
      },
    });
    const ring = _dataSource.entities.add({
      id: ringEntityId(beacon.call),
      position,
      show: false,
      point: {
        pixelSize: new Cesium.CallbackProperty(() => pulseRingPixels(Date.now()), false),
        color: Cesium.Color.TRANSPARENT,
        outlineColor: cssColor(style.color, 0.95),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: labelGraphics(-24),
    });
    _ibpRender.set(beacon.call, { beacon, point, ring, signature: null });
  }
}

/** Apply the current slot to the IBP markers (only entities whose state changed are touched). */
function applySlotStyles() {
  if (!_slot) return;
  const tx = transmittingByCall(_slot);
  const visible = beaconMatchesFilter({ kind: 'ibp' }, _filter);
  for (const [call, render] of _ibpRender) {
    const row = tx.get(call) || null;
    const offAir = isIbpOffAir(call);
    const selected = _selectedId === ibpId(call);
    const signature = `${row ? `${row.khz}|${row.powerStep}` : ''}|${offAir}|${visible}|${selected}`;
    if (signature === render.signature) continue;
    render.signature = signature;
    const style = ibpMarkerStyle({ offAir, transmitting: Boolean(row), selected });
    render.point.point.color = cssColor(style.color, style.alpha);
    render.point.point.pixelSize = style.pixelSize;
    render.point.show = visible;
    const active = Boolean(row) && !offAir;
    render.ring.show = visible && Boolean(row);
    if (row) {
      render.ring.label.text = ibpTxLabel({ khz: row.khz, call, powerStep: row.powerStep, offAir });
      render.ring.point.outlineColor = cssColor(active ? row.color : IBP_OFF_AIR_COLOR, active ? 0.95 : 0.5);
      render.ring.point.show = active;
    }
  }
}

function restyleVhf() {
  const nowMs = Date.now();
  for (const { beacon, entity } of _vhfRender.values()) {
    const style = vhfMarkerStyle(beacon, nowMs, { selected: _selectedId === beacon.id });
    entity.point.color = cssColor(style.color, style.alpha);
    entity.point.pixelSize = style.pixelSize;
    entity.show = beaconMatchesFilter(beacon, _filter);
  }
}

function restyleAll() {
  for (const render of _ibpRender.values()) render.signature = null;
  applySlotStyles();
  restyleVhf();
  updateSelectionEntity();
}

function reconcileVhf(beacons) {
  for (const { entity } of _vhfRender.values()) _dataSource?.entities.remove(entity);
  _vhfRender.clear();
  _vhf = Object.freeze([...beacons]);
  if (_vhf.length && _viewer) registerDynamicCredit(_viewer, HAMRIG_MY_STATION_CREDIT);
  _vhfById = new Map(_vhf.map((beacon) => [beacon.id, beacon]));
  if (_selectedId && String(_selectedId).startsWith('vhf:') && !_vhfById.has(_selectedId)) _selectedId = null;
  if (_hoverId && String(_hoverId).startsWith('vhf:') && !_vhfById.has(_hoverId)) setHover(null);
  if (_dataSource) {
    const nowMs = Date.now();
    for (const beacon of _vhf) {
      const style = vhfMarkerStyle(beacon, nowMs, { selected: _selectedId === beacon.id });
      const entity = _dataSource.entities.add({
        id: vhfEntityId(beacon.id),
        position: markerPosition(beacon),
        show: beaconMatchesFilter(beacon, _filter),
        point: {
          pixelSize: style.pixelSize,
          color: cssColor(style.color, style.alpha),
          outlineColor: cssColor(OUTLINE_COLOR),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(100_000, 1.2, 12_000_000, 1),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, GLOBE_INTERACTION_MAX_DISTANCE_M),
        },
      });
      _vhfRender.set(beacon.id, { beacon, entity });
    }
  }
  updateSelectionEntity();
}

function selectionText(item) {
  if (!item) return '';
  if (item.kind === 'ibp') {
    const now = item.transmitting
      ? `now on ${(item.transmitting.khz / 1000).toFixed(3)} · ${item.transmitting.powerStep === 'call' ? 'ID' : item.transmitting.powerStep}`
      : (item.nextKhz ? `next ${(item.nextKhz / 1000).toFixed(3)} in ${item.secondsUntilNext} s` : '');
    return `${item.call} · ${item.location}\nNCDXF/IBP${item.offAir ? ' · off air' : ''}${now ? ` · ${now}` : ''}`;
  }
  const where = item.location || item.locator || '';
  const heard = item.lastHeard?.atIso
    ? `heard ${item.heardAge} ago${item.lastHeard.spotter ? ` by ${item.lastHeard.spotter}` : ''}${Number.isFinite(item.lastHeard.snr) ? ` (${item.lastHeard.snr} dB)` : ''}`
    : 'not heard recently';
  return `${item.call} · ${item.frequencyLabel}\n${where ? `${where} · ` : ''}${heard}`;
}

function updateSelectionEntity() {
  if (!_viewer) return;
  const item = uiItem(_selectedId);
  if (!item) {
    if (_selectedEntity) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    return;
  }
  const position = markerPosition(item);
  const text = selectionText(item);
  if (!_selectedEntity) {
    _selectedEntity = _viewer.entities.add({
      id: `${PREFIX}selected`,
      position,
      point: {
        pixelSize: 22,
        color: Cesium.Color.TRANSPARENT,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: { ...labelGraphics(-22), text },
    });
  } else {
    _selectedEntity.position = position;
    _selectedEntity.label.text = text;
  }
  _selectedEntity.show = presentationAllowed();
}

function setHover(id) {
  const next = id && id !== _selectedId ? id : null;
  if (next === _hoverId) return;
  _hoverId = next;
  if (!_viewer) return;
  const item = uiItem(_hoverId);
  if (!item) {
    if (_hoverEntity) _hoverEntity.show = false;
    return;
  }
  const text = item.kind === 'ibp'
    ? `${item.call} · ${item.location}`
    : `${item.call} · ${item.frequencyLabel}${item.heardRecently ? ' · heard' : ''}`;
  if (!_hoverEntity) {
    _hoverEntity = _viewer.entities.add({
      id: `${PREFIX}hover`,
      position: markerPosition(item),
      label: { ...labelGraphics(-16), text },
    });
  } else {
    _hoverEntity.position = markerPosition(item);
    _hoverEntity.label.text = text;
  }
  _hoverEntity.show = presentationAllowed();
}

function itemIdFromPick(picked) {
  const id = resolvePickId(picked);
  if (Array.isArray(id)) {
    const first = id.find((entity) => String(entity?.id || '').startsWith(PREFIX));
    return first ? itemIdFromEntityId(first.id) : null;
  }
  return itemIdFromEntityId(id);
}

function pickedBeaconAt(position) {
  const scene = _viewer?.scene;
  if (!scene || !position) return null;
  const picked = scene.pick(position);
  if (isOwnedByOtherLayer(HAM_BEACONS_LAYER_ID, resolvePickId(picked))) return null;
  const id = itemIdFromPick(picked);
  return id && itemById(id) ? id : null;
}

function installInteraction() {
  if (!_viewer || _clickHandler) return;
  registerPickOwner(HAM_BEACONS_LAYER_ID, (id) => typeof id === 'string' && id.startsWith(PREFIX));
  _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
  _clickHandler.setInputAction((click) => {
    if (!presentationAllowed()) return;
    const id = pickedBeaconAt(click.position);
    if (!id) return;
    selectHamBeacon(id, { origin: 'user' });
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('gev:ham-beacon-selected', { detail: { beaconId: id } }));
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  _clickHandler.setInputAction((movement) => {
    if (!presentationAllowed()) return;
    const now = Date.now();
    if (now - _lastHoverPick < HOVER_THROTTLE_MS) return;
    _lastHoverPick = now;
    setHover(pickedBeaconAt(movement.endPosition));
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

function removeInteraction() {
  unregisterPickOwner(HAM_BEACONS_LAYER_ID);
  _clickHandler?.destroy();
  _clickHandler = null;
  setHover(null);
}

/** One ticker step: recompute the slot, restyle the IBP markers, refresh the panel. */
function tick() {
  _slot = ibpSlot(Date.now());
  applySlotStyles();
  if (_selectedId && String(_selectedId).startsWith('ibp:')) updateSelectionEntity();
  emitState();
}

function startTicker() {
  stopTicker();
  tick();
  // Align to the UTC second so power-step changes (at 6, 7, 8, 9 s into a slot) land on time.
  const lead = TICK_MS - (Date.now() % TICK_MS) + 15;
  _tickerLead = setTimeout(() => {
    _tickerLead = null;
    tick();
    _ticker = setInterval(tick, TICK_MS);
  }, lead);
}

function stopTicker() {
  if (_tickerLead) clearTimeout(_tickerLead);
  _tickerLead = null;
  if (_ticker) clearInterval(_ticker);
  _ticker = null;
}

/** Snapshot consumed by the panel and the voice tools (frozen). */
export function getHamBeaconsUIState() {
  const nowMs = Date.now();
  const ibp = ibpItems(nowMs, { selectedId: _selectedId });
  const vhf = vhfItems(_vhf, nowMs, { selectedId: _selectedId });
  const items = trimList([...ibp, ...vhf].filter((item) => beaconMatchesFilter(item, _filter)), LIST_LIMIT);
  const selected = _selectedId
    ? (ibp.find((item) => item.id === _selectedId) || vhf.find((item) => item.id === _selectedId) || null)
    : null;
  return Object.freeze({
    enabled: _enabled,
    loading: _loading,
    error: _error,
    stale: _stale,
    updatedAt: _updatedAt,
    count: ibp.length + vhf.length,
    ibpCount: ibp.length,
    vhfCount: vhf.length,
    vhfForbidden: _vhfForbidden,
    vhfLoaded: _vhfLoaded,
    selectedId: _selectedId,
    selected,
    filter: { ..._filter },
    filters: { kinds: BEACON_KIND_FILTERS, bands: BEACON_BAND_FILTERS },
    items: Object.freeze(items),
    ibp: Object.freeze(ibp),
    vhf: Object.freeze(vhf),
    slot: slotSummary(nowMs),
    lastTune: _lastTune,
  });
}

/** Select a beacon by item id or callsign; optionally fly to it. */
export function selectHamBeacon(query, { flyTo = false, origin = 'programmatic' } = {}) {
  const item = query ? resolveBeaconQuery(query, { vhf: _vhf }) : null;
  if (!item) {
    _selectedId = null;
    restyleAll();
    emitState();
    return null;
  }
  _selectedId = item.id;
  if (_hoverId === item.id) setHover(null);
  restyleAll();
  if (flyTo && _viewer) flyToHamBeacon(item);
  emitState();
  return uiItem(item.id) || item;
}

/** Fly to one beacon at a regional altitude. */
export function flyToHamBeacon(item, { altitudeM = FLY_ALTITUDE_M } = {}) {
  if (!_viewer || !item || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return false;
  _viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(item.lon, item.lat, altitudeM),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
    duration: 2.2,
  });
  return true;
}

/** Frame the IBP network, the VHF beacons, or both (`kind` 'ibp'|'vhf'|'all'). */
export function frameHamBeacons(kind = 'all', { padding = 1.4 } = {}) {
  if (!_viewer) return false;
  const which = String(kind || 'all').toLowerCase();
  const rows = [];
  if (which === 'all' || which === 'ibp') rows.push(...IBP_BEACONS);
  if (which === 'all' || which === 'vhf') rows.push(..._vhf);
  const points = rows.filter((row) => beaconMatchesFilter({ kind: row.kind || 'ibp', band: row.band }, _filter)).map(markerPosition);
  if (!points.length) return false;
  const sphere = Cesium.BoundingSphere.fromPoints(points);
  sphere.radius = Math.max(sphere.radius * padding, 60_000);
  _viewer.camera.flyToBoundingSphere(sphere, {
    duration: 2.4,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-60), sphere.radius * 2.6),
  });
  return true;
}

/** Change the panel filter (`{ kind:'all'|'ibp'|'vhf', band }`). */
export function setHamBeaconsFilter(next = {}) {
  _filter = normalizeBeaconFilter(next, _filter);
  restyleAll();
  emitState();
}

/** Resolve an item id or callsign (case-insensitive) to a beacon item, or null. */
export function resolveHamBeacon(query) {
  const item = resolveBeaconQuery(query, { vhf: _vhf });
  return item ? (uiItem(item.id) || item) : null;
}

/** The data manager is needed to switch the Web Receivers layer on for a tune. */
export function setDataManager(dataManager) {
  _dataManager = dataManager || null;
}

/** Where the user is looking (look-at point pulled back on horizon gazes), or null. */
function viewCentre() {
  const camera = _viewer?.camera;
  const carto = camera?.positionCartographic;
  if (!carto) return null;
  const nadir = { lat: toDegrees(carto.latitude), lon: toDegrees(carto.longitude) };
  let hit = null;
  const canvas = _viewer.scene?.canvas;
  const width = canvas?.clientWidth || canvas?.width || 0;
  const height = canvas?.clientHeight || canvas?.height || 0;
  if (width > 0 && height > 0) {
    try {
      const cartesian = camera.pickEllipsoid(new Cesium.Cartesian2(width / 2, height / 2), Cesium.Ellipsoid.WGS84);
      if (cartesian) {
        const hitCarto = Cesium.Cartographic.fromCartesian(cartesian);
        hit = { lat: toDegrees(hitCarto.latitude), lon: toDegrees(hitCarto.longitude) };
      }
    } catch {
      hit = null;
    }
  }
  return deriveViewCentre({ nadir, hit, heightM: carto.height });
}

async function ensureWebReceivers({ origin, signal }) {
  const manager = _dataManager;
  if (manager?.layers?.has?.(WEB_RECEIVERS_LAYER_ID) && typeof manager.setEnabled === 'function') {
    let enabled = false;
    try {
      enabled = manager.isEnabled?.(WEB_RECEIVERS_LAYER_ID) === true;
    } catch {
      enabled = false;
    }
    if (!enabled) {
      const options = { origin };
      if (signal) options.signal = signal;
      await manager.setEnabled(WEB_RECEIVERS_LAYER_ID, true, options);
    }
  }
  if (signal?.aborted) throw Object.assign(new Error('Tune cancelled'), { name: 'AbortError' });
  await webReceiversLayer.ensureLoaded();
  if (!webReceiversLayer.getReceivers().length) throw new Error('Web receiver directory is empty');
}

/**
 * Tune a web receiver near the view centre to a beacon.
 * `call` may be an IBP or VHF callsign (or item id); `band` an IBP band
 * ('20m', 14100, '14.100'). With no call the beacon currently on `band` is
 * used. Returns `{ ok, beacon, receiver, distanceKm, hz, mode, url, ... }` —
 * never throws.
 */
export async function tuneBeacon(call = null, band = null, { origin = 'user', signal = null } = {}) {
  const target = beaconTuneTarget({ call, band, nowMs: Date.now(), vhf: _vhf });
  if (!target) {
    const what = [call ? `beacon ${String(call).toUpperCase()}` : null, band ? `band ${band}` : null].filter(Boolean).join(' on ');
    return { ok: false, action: 'tune_beacon', error: what ? `No IBP or VHF beacon matches ${what}` : 'A beacon callsign or an IBP band is required' };
  }
  try {
    await ensureWebReceivers({ origin, signal });
  } catch (error) {
    return { ok: false, action: 'tune_beacon', error: error?.message || 'Web receivers unavailable', beacon: target };
  }
  const centre = viewCentre() || { lat: target.lat, lon: target.lon, source: 'beacon' };
  const choice = chooseBeaconReceiver({ receivers: webReceiversLayer.getReceivers(), hz: target.hz, centre });
  if (!choice.best) {
    return { ok: false, action: 'tune_beacon', error: `No web receiver covering ${formatHz(target.hz)} is available`, beacon: target, centre, reason: choice.reason };
  }
  const receiver = choice.best.receiver;
  const tuned = webReceiversLayer.tune({ receiverId: receiver.id, hz: target.hz, mode: TUNE_MODE });
  if (!tuned.ok) {
    return { ok: false, action: 'tune_beacon', error: tuned.error, beacon: target, receiver: { id: receiver.id, name: receiver.name } };
  }
  webReceiversLayer.selectReceiver(receiver.id, { flyTo: true, origin });
  selectHamBeacon(target.id, { origin });
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('gev:web-receiver-tune', {
      detail: { receiverId: receiver.id, url: tuned.url, openIn: 'dock', origin },
    }));
  }
  const when = target.kind === 'ibp'
    ? (target.active ? `transmitting now (${target.powerStep === 'call' ? 'callsign' : target.powerStep})`
      : (target.offAir ? 'listed off air' : `next transmission in ${target.secondsUntil} s`))
    : (target.lastHeard?.atIso ? 'continuous beacon' : 'continuous beacon (not heard recently)');
  _lastTune = Object.freeze({
    at: new Date().toISOString(),
    beaconId: target.id,
    call: target.call,
    kind: target.kind,
    khz: target.khz,
    band: target.band,
    hz: target.hz,
    receiverId: receiver.id,
    receiverName: receiver.name,
    distanceKm: choice.best.distanceKm,
    url: tuned.url,
    when,
  });
  emitState();
  return {
    ok: true,
    action: 'tune_beacon',
    beacon: target,
    receiver: { id: receiver.id, name: receiver.name, type: receiver.type, typeLabel: receiver.typeLabel, site: receiver.site, url: receiver.url },
    distanceKm: choice.best.distanceKm,
    centre,
    hz: target.hz,
    frequencyLabel: tuned.frequencyLabel,
    mode: tuned.mode,
    url: tuned.url,
    covers: tuned.covers,
    secondsUntil: target.secondsUntil,
    active: target.active,
    offAir: target.offAir,
    when,
    reason: `${choice.reason} · ${when}`,
  };
}

async function fetchVhf(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(VHF_ENDPOINT, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Load the VHF list. 403 → forbidden (empty, no error); any failure lands in `error`/`stale`. Never rejects. */
async function loadVhf({ signal = null } = {}) {
  if (_loadPromise) return _loadPromise;
  const generation = ++_requestGeneration;
  _abort?.abort();
  _abort = new AbortController();
  const outer = _abort;
  const onOuterAbort = () => outer.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  _loading = true;
  _error = null;
  emitState();
  _loadPromise = (async () => {
    try {
      const result = await fetchVhf(outer.signal);
      if (generation !== _requestGeneration) return;
      const parsed = parseVhfResponse(result);
      if (parsed.error) {
        _error = parsed.error;
        _stale = _vhf.length > 0;
        return;
      }
      _vhfForbidden = parsed.forbidden;
      _vhfLoaded = true;
      reconcileVhf(parsed.beacons);
      _updatedAt = parsed.updatedAt || new Date().toISOString();
      _stale = false;
    } catch (error) {
      if (generation !== _requestGeneration || error?.name === 'AbortError') return;
      _error = error?.message || 'VHF beacon feed unavailable';
      _stale = _vhf.length > 0;
    } finally {
      signal?.removeEventListener('abort', onOuterAbort);
      if (generation === _requestGeneration) {
        _loading = false;
        _abort = null;
        emitState();
      }
      _loadPromise = null;
    }
  })();
  return _loadPromise;
}

/** Resolve once the VHF list has been attempted (IBP is always available). */
async function ensureLoaded() {
  if (_loadPromise) await _loadPromise;
  else if (!_vhfLoaded && !_vhfForbidden) await loadVhf();
  return { ibp: IBP_BEACONS, vhf: _vhf };
}

/** Beacons layer lifecycle implementation. */
export const hamBeaconsLayer = {
  id: HAM_BEACONS_LAYER_ID,
  name: 'Beacons',
  icon: '📡',
  source: 'NCDXF/IBP · HamRig',
  updateInterval: 10 * 60 * 1000,

  init(viewer, options = {}) {
    _viewer = viewer;
    if (options?.dataManager && !_dataManager) _dataManager = options.dataManager;
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('Ham beacons');
      viewer.dataSources.add(_dataSource);
    }
    buildIbpEntities();
    _slot = ibpSlot(Date.now());
    applySlotStyles();
    _dataSource.show = false;
  },

  enable() {
    _enabled = true;
    startTicker();
    syncPresentation();
    emitState();
  },

  setLifecyclePresentation({ lifecycleState = null, enabled = false, uncertain = false } = {}) {
    const settled = enabled ? 'enabled' : 'disabled';
    _managerPresentation = {
      lifecycleState: ['enabling', 'enabled', 'disabling', 'disabled'].includes(lifecycleState) ? lifecycleState : settled,
      enabled: Boolean(enabled),
      uncertain: Boolean(uncertain),
    };
    syncPresentation();
    emitState();
  },

  disable() {
    _enabled = false;
    stopTicker();
    _requestGeneration += 1;
    _abort?.abort();
    _abort = null;
    _loading = false;
    _loadPromise = null;
    removeInteraction();
    if (_dataSource) _dataSource.show = false;
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    if (_hoverEntity && _viewer) _viewer.entities.remove(_hoverEntity);
    _hoverEntity = null;
    _hoverId = null;
    emitState();
  },

  async update(viewer, { signal = null } = {}) {
    if (!_enabled) return;
    try {
      await loadVhf({ signal });
    } catch (error) {
      _error = error?.message || 'VHF beacon feed unavailable';
      emitState();
    }
  },

  destroy() {
    this.disable();
    if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
    _dataSource = null;
    _ibpRender.clear();
    _vhfRender.clear();
    _vhf = Object.freeze([]);
    _vhfById = new Map();
    _vhfForbidden = false;
    _vhfLoaded = false;
    _selectedId = null;
    _filter = normalizeBeaconFilter();
    _slot = null;
    _lastTune = null;
    _error = null;
    _stale = false;
    _updatedAt = null;
    _managerPresentation = null;
    _viewer = null;
    emitState();
    _listeners.clear();
  },

  getStats() {
    return {
      count: IBP_BEACONS.length + _vhf.length,
      ibp: IBP_BEACONS.length,
      vhf: _vhf.length,
      vhfForbidden: _vhfForbidden,
      slot: _slot ? _slot.slot : null,
      selected: _selectedId,
      stale: _stale,
      loading: _loading,
      error: _error,
      lastUpdate: _updatedAt ? Date.parse(_updatedAt) : null,
    };
  },

  subscribe,
  getUIState: getHamBeaconsUIState,
  getIbp: () => ibpItems(Date.now(), { selectedId: _selectedId }),
  getVhf: () => _vhf,
  currentSlot: () => slotSummary(Date.now()),
  ensureLoaded,
  setFilter: setHamBeaconsFilter,
  select: selectHamBeacon,
  resolve: resolveHamBeacon,
  frame: frameHamBeacons,
  flyTo: flyToHamBeacon,
  tuneBeacon,
  setDataManager,
};

export default hamBeaconsLayer;
