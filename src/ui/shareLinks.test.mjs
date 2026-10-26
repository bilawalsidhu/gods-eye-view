// Short share links: `/share/<code>` opens through the start-up restore
// pipeline, the address then follows the live view, and the share button
// makes `/share/<code>` links (following an entity when the camera does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { ShareLinkManager } from '../sharelink.js';
import { ShareRestoration, sharedFixNotice } from './shareRestoration.js';
import {
  applyShareFollowOffset,
  readShareFollowSubject,
} from './shareFollow.js';
import { createDefaultLayerState } from '../data/layerState.js';
import { parseSharePath, shareLinkUrl } from '../share/shareLinkPath.js';
import {
  decodeShareView,
  encodeShareView,
  followCameraFor,
  followOffsetToEnu,
} from '../share/viewCodec.js';

const NOW_MS = Date.now();
const FIX = { lat: 37.6213, lon: -122.379, alt: 3200 };
const OFFSET = { range: 5800, heading: 0, pitch: -35 };

const PLACE_CODE = encodeShareView({
  lat: 48.8584,
  lon: 2.2945,
  alt: 1200,
  heading: 120,
  pitch: -25,
  style: 'noir',
  panelState: { specs: [{ id: 'data-panel', collapsed: false }] },
  sharedAtMs: NOW_MS - 60_000,
});

function aircraftCode() {
  const layerState = createDefaultLayerState();
  layerState.enabledLayerIds = ['flights'];
  return encodeShareView({
    view: {
      kind: 'thing',
      entity: { kind: 'aircraft', id: 'a1b2c3' },
      offset: OFFSET,
      lastKnown: { ...FIX, observedAtMs: NOW_MS - 120_000 },
    },
    layerState,
    sharedAtMs: NOW_MS - 120_000,
  });
}

/**
 * A page at `href`. `history.replaceState` rewrites the address in place and
 * is counted; `pushState` (a new history entry) is counted too.
 */
function installPage(t, href) {
  const prior = { window: globalThis.window, history: globalThis.history };
  const target = new EventTarget();
  const location = new URL(href);
  target.location = location;
  globalThis.window = target;
  const writes = { replaced: 0, pushed: 0 };
  globalThis.history = {
    replaceState(_state, _title, next) {
      writes.replaced += 1;
      location.href = new URL(next, location.href).href;
    },
    pushState() {
      writes.pushed += 1;
    },
  };
  t.after(() => Object.assign(globalThis, prior));
  return { location, writes, target };
}

function installManualTimers(t) {
  const prior = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const timers = new Map();
  let timerId = 0;
  globalThis.setTimeout = (fn) => {
    timers.set(++timerId, fn);
    return timerId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => Object.assign(globalThis, prior));
  return {
    timers,
    runAll() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}

/** A viewer whose camera flights land at once. */
function fakeViewer() {
  const flights = [];
  return {
    flights,
    canvas: new EventTarget(),
    camera: {
      changed: { addEventListener: () => () => {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
      flyTo(options) {
        flights.push(options);
        options.complete?.();
      },
      setView() {},
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A ShareRestoration over a real ShareLinkManager, as the shell wires them. */
function openPage(t, href, { managerOptions = {}, tracking = null } = {}) {
  const page = installPage(t, href);
  const clock = installManualTimers(t);
  const viewer = fakeViewer();
  const restores = [];
  const manager = new ShareLinkManager(viewer, {
    onRestore: async (state) => restores.push(state),
    isNavigationCurrent: () => true,
    ...managerOptions,
  });
  const notices = [];
  let generation = 0;
  const owner = new ShareRestoration({
    viewer,
    navigation: {
      _beginDeferredNavigation: () => ++generation,
      _reassertNavigationHandoff: () => true,
      _stampNavigation() {},
    },
    syncShareState() {},
    syncModels3d() {},
    showStatus() {},
    feedback: {},
    updateFeedback() {},
    applyFollowOffset: (entity, offset) =>
      applyShareFollowOffset(viewer, entity, offset),
  });
  // Notices are checked by message; their start-up-cover timing is not.
  owner._presentAfterStartupCover = (message) => notices.push(message);
  owner.attachLinks(manager);
  owner._layerStateCoordinator = {
    applyShareLayerState: () => Promise.resolve([]),
    getDurableState: () => null,
    cancelPendingShareTracking: () => false,
    restoreShareTrackingSelection: async () => tracking?.(owner) ?? null,
    destroy() {},
  };
  owner.start();
  t.after(() => owner.destroy());
  return { ...page, ...clock, viewer, manager, owner, restores, notices };
}

/** Run the delayed start-up restore and let it settle. */
async function restore(page) {
  page.runAll();
  const result = await page.owner.initialRestorePromise;
  await flush();
  return result;
}

test('a /share/<code> address opens its place view through the start-up restore', async (t) => {
  const page = openPage(t, `http://localhost/share/${PLACE_CODE}`);
  assert.equal(page.timers.size, 1, 'the restore waits for its delayed flight');
  assert.equal(page.manager._initialRestorePending, true);
  const result = await restore(page);
  assert.equal(result.status, 'settled');
  assert.equal(result.share.camera, 'applied');
  assert.equal(page.restores[0].style, 'noir');
  assert.deepEqual(page.restores[0].panelState.specs, [
    { id: 'data-panel', collapsed: false, pinned: null },
  ]);
  const destination = Cesium.Cartographic.fromCartesian(
    page.viewer.flights[0].destination,
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(destination.latitude) - 48.8584) < 1e-6,
  );
  assert.equal(page.manager._initialRestorePending, false);
  assert.deepEqual(page.notices, []);
});

test('after a restore the address becomes the app root and the long hash, with no new history entry', async (t) => {
  for (const [href, root] of [
    [`http://localhost/share/${PLACE_CODE}`, 'http://localhost/'],
    [
      `http://localhost:4173/gev/share/${PLACE_CODE}`,
      'http://localhost:4173/gev/',
    ],
  ]) {
    const page = openPage(t, href);
    await restore(page);
    page.manager._updateHash();
    assert.equal(`${page.location.origin}${page.location.pathname}`, root);
    // The live view's long form, as written for any other page.
    const params = new URLSearchParams(page.location.hash.slice(1));
    assert.equal(params.get('v'), '2');
    assert.ok(params.has('lat') && params.has('style'));
    assert.equal(page.writes.pushed, 0);
    assert.equal(page.writes.replaced, 1);
    page.manager.destroy();
  }
});

test('a host can pass the share code instead of the address', async (t) => {
  const page = openPage(t, 'http://localhost/', {
    managerOptions: { initialShareCode: PLACE_CODE },
  });
  await restore(page);
  assert.equal(page.restores[0].style, 'noir');
});

test('a code that fails its check restores nothing and says so', async (t) => {
  // One character changed: the check byte no longer matches.
  const last = PLACE_CODE.at(-2) === 'A' ? 'B' : 'A';
  const typo = `${PLACE_CODE.slice(0, -2)}${last}${PLACE_CODE.at(-1)}`;
  const page = openPage(t, `http://localhost/share/${typo}`);
  assert.equal(page.manager.rejectedShareCode, 'checksum');
  assert.notEqual(page.owner._hasShareState, true);
  assert.equal(page.timers.size, 0, 'nothing to restore');
  assert.equal(
    (await page.owner.initialRestorePromise).status,
    'not-requested',
  );
  assert.deepEqual(page.notices, ["This share link can't be opened"]);
  // The default start's first address write leaves the bad link behind.
  page.manager._updateHash();
  assert.equal(page.location.pathname, '/');
});

test('a thing view turns its layer on, follows by id and frames the shared offset', async (t) => {
  let entity = null;
  const page = openPage(t, `http://localhost/share/${aircraftCode()}`, {
    tracking: (owner) => {
      // What the coordinator does when the aircraft is in the feed.
      owner.viewer.trackedEntity = entity;
      owner._handleShareTrackingRestoreStatus({
        layerId: 'flights',
        targetId: 'a1b2c3',
        classification: 'followed',
      });
      return { classification: 'followed' };
    },
  });
  const target = Cesium.Cartesian3.fromDegrees(FIX.lon, FIX.lat, FIX.alt);
  const listeners = [];
  const looks = [];
  Object.assign(page.viewer, {
    clock: { currentTime: Cesium.JulianDate.now() },
    scene: {
      preUpdate: {
        addEventListener(fn) {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
    },
    isDestroyed: () => false,
  });
  Object.assign(page.viewer.camera, {
    transform: Cesium.Transforms.eastNorthUpToFixedFrame(target),
    // The app's own follow framing: south of the aircraft and above it.
    position: new Cesium.Cartesian3(0, -4800, 3300),
    lookAtTransform(transform, offset) {
      looks.push(offset);
      this.position = Cesium.Cartesian3.clone(offset);
    },
  });
  entity = {
    gevTrackedId: 'flights:a1b2c3',
    gevDisplayPosition: () => target,
  };

  const parsed = page.manager._parseShareCode(aircraftCode());
  assert.deepEqual(parsed.layerState.enabledLayerIds, ['flights']);
  assert.equal(
    parsed.layerState.options.flights.selectedFlightsTrackingId,
    'a1b2c3',
  );
  await restore(page);
  // The opening flight goes where following the fix puts the camera.
  const camera = followCameraFor(FIX, OFFSET);
  const destination = Cesium.Cartographic.fromCartesian(
    page.viewer.flights[0].destination,
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(destination.latitude) - camera.lat) < 1e-3,
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(destination.longitude) - camera.lon) < 1e-3,
  );
  // Once followed, the camera takes the shared offset after the follow's
  // own first frame.
  assert.equal(listeners.length, 1);
  listeners[0]();
  assert.equal(looks.length, 0);
  listeners[0]?.();
  assert.equal(looks.length, 1);
  const expected = followOffsetToEnu(OFFSET);
  assert.ok(Math.abs(looks[0].x - expected.east) < 1);
  assert.ok(Math.abs(looks[0].y - expected.north) < 1);
  assert.ok(Math.abs(looks[0].z - expected.up) < 1);
  assert.equal(listeners.length, 0, 'the offset is applied once');
  assert.deepEqual(page.notices, []);
});

test('a thing that is not reporting leaves the view at its last-known fix, with a notice', async (t) => {
  const page = openPage(t, `http://localhost/share/${aircraftCode()}`, {
    tracking: (owner) => {
      // The coordinator's verdict once the follow window has passed.
      const result = {
        layerId: 'flights',
        targetId: 'a1b2c3',
        label: 'flight',
        classification: 'expired',
      };
      owner._handleShareTrackingRestoreStatus(result);
      return result;
    },
  });
  await restore(page);
  await flush();
  assert.equal(page.notices.length, 1);
  assert.match(
    page.notices[0],
    /^A1B2C3 isn't reporting now — showing where it was at .+/,
  );
  // A long link names no fix and keeps the existing notice.
  page.owner._initialShareState = { shareView: null };
  page.owner._handleShareTrackingRestoreStatus({
    layerId: 'flights',
    targetId: 'a1b2c3',
    label: 'flight',
    classification: 'expired',
  });
  assert.equal(page.notices[1], 'Shared flight follow expired');
});

test('the not-reporting notice names the id and the time of the fix', () => {
  const at = new Date(2026, 9, 26, 14, 5).getTime();
  assert.match(
    sharedFixNotice({ kind: 'aircraft', id: 'a1b2c3' }, at, at + 60_000),
    /^A1B2C3 isn't reporting now — showing where it was at .*05/,
  );
  assert.equal(
    sharedFixNotice({ kind: 'vessel', id: '366999712' }, null),
    "366999712 isn't reporting now — showing where it was last seen",
  );
});

test('a shared vessel is selected once the vessel feed has it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });
  const page = openPage(t, 'http://localhost/');
  const selected = [];
  let present = false;
  page.owner._dataManager = {
    layers: new Map([
      [
        'ais-live-vessels',
        {
          module: {
            hasContact: (id) => present && id === '366999712',
            selectById: (id) => selected.push(id) > 0,
          },
        },
      ],
    ]),
  };
  const view = {
    kind: 'thing',
    entity: { kind: 'vessel', id: '366999712' },
    lastKnown: { lat: 1, lon: 2, alt: 0, observedAtMs: NOW_MS - 30_000 },
  };
  const found = page.owner._restoreSharedVessel(view, () => true);
  await flush();
  present = true;
  page.runAll();
  assert.equal(await found, true);
  assert.deepEqual(selected, ['366999712']);

  present = false;
  const missing = page.owner._restoreSharedVessel(view, () => true);
  for (let i = 0; i < 61; i += 1) {
    await flush();
    t.mock.timers.tick(2_000);
    page.runAll();
  }
  assert.equal(await missing, false);
  assert.match(page.notices.at(-1), /^366999712 isn't reporting now/);
});

test('the share button links to /share/<code>, following the followed entity', (t) => {
  installPage(t, 'https://gev.example/?lang=ru#v=2&lat=1&lon=2');
  const manager = new ShareLinkManager(fakeViewer());
  // A fresh session's look, as the app reports it at start-up.
  manager.onToggleChange(false, true, {
    hudVisible: true,
    detectionMode: 'DENSE',
    detectionDensity: 75,
  });
  // No entity: a place view at the live camera.
  const place = manager.buildLink({ nowMs: NOW_MS });
  assert.match(place, /^https:\/\/gev\.example\/share\/[A-Za-z0-9_-]+$/);
  assert.equal(
    decodeShareView(parseSharePath(new URL(place).pathname).code).state.view
      .kind,
    'place',
  );

  manager.setFollowSubjectProvider(() => ({
    kind: 'aircraft',
    id: 'a1b2c3',
    offset: OFFSET,
    lastKnown: { ...FIX, observedAtMs: NOW_MS },
  }));
  const href = manager.buildLink({ nowMs: NOW_MS });
  const code = parseSharePath(new URL(href).pathname).code;
  const { state } = decodeShareView(code, { nowMs: NOW_MS });
  assert.deepEqual(state.view, {
    kind: 'thing',
    entity: { kind: 'aircraft', id: 'a1b2c3' },
    offset: OFFSET,
    lastKnown: { ...FIX, observedAtMs: Math.floor(NOW_MS / 1000) * 1000 },
  });
  // The followed aircraft's layer is implied; the camera is derived.
  assert.ok(code.length <= 45, `${code.length} characters`);
  assert.equal(href, shareLinkUrl(code, 'https://gev.example/'));
  manager.destroy();
});

test('the followed entity is read in the share format, and its offset round-trips', () => {
  const target = Cesium.Cartesian3.fromDegrees(FIX.lon, FIX.lat, FIX.alt);
  const offset = { range: 2400, heading: 30, pitch: -20 };
  const local = followOffsetToEnu(offset);
  const cameraPosition = Cesium.Matrix4.multiplyByPoint(
    Cesium.Transforms.eastNorthUpToFixedFrame(target),
    new Cesium.Cartesian3(local.east, local.north, local.up),
    new Cesium.Cartesian3(),
  );
  const viewer = {
    camera: { positionWC: cameraPosition },
    clock: { currentTime: Cesium.JulianDate.now() },
    trackedEntity: {
      gevTrackedId: 'military:ae1234',
      gevDisplayPosition: () => target,
    },
  };
  const subject = readShareFollowSubject({ viewer, nowMs: NOW_MS });
  assert.equal(subject.kind, 'military_aircraft');
  assert.equal(subject.id, 'ae1234');
  assert.deepEqual(subject.offset, offset);
  assert.ok(Math.abs(subject.lastKnown.lat - FIX.lat) < 1e-9);
  assert.ok(Math.abs(subject.lastKnown.alt - FIX.alt) < 1e-3);
  // A followed entity the share format has no kind for is not a thing view.
  viewer.trackedEntity.gevTrackedId = 'local-adsb:abc';
  assert.equal(readShareFollowSubject({ viewer }), null);
  // Nor is a camera that follows nothing (a selected vessel is not followed).
  viewer.trackedEntity = undefined;
  assert.equal(readShareFollowSubject({ viewer }), null);
});

test('a shared offset on the far side swings round, never jumping through the entity', () => {
  const target = Cesium.Cartesian3.fromDegrees(FIX.lon, FIX.lat, FIX.alt);
  const listeners = [];
  const looks = [];
  const entity = { gevDisplayPosition: () => target };
  const viewer = {
    clock: { currentTime: Cesium.JulianDate.now() },
    scene: {
      preUpdate: {
        addEventListener(fn) {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
    },
    trackedEntity: entity,
    camera: {
      transform: Cesium.Transforms.eastNorthUpToFixedFrame(target),
      position: new Cesium.Cartesian3(0, -4800, 3300),
      lookAtTransform(transform, offset) {
        looks.push(Cesium.Cartesian3.clone(offset));
        this.position = Cesium.Cartesian3.clone(offset);
      },
    },
  };
  // Looking south at the nose: the opposite side of the app's framing.
  const offset = { range: 5800, heading: 180, pitch: -35 };
  applyShareFollowOffset(viewer, entity, offset);
  let previous = viewer.camera.position;
  for (let frame = 0; frame < 10 && listeners.length; frame += 1) {
    listeners[0]();
    const now = viewer.camera.position;
    // The follow's guard treats a turn of 90° or more as a crossing.
    assert.ok(Cesium.Cartesian3.angleBetween(previous, now) < Math.PI / 2);
    previous = now;
  }
  assert.equal(listeners.length, 0, 'it arrives');
  assert.ok(looks.length >= 2, `${looks.length} steps`);
  const expected = followOffsetToEnu(offset);
  const last = looks.at(-1);
  assert.ok(Math.abs(last.x - expected.east) < 1);
  assert.ok(Math.abs(last.y - expected.north) < 1);
  assert.ok(Math.abs(last.z - expected.up) < 1);
});

test('applying a follow offset gives up when the follow ends', () => {
  const listeners = [];
  const viewer = {
    scene: {
      preUpdate: {
        addEventListener(fn) {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
    },
    trackedEntity: null,
  };
  applyShareFollowOffset(viewer, {}, OFFSET);
  listeners[0]();
  assert.equal(listeners.length, 0);
});

test('long links and hash navigation are unaffected by a share code start', async (t) => {
  // A long link still opens from the hash.
  const long = openPage(t, 'http://localhost/#v=2&lat=10&lon=20&style=nvg');
  await restore(long);
  assert.equal(long.restores[0].style, 'surveillance');
  assert.equal(long.restores[0].shareView, undefined);
  long.manager._updateHash();
  assert.equal(long.location.pathname, '/');

  // After a /share start, navigating to a long link restores it (#1416).
  const page = openPage(t, `http://localhost/share/${PLACE_CODE}`);
  await restore(page);
  page.location.hash = 'v=2&lat=1.0000&lon=2.0000&style=normal';
  page.target.dispatchEvent(new Event('hashchange'));
  await flush();
  assert.equal(page.restores.length, 2);
  assert.equal(page.restores[1].style, 'normal');
});
