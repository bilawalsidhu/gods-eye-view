#!/usr/bin/env node
/** Focused rendered proof for adaptive Cockpit Display/Radio layout. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { webglLaunchArgs } from './lib/webglLaunchArgs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(repoRoot, 'qa-shots', 'cockpit-utility');
const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const headful = process.argv.includes('--headful');
fs.mkdirSync(shotsDir, { recursive: true });

const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  ...(executablePath ? { executablePath } : {}),
  args: [...webglLaunchArgs(), '--no-sandbox'],
});
const page = await browser.newPage();
const failures = [];
const consoleErrors = [];
const localHttpErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource.*404/i.test(message.text())) {
    const source = message.location()?.url;
    consoleErrors.push(source ? `${message.text()} [${source}]` : message.text());
  }
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('response', (response) => {
  const url = new URL(response.url());
  const expectedOptionalTrackMiss = response.status() === 404
    && url.pathname === '/api/opensky-track';
  if (
    url.origin === new URL(appUrl).origin
    && response.status() >= 400
    && !expectedOptionalTrackMiss
  ) {
    localHttpErrors.push(`${response.status()} ${url.pathname}${url.search}`);
  }
});

const check = (name, passed, detail) => {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(name);
};

try {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin && url.pathname === '/api/ais-live') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rows: [],
          source: 'AISStream QA',
          status: 'open',
          error: null,
          refreshing: false,
          newestPositionAt: null,
          lastMessageAt: null,
        }),
      });
      return;
    }
    if (url.origin === new URL(appUrl).origin && url.pathname === '/api/adsblol/mil') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ msg: 'No error', now: Date.now(), ac: [] }),
      });
      return;
    }
    if (url.origin === new URL(appUrl).origin && url.pathname === '/api/opensky-track') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: [] }),
      });
      return;
    }
    if (url.origin === new URL(appUrl).origin && url.pathname === '/api/military-installations') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          elements: [],
          saturated: false,
          elementCap: 1_500,
          retrievedAt: new Date().toISOString(),
          status: 'ready',
        }),
      });
      return;
    }
    if (url.origin === new URL(appUrl).origin && url.pathname === '/api/openai/hud-summary') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: 'Cockpit utility QA' }),
      });
      return;
    }
    request.continue();
  });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__godsEyeView?.styleManager, { timeout: 60_000 });
  await page.waitForFunction(
    () => document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60_000 },
  );
  await page.waitForFunction(() => (
    typeof window.__gevQaRegisterLayer === 'function'
    && typeof window.__gevQaUnregisterLayer === 'function'
  ));
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    const hud = document.getElementById('cockpit-hud');
    const signal = document.getElementById('cockpit-signal-stream');
    window.__qaCockpitUtilityPrior = {
      cockpit: document.body.classList.contains('cockpit-mode'),
      active: manager.cockpitView.active,
      hudHidden: hud.hidden,
      signalHidden: signal.hidden,
      hudVisible: manager.hud.visible,
      hudVariant: manager.hud.getVariant(),
      utilityTop: hud.style.getPropertyValue('--cockpit-utility-top'),
    };
  });
  const contactMissionHandoff = await page.evaluate(async () => {
    const { styleManager, dataManager } = window.__godsEyeView;
    const originalShowToast = styleManager._showToast;
    const toasts = [];
    styleManager._showToast = (message) => { toasts.push(String(message)); };
    try {
      if (styleManager._contextMode) await styleManager._selectContextMode(null);
      const contactsResult = await styleManager._selectContextMode('flights');
      const missionResult = await styleManager._selectContextMode('space-missions');
      const switched = {
        contactsResult,
        missionResult,
        mode: styleManager._contextMode,
        missionsEnabled: dataManager.isEnabled('rocket-launches'),
        toasts: [...toasts],
      };
      const exitResult = await styleManager._selectContextMode(null);
      return {
        ...switched,
        exitResult,
        modeAfterExit: styleManager._contextMode,
        missionsOffAfterExit: !dataManager.isEffectivelyEnabled('rocket-launches'),
      };
    } finally {
      styleManager._showToast = originalShowToast;
    }
  });
  check(
    'Contacts hands off to Space Missions on the first request without a failure toast',
    contactMissionHandoff.contactsResult === true
      && contactMissionHandoff.missionResult === true
      && contactMissionHandoff.mode === 'space-missions'
      && contactMissionHandoff.missionsEnabled
      && contactMissionHandoff.toasts?.length === 0
      && contactMissionHandoff.exitResult === true
      && contactMissionHandoff.modeAfterExit === null
      && contactMissionHandoff.missionsOffAfterExit,
    JSON.stringify(contactMissionHandoff),
  );
  const cancelledMissionEntry = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const dataManager = window.__godsEyeView.dataManager;
    const rocketEntry = dataManager.layers.get('rocket-launches');
    if (!rocketEntry || dataManager.isEffectivelyEnabled('rocket-launches')) {
      return { exercised: false, reason: 'Space Missions was not in a clean OFF state' };
    }

    const siblingId = 'qa-cockpit-cancel-sibling';
    const siblingModule = {
      id: siblingId,
      name: 'QA cancellation sibling',
      icon: 'science',
      source: 'QA',
      updateInterval: -1,
      async init() { return true; },
      async enable() { return true; },
      async update() { return true; },
      async disable() { return true; },
      async destroy() {},
      getStats() { return { count: 1, status: 'live' }; },
    };
    window.__gevQaRegisterLayer(dataManager, siblingModule);
    await dataManager.setEnabled(siblingId, true, { origin: 'programmatic' });

    const originalInitialized = rocketEntry.initialized;
    const originalLifecycle = rocketEntry.lifecycleState;
    const originalMethods = {
      init: rocketEntry.module.init,
      enable: rocketEntry.module.enable,
      update: rocketEntry.module.update,
      disable: rocketEntry.module.disable,
    };
    const originalShowToast = styleManager._showToast;
    const toasts = [];
    let releaseEnable;
    let markEnableStarted;
    const enableStarted = new Promise((resolve) => { markEnableStarted = resolve; });
    const enableGate = new Promise((resolve) => { releaseEnable = resolve; });
    rocketEntry.initialized = true;
    rocketEntry.module.enable = async () => {
      markEnableStarted();
      await enableGate;
      return true;
    };
    rocketEntry.module.update = async () => true;
    rocketEntry.module.disable = async () => true;
    styleManager._showToast = (message) => { toasts.push(String(message)); };

    let transitionResult = null;
    let timedOut = false;
    try {
      const controller = new AbortController();
      const transition = dataManager.setEnabled('rocket-launches', true, {
        origin: 'user',
        signal: controller.signal,
      });
      await enableStarted;
      controller.abort(new DOMException('QA caller cancellation', 'AbortError'));
      releaseEnable();
      transitionResult = await transition;
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        if (
          styleManager._contextModeEntering === null
          && styleManager._contextSessionSnapshot === null
          && dataManager.isEnabled(siblingId)
          && !dataManager.isEffectivelyEnabled('rocket-launches')
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      timedOut = !(
        styleManager._contextModeEntering === null
        && styleManager._contextSessionSnapshot === null
        && dataManager.isEnabled(siblingId)
        && !dataManager.isEffectivelyEnabled('rocket-launches')
      );
      return {
        exercised: true,
        transitionResult,
        timedOut,
        entering: styleManager._contextModeEntering,
        snapshotRetained: Boolean(styleManager._contextSessionSnapshot),
        siblingRestored: dataManager.isEnabled(siblingId),
        missionEffective: dataManager.isEffectivelyEnabled('rocket-launches'),
        toasts,
      };
    } finally {
      styleManager._showToast = originalShowToast;
      rocketEntry.module.init = originalMethods.init;
      rocketEntry.module.enable = originalMethods.enable;
      rocketEntry.module.update = originalMethods.update;
      rocketEntry.module.disable = originalMethods.disable;
      rocketEntry.initialized = originalInitialized;
      rocketEntry.lifecycleState = originalLifecycle;
      await dataManager.setEnabled(siblingId, false, { origin: 'programmatic' });
      await window.__gevQaUnregisterLayer(dataManager, siblingId);
    }
  });
  check(
    'cancelled direct Space Missions entry restores its exact isolated sibling state',
    cancelledMissionEntry.exercised
      && cancelledMissionEntry.transitionResult === false
      && !cancelledMissionEntry.timedOut
      && cancelledMissionEntry.entering === null
      && !cancelledMissionEntry.snapshotRetained
      && cancelledMissionEntry.siblingRestored
      && !cancelledMissionEntry.missionEffective,
    JSON.stringify(cancelledMissionEntry),
  );
  check(
    'successful Space Missions cancellation rollback stays silent',
    cancelledMissionEntry.exercised && cancelledMissionEntry.toasts?.length === 0,
    JSON.stringify(cancelledMissionEntry.toasts || []),
  );
  const replacementMissionEntry = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const dataManager = window.__godsEyeView.dataManager;
    const rocketEntry = dataManager.layers.get('rocket-launches');
    if (!rocketEntry || dataManager.isEffectivelyEnabled('rocket-launches')) {
      return { exercised: false, reason: 'Space Missions was not in a clean OFF state' };
    }
    const siblingId = 'qa-cockpit-replacement-sibling';
    window.__gevQaRegisterLayer(dataManager, {
      id: siblingId,
      name: 'QA replacement sibling',
      icon: 'science',
      source: 'QA',
      updateInterval: -1,
      async init() { return true; },
      async enable() { return true; },
      async update() { return true; },
      async disable() { return true; },
      async destroy() {},
      getStats() { return { count: 1, status: 'live' }; },
    });
    await dataManager.setEnabled(siblingId, true, { origin: 'programmatic' });
    const original = {
      siblingInitialized: dataManager.layers.get(siblingId)?.initialized,
      initialized: rocketEntry.initialized,
      lifecycleState: rocketEntry.lifecycleState,
      init: rocketEntry.module.init,
      enable: rocketEntry.module.enable,
      update: rocketEntry.module.update,
      disable: rocketEntry.module.disable,
      showToast: styleManager._showToast,
    };
    let firstUpdate = true;
    let releaseUpdate;
    let markUpdateStarted;
    const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
    const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
    const toasts = [];
    rocketEntry.initialized = true;
    rocketEntry.module.enable = async () => true;
    rocketEntry.module.update = async () => {
      if (!firstUpdate) return true;
      firstUpdate = false;
      markUpdateStarted();
      await updateGate;
      return true;
    };
    rocketEntry.module.disable = async () => true;
    styleManager._showToast = (message) => { toasts.push(String(message)); };
    try {
      const entry = styleManager._selectContextMode('space-missions');
      await updateStarted;
      const replacement = dataManager.setEnabled('rocket-launches', true, { origin: 'programmatic' });
      releaseUpdate();
      const [entryResult, replacementResult] = await Promise.all([entry, replacement]);
      const committed = {
        entryResult,
        replacementResult,
        mode: styleManager._contextMode,
        entering: styleManager._contextModeEntering,
        snapshotRetained: Boolean(styleManager._contextSessionSnapshot),
        siblingIsolated: !dataManager.isEffectivelyEnabled(siblingId),
        missionEnabled: dataManager.isEnabled('rocket-launches'),
        missionEffective: dataManager.isEffectivelyEnabled('rocket-launches'),
        toasts: [...toasts],
      };
      const exitResult = await styleManager._selectContextMode(null);
      return {
        exercised: true,
        ...committed,
        exitResult,
        siblingRestored: dataManager.isEnabled(siblingId),
        missionRestoredOff: !dataManager.isEffectivelyEnabled('rocket-launches'),
      };
    } finally {
      styleManager._showToast = original.showToast;
      rocketEntry.module.init = original.init;
      rocketEntry.module.enable = original.enable;
      rocketEntry.module.update = original.update;
      rocketEntry.module.disable = original.disable;
      rocketEntry.initialized = original.initialized;
      rocketEntry.lifecycleState = original.lifecycleState;
      await dataManager.setEnabled(siblingId, false, { origin: 'programmatic' });
      await window.__gevQaUnregisterLayer(dataManager, siblingId);
    }
  });
  check(
    'right-rail Space Missions adopts a newer authoritative ON without stale restoration',
    replacementMissionEntry.exercised
      && replacementMissionEntry.entryResult === true
      && replacementMissionEntry.replacementResult === true
      && replacementMissionEntry.mode === 'space-missions'
      && replacementMissionEntry.entering === null
      && replacementMissionEntry.snapshotRetained
      && replacementMissionEntry.siblingIsolated
      && replacementMissionEntry.missionEnabled
      && replacementMissionEntry.missionEffective
      && replacementMissionEntry.toasts?.length === 0
      && replacementMissionEntry.exitResult === true
      && replacementMissionEntry.siblingRestored
      && replacementMissionEntry.missionRestoredOff,
    JSON.stringify(replacementMissionEntry),
  );
  const supersededMissionEntry = await page.evaluate(async () => {
    const styleManager = window.__godsEyeView.styleManager;
    const dataManager = window.__godsEyeView.dataManager;
    const rocketEntry = dataManager.layers.get('rocket-launches');
    if (!rocketEntry || dataManager.isEffectivelyEnabled('rocket-launches')) {
      return { exercised: false, reason: 'Space Missions was not in a clean OFF state' };
    }
    const siblingId = 'qa-cockpit-superseded-sibling';
    window.__gevQaRegisterLayer(dataManager, {
      id: siblingId,
      name: 'QA superseded sibling',
      icon: 'science',
      source: 'QA',
      updateInterval: -1,
      async init() { return true; },
      async enable() { return true; },
      async update() { return true; },
      async disable() { return true; },
      async destroy() {},
      getStats() { return { count: 1, status: 'live' }; },
    });
    await dataManager.setEnabled(siblingId, true, { origin: 'programmatic' });
    const original = {
      initialized: rocketEntry.initialized,
      lifecycleState: rocketEntry.lifecycleState,
      init: rocketEntry.module.init,
      enable: rocketEntry.module.enable,
      update: rocketEntry.module.update,
      disable: rocketEntry.module.disable,
      showToast: styleManager._showToast,
    };
    let releaseUpdate;
    let markUpdateStarted;
    const updateStarted = new Promise((resolve) => { markUpdateStarted = resolve; });
    const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
    const toasts = [];
    rocketEntry.initialized = true;
    rocketEntry.module.enable = async () => true;
    rocketEntry.module.update = async () => {
      markUpdateStarted();
      await updateGate;
      return true;
    };
    rocketEntry.module.disable = async () => true;
    styleManager._showToast = (message) => { toasts.push(String(message)); };
    try {
      const entry = styleManager._runUserFacingContextAction(
        (notificationToken) => styleManager._selectContextMode(
          'space-missions',
          { notificationToken },
        ),
        'Space Missions could not complete the requested transition; try again',
      );
      await updateStarted;
      const supersedingOff = dataManager.setEnabled('rocket-launches', false, {
        origin: 'programmatic',
      });
      releaseUpdate();
      const [entryResult, offResult] = await Promise.all([entry, supersedingOff]);
      return {
        exercised: true,
        entryResult,
        offResult,
        mode: styleManager._contextMode,
        entering: styleManager._contextModeEntering,
        snapshotRetained: Boolean(styleManager._contextSessionSnapshot),
        siblingRestored: dataManager.isEnabled(siblingId),
        missionEffective: dataManager.isEffectivelyEnabled('rocket-launches'),
        toasts,
      };
    } finally {
      styleManager._showToast = original.showToast;
      rocketEntry.module.init = original.init;
      rocketEntry.module.enable = original.enable;
      rocketEntry.module.update = original.update;
      rocketEntry.module.disable = original.disable;
      rocketEntry.initialized = original.initialized;
      rocketEntry.lifecycleState = original.lifecycleState;
      await dataManager.setEnabled(siblingId, false, { origin: 'programmatic' });
      await window.__gevQaUnregisterLayer(dataManager, siblingId);
    }
  });
  check(
    'right-rail Space Missions superseded by OFF restores exactly without a failure toast',
    supersededMissionEntry.exercised
      && supersededMissionEntry.entryResult === null
      && supersededMissionEntry.mode === null
      && supersededMissionEntry.entering === null
      && !supersededMissionEntry.snapshotRetained
      && supersededMissionEntry.siblingRestored
      && !supersededMissionEntry.missionEffective
      && supersededMissionEntry.toasts?.length === 0,
    JSON.stringify(supersededMissionEntry),
  );
  const voiceMissionEntry = await page.evaluate(async () => {
    const { dataManager, styleManager } = window.__godsEyeView;
    const siblingId = '__qa_voice_context_sibling__';
    const rocketEntry = dataManager.layers.get('rocket-launches');
    window.__gevQaRegisterLayer(dataManager, {
      id: siblingId,
      name: 'QA voice Context sibling',
      icon: 'science',
      source: 'QA',
      updateInterval: -1,
      async init() { return true; },
      async enable() { return true; },
      async update() { return true; },
      async disable() { return true; },
      async destroy() {},
      getStats() { return { count: 1, status: 'live' }; },
    });
    const original = {
      initialized: rocketEntry.initialized,
      lifecycleState: rocketEntry.lifecycleState,
      init: rocketEntry.module.init,
      enable: rocketEntry.module.enable,
      update: rocketEntry.module.update,
      disable: rocketEntry.module.disable,
    };
    const siblingLayerEntry = dataManager.layers.get(siblingId);
    siblingLayerEntry.initialized = true;
    await dataManager.setEnabled(siblingId, true, { origin: 'programmatic' });
    rocketEntry.initialized = true;
    rocketEntry.module.init = async () => true;
    rocketEntry.module.enable = async () => true;
    rocketEntry.module.update = async () => true;
    rocketEntry.module.disable = async () => true;
    try {
      const voiceOn = await dataManager.setEnabled('rocket-launches', true, { origin: 'voice' });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const voiceState = {
        voiceOn,
        mode: styleManager._contextMode,
        entering: styleManager._contextModeEntering,
        snapshotRetained: Boolean(styleManager._contextSessionSnapshot),
        siblingIsolated: !dataManager.isEffectivelyEnabled(siblingId),
      };
      const snapshotBeforeOff = [...(styleManager._contextSessionSnapshot?.enabledLayerIds || [])];
      const voiceOff = await dataManager.setEnabled('rocket-launches', false, { origin: 'voice' });
      const reactionCountAfterOff = styleManager._contextLayerReactionPromises.size;
      await styleManager._waitForContextLayerSettlement();
      const restoredSiblingEntry = dataManager.layers.get(siblingId);
      const voiceExit = {
        voiceOff,
        snapshotBeforeOff,
        reactionCountAfterOff,
        mode: styleManager._contextMode,
        entering: styleManager._contextModeEntering,
        snapshotRetained: Boolean(styleManager._contextSessionSnapshot),
        siblingRestored: dataManager.isEffectivelyEnabled(siblingId),
        siblingEnabled: restoredSiblingEntry?.enabled,
        siblingLifecycle: restoredSiblingEntry?.lifecycleState,
        restoreActive: Boolean(styleManager._contextRestoreState),
      };

      await dataManager.setEnabled('rocket-launches', true, { origin: 'programmatic' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const internalState = {
        mode: styleManager._contextMode,
        entering: styleManager._contextModeEntering,
        snapshotRetained: Boolean(styleManager._contextSessionSnapshot),
        missionEnabled: dataManager.isEffectivelyEnabled('rocket-launches'),
      };
      await dataManager.setEnabled('rocket-launches', false, { origin: 'programmatic' });
      return { exercised: true, voiceState, voiceExit, internalState };
    } finally {
      rocketEntry.module.init = original.init;
      rocketEntry.module.enable = original.enable;
      rocketEntry.module.update = original.update;
      rocketEntry.module.disable = original.disable;
      rocketEntry.initialized = original.initialized;
      rocketEntry.lifecycleState = original.lifecycleState;
      await dataManager.setEnabled(siblingId, false, { origin: 'programmatic' });
      siblingLayerEntry.initialized = original.siblingInitialized;
      await window.__gevQaUnregisterLayer(dataManager, siblingId);
    }
  });
  check(
    'voice Space Missions uses the same Context snapshot and exact-restore transaction as UI entry',
    voiceMissionEntry.exercised
      && voiceMissionEntry.voiceState?.voiceOn
      && voiceMissionEntry.voiceState.mode === 'space-missions'
      && voiceMissionEntry.voiceState.entering === null
      && voiceMissionEntry.voiceState.snapshotRetained
      && voiceMissionEntry.voiceState.siblingIsolated
      && voiceMissionEntry.voiceExit?.voiceOff
      && voiceMissionEntry.voiceExit.mode === null
      && voiceMissionEntry.voiceExit.entering === null
      && !voiceMissionEntry.voiceExit.snapshotRetained
      && voiceMissionEntry.voiceExit.siblingRestored,
    JSON.stringify(voiceMissionEntry),
  );
  check(
    'internal programmatic Space Missions activation does not create a user Context session',
    voiceMissionEntry.internalState?.missionEnabled
      && voiceMissionEntry.internalState.mode === null
      && voiceMissionEntry.internalState.entering === null
      && !voiceMissionEntry.internalState.snapshotRetained,
    JSON.stringify(voiceMissionEntry),
  );
  await page.evaluate(() => window.__godsEyeView.dataManager.setEnabled(
    'flights',
    true,
    { origin: 'user' },
  ));
  await page.waitForFunction(() => {
    const layer = window.__godsEyeView?.dataManager?.layers?.get('flights')?.module;
    return (layer?.getAllPositions?.(500) || []).some(
      (candidate) => Number(candidate.altitudeM) > 1_000,
    );
  }, { timeout: 60_000 });
  const tracked = await page.evaluate(() => {
    const layer = window.__godsEyeView.dataManager.layers.get('flights')?.module;
    const candidates = layer?.getAllPositions?.(500) || [];
    const airborne = candidates.find((candidate) => Number(candidate.altitudeM) > 1_000);
    return {
      id: airborne?.id || null,
      tracked: Boolean(airborne && layer.trackById?.(airborne.id)),
    };
  });
  check('real airborne flight is tracked before Contacts activation', tracked.tracked, JSON.stringify(tracked));
  await page.waitForFunction(
    () => Boolean(window.__godsEyeView.viewer.trackedEntity?.position),
    { timeout: 10_000 },
  );
  // Live-data attrition: a real ADS-B subject can leave the feed at any
  // moment (landing, coverage gap, feed prune). When its entity is pruned
  // the cockpit auto-exits (CockpitViewController.update treats a vanished
  // entity as end-of-track) and #cockpit-entry disappears with it — every
  // later check re-enters through that button, so the run would die in a
  // wait timeout. Recovery goes through the app's own sanctioned paths:
  // the Contacts navigator (which re-wires a contact-owned subject through
  // the real adoption flow — raw trackById does not re-engage one) and, as
  // a fallback, trackById onto verified candidates. Every pick is verified:
  // stale billboards list hex ids with old altitudes whose tracking never
  // lands.
  const ensureTrackedFlight = async () => {
    const state = await page.evaluate(async () => {
      const { viewer, dataManager } = window.__godsEyeView;
      const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const alive = () => {
        const entity = viewer.trackedEntity;
        return Boolean(entity && viewer.entities.contains(entity) && entity.position);
      };
      if (alive()) return { reacquired: false };
      const awareness = dataManager.layers.get('military-awareness')?.module;
      if (awareness?.navigateNext) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const moved = awareness.navigateNext({ origin: 'user' });
          await settle(600);
          if (moved && alive()) return { reacquired: true, via: 'context-next' };
        }
      }
      const layer = dataManager.layers.get('flights')?.module;
      const airborne = (layer?.getAllPositions?.(500) || [])
        .filter((candidate) => Number(candidate.altitudeM) > 1_000);
      // Prefer hex ICAO24 identities: the cockpit entry gate needs ICAO24
      // contact info, which fallback sources' UUID row ids never carry.
      const ranked = [
        ...airborne.filter((candidate) => /^[0-9a-f]{6}$/i.test(candidate.id)),
        ...airborne.filter((candidate) => !/^[0-9a-f]{6}$/i.test(candidate.id)),
      ].slice(0, 4);
      const attempted = [];
      for (const candidate of ranked) {
        attempted.push(candidate.id);
        if (layer?.trackById?.(candidate.id)) {
          await settle(1_200);
          if (alive()) return { reacquired: true, via: 'trackById', id: candidate.id };
        }
      }
      return { reacquired: false, feedEmpty: !ranked.length, attempted };
    });
    if (state.reacquired) {
      console.log(`INFO live subject attrition: re-tracked via ${state.via}${state.id ? ` (${state.id})` : ''}`);
    } else if (state.feedEmpty) {
      console.log('WARN no airborne flights in the live feed right now');
    } else if (state.attempted) {
      console.log(`WARN re-track candidates never produced a position: ${state.attempted.join(',')}`);
    }
    return state;
  };
  // Most checks continue a Cockpit session a previous check left active.
  // Attrition between checks closes that session; restore subject + session
  // through the programmatic entry (the button may not exist while entry is
  // gated). Cheap no-op while healthy.
  const ensureCockpitSession = async () => {
    await ensureTrackedFlight();
    const entered = await page.evaluate(() => {
      const cockpit = window.__godsEyeView.styleManager.cockpitView;
      return cockpit.active ? 'already-active' : (cockpit.enter() === true ? 'entered' : 'refused');
    });
    if (entered === 'refused') {
      console.log('WARN cockpit session could not be restored after attrition');
      return;
    }
    try {
      await page.waitForFunction(
        () => window.__godsEyeView.styleManager.cockpitView.active,
        { timeout: 10_000 },
      );
    } catch {
      console.log('WARN cockpit session did not re-engage after entry');
    }
  };
  // The entry button exists only for a healthy ICAO24-tracked subject, so a
  // subject dying at exactly the wrong moment (live-feed attrition) kills
  // the whole run in a wait timeout — every later check re-enters through
  // this button. Recover through the app's own paths and re-wait instead of
  // letting one window of feed churn end the suite.
  const enterThroughCockpitEntryButton = async () => {
    let ready = false;
    for (let attempt = 0; attempt < 3 && !ready; attempt += 1) {
      try {
        await page.waitForFunction(() => {
          const entry = document.getElementById('cockpit-entry');
          return entry && !entry.hidden && !entry.disabled;
        }, { timeout: 10_000, polling: 500 });
        ready = true;
      } catch {
        await ensureTrackedFlight();
      }
    }
    if (!ready) {
      throw new Error('cockpit entry never became available after attrition recovery');
    }
    await page.$eval('#cockpit-entry', (entry) => entry.click());
  };
  const preselectedContactAdoption = await page.evaluate(async () => {
    const { styleManager, dataManager, viewer } = window.__godsEyeView;
    const flights = dataManager.layers.get('flights')?.module;
    await dataManager.setEnabled('military', true, { origin: 'programmatic' });
    const before = flights?.getTrackedInfo?.() || null;
    const trackedEntityBefore = viewer.trackedEntity;
    const blockerId = '__qa_slow_contacts_sibling__';
    const gateTimeoutMs = 5_000;
    // The transition settles behind real dependency enables (network-bound), so its
    // guard matches the harness's other network waits — a hang stop, not a budget.
    const settleTimeoutMs = 60_000;
    let releaseDisable = () => {};
    let reportDisableStarted = () => {};
    const disableGate = new Promise((resolve) => { releaseDisable = resolve; });
    const disableStarted = new Promise((resolve) => { reportDisableStarted = resolve; });
    // Every await in this probe is bounded: the gated sibling teardown is the
    // behaviour under test, so a no-show has to fail the check with evidence
    // rather than hang the whole harness on an unresolved promise.
    const settleWithin = (promise, ms) => Promise.race([
      promise.then(
        (value) => ({ settled: true, value }),
        (error) => ({ settled: true, value: `error: ${String(error?.message || error)}` }),
      ),
      new Promise((resolve) => { setTimeout(() => resolve({ settled: false, value: null }), ms); }),
    ]);
    window.__gevQaRegisterLayer(dataManager, {
      id: blockerId,
      name: 'QA slow Contacts sibling',
      icon: 'science',
      source: 'QA',
      updateInterval: -1,
      async init() { return true; },
      async enable() { return true; },
      async update() { return true; },
      async disable() {
        reportDisableStarted();
        await disableGate;
        return true;
      },
      async destroy() {},
      getStats() { return { count: 1, status: 'live' }; },
    });
    let deferCleanup = false;
    try {
      const blockerEntry = dataManager.layers.get(blockerId);
      blockerEntry.initialized = true;
      await dataManager.setEnabled(blockerId, true, { origin: 'programmatic' });
      const transition = styleManager._selectContextMode('flights');
      const disableStart = await settleWithin(disableStarted, gateTimeoutMs);
      if (!disableStart.settled) {
        releaseDisable();
        const abandoned = await settleWithin(transition, settleTimeoutMs);
        return {
          disableObserved: false,
          beforeId: before?.icao24 || null,
          timeoutReason: `QA blocker disable() never started within ${gateTimeoutMs}ms — `
            + 'the Contacts transition never tore its sibling down, so the pending-window '
            + 'probe could not be exercised',
          transitionSettled: abandoned.settled,
          transitionResult: abandoned.value,
        };
      }
      styleManager.cockpitView.syncEntry();
      const entry = document.getElementById('cockpit-entry');
      const pending = {
        changing: styleManager._contextModeChanging,
        entryHidden: Boolean(entry?.hidden),
        enterResult: styleManager.cockpitView.enter(),
        trackerPreserved: viewer.trackedEntity === trackedEntityBefore,
      };
      releaseDisable();
      const settleStartedAt = performance.now();
      const settledTransition = await settleWithin(transition, settleTimeoutMs);
      const settleMs = Math.round(performance.now() - settleStartedAt);
      styleManager.cockpitView.syncEntry();
      const awareness = dataManager.layers.get('military-awareness')?.module;
      const snapshot = awareness?.getContextSnapshot?.() || null;
      const trackedInfo = flights?.getTrackedInfo?.() || null;
      deferCleanup = true;
      return {
        disableObserved: true,
        beforeId: before?.icao24 || null,
        pending,
        transitionSettled: settledTransition.settled,
        transitionResult: settledTransition.value,
        settleMs,
        subject: snapshot?.subject ? {
          layerId: snapshot.subject.layerId,
          id: snapshot.subject.id,
        } : null,
        navigation: snapshot?.navigation || null,
        afterId: trackedInfo?.icao24 || null,
        viewerTrackedId: viewer.trackedEntity?.gevTrackedId || null,
        contextVisible: !document.getElementById('military-awareness-panel')?.hidden,
        entryAvailableAfterSettlement: Boolean(entry && !entry.hidden),
        blockerStillRegistered: dataManager.layers.has(blockerId),
        blockerEffectivelyOff: !dataManager.isEffectivelyEnabled(blockerId),
      };
    } finally {
      // Never leave the injected layer (or a gated disable) behind — a failed
      // probe must not poison the checks that run after it.
      releaseDisable();
      if (!deferCleanup && dataManager.layers.has(blockerId)) {
        if (styleManager._contextSessionSnapshot) await styleManager._selectContextMode(null);
        await window.__gevQaUnregisterLayer(dataManager, blockerId);
        styleManager.cockpitView.syncEntry();
      }
    }
  });
  check(
    'Contacts blocks early Cockpit entry, then adopts the already tracked flight after settlement',
    preselectedContactAdoption.disableObserved
      && preselectedContactAdoption.transitionSettled
      && preselectedContactAdoption.beforeId
      && preselectedContactAdoption.pending?.changing
      && preselectedContactAdoption.pending.entryHidden
      && preselectedContactAdoption.pending.enterResult === false
      && preselectedContactAdoption.pending.trackerPreserved
      && preselectedContactAdoption.transitionResult === true
      && preselectedContactAdoption.subject?.layerId === 'flights'
      && String(preselectedContactAdoption.subject.id).toLowerCase()
        === String(preselectedContactAdoption.beforeId).toLowerCase()
      && String(preselectedContactAdoption.afterId).toLowerCase()
        === String(preselectedContactAdoption.beforeId).toLowerCase()
      && String(preselectedContactAdoption.viewerTrackedId).toLowerCase()
        === `flights:${String(preselectedContactAdoption.beforeId).toLowerCase()}`
      && preselectedContactAdoption.navigation?.canPrevious === false
      && typeof preselectedContactAdoption.navigation?.canNext === 'boolean'
      && preselectedContactAdoption.contextVisible
      && preselectedContactAdoption.entryAvailableAfterSettlement
      && preselectedContactAdoption.blockerStillRegistered
      && preselectedContactAdoption.blockerEffectivelyOff,
    JSON.stringify(preselectedContactAdoption),
  );
  // The slow thing in the field is the FETCH, so that is what this holds — the
  // REAL militaryInstallations module runs throughout and reports its own
  // getStats(). An earlier cut stubbed `enable` and `getStats` instead. Both
  // were wrong, and provably so:
  //   * `enable()` is SYNCHRONOUS in production (the module's own comment says
  //     "DataLayerManager invokes update() immediately after enable(), which
  //     owns the first fetch"), so gating it blocked the Contacts activation
  //     that brings the PANEL up. The scenario then sampled markup an earlier
  //     scenario had left behind, which is why it read a stale `0`.
  //   * The panel does not observe a `getStats` stub in this scenario at all —
  //     verified by making the stub report an ANSWERED source mid-window and
  //     watching every assertion stay green. A check written against a stub the
  //     panel cannot see has no teeth, which is the same defect this scenario
  //     was created to fix.
  // Holding the network reproduces the field exactly and the panel tracks it,
  // which is what gives these assertions teeth.
  const deferredInstallationReadiness = await page.evaluate(async () => {
    const { styleManager, dataManager } = window.__godsEyeView;
    const entry = dataManager.layers.get('military-installations');
    if (!entry?.module) return { exercised: false, reason: 'military-installations missing' };
    const settleWithin = (promise, ms) => Promise.race([
      promise.then(
        (value) => ({ settled: true, value }),
        (error) => ({ settled: true, value: `error: ${String(error?.message || error)}` }),
      ),
      new Promise((resolve) => { setTimeout(() => resolve({ settled: false, value: null }), ms); }),
    ]);
    const row = () => [...document.querySelectorAll('#military-awareness-panel .military-awareness-row')]
      .find((candidate) => candidate.querySelector('strong')?.textContent?.trim() === 'Mapped installations');
    const installationCount = () => row()?.querySelector('b')?.textContent?.trim() || null;
    /** The REASON text, which is what tracks availability: the cohort engine
     *  answers 'feed unavailable' / 'feed stale' when it refuses to count. */
    const installationReason = () => row()?.querySelector('small')?.textContent?.trim() || null;

    const realFetch = window.fetch;
    let released = false;
    let requestSeen = false;
    let transition = null;
    let disabledCleanly = false;
    // The module refetches on a 500 ms camera-moveEnd debounce. The checks
    // before this one fly the camera (subject adoption), so a debounced
    // refetch can still be in flight HERE — if it lands after the stub below
    // is installed it consumes request #1's slot and the activation fetch
    // races an already-settling load, which flips the 'enabling' lifecycle
    // this check samples. Drain the debounce window first.
    const REQUEST_DEBOUNCE_DRAIN_MS = 700;
    try {
      await styleManager._selectContextMode(null);
      await dataManager.setEnabled('military-installations', false, { origin: 'programmatic' });
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DEBOUNCE_DRAIN_MS));
      // The disable can be silently refused (a pending visibility adoption
      // gate settles it without work). If the layer is still enabled here,
      // the activation below takes the manager's IDEMPOTENT exit — no
      // update(), no fetch — and the held-request scenario never starts.
      // Re-assert the disable until the manager actually holds it off.
      for (let i = 0; i < 30 && !disabledCleanly; i += 1) {
        disabledCleanly = dataManager
          .getLayerLifecycleState('military-installations')?.enabled === false;
        if (!disabledCleanly) {
          await dataManager.setEnabled('military-installations', false, { origin: 'programmatic' });
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }

      // Hold the first Overpass request open, honouring the module's own
      // AbortSignal so its camera-settle abort/refetch behaves as it does live.
      window.fetch = (input, init) => {
        const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        let url = null;
        try { url = new URL(raw, window.location.href); } catch { return realFetch(input, init); }
        if (url.pathname !== '/api/military-installations') return realFetch(input, init);
        requestSeen = true;
        // The FIRST request is held unabortable: a hung upstream genuinely
        // stays pending, and the module's moveEnd debounce refetch must not
        // tear the held window down — the moment request #1 rejects with
        // AbortError the enable transaction settles, the 'enabling' lifecycle
        // the assertions below sample is gone, and the row never mounts.
        const signal = requestSeen > 1 ? init?.signal : null;
        return new Promise((resolve, reject) => {
          let done = false;
          const fail = () => {
            if (done) return;
            done = true;
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal) {
            if (signal.aborted) return fail();
            signal.addEventListener('abort', fail, { once: true });
          }
          const tick = () => {
            if (done) return;
            if (released) {
              done = true;
              resolve(new Response(
                JSON.stringify({ elements: [], retrievedAt: new Date().toISOString() }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ));
              return;
            }
            setTimeout(tick, 100);
          };
          tick();
        });
      };

      transition = styleManager._selectContextMode('flights');
      // The activation promise stays PENDING while the first fetch is out, and
      // the Contacts panel comes up behind it — that is what a deferred
      // dependency is for. Verified live on :4272: the panel renders and reads
      // a non-numeric count for the whole of a 17 s first fetch.
      const started = await settleWithin((async () => {
        // 25 s: the enable transaction also waits on sibling context layers
        // whose upstreams rate-limit (adsb.lol answers 420 under load), so
        // the budget has to absorb upstream slowness the page does not own.
        // While the enable's own update() runs un-debounced, a follow camera
        // glued to a MOVING subject never lets Cesium fire moveEnd — the
        // module's refetch debounce never arms and the update()'s early
        // 'zoom-in' style exits are never retried. Raise the same event the
        // settled camera would raise so the production trigger fires.
        const { viewer } = window.__godsEyeView;
        for (let i = 0; i < 250 && !(requestSeen && row()); i++) {
          if (i > 0 && i % 20 === 0) viewer?.camera?.moveEnd?.raiseEvent?.();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return requestSeen && Boolean(row());
      })(), 26_000);
      styleManager.cockpitView.syncEntry();
      const pendingLifecycle = dataManager.getLayerLifecycleState('military-installations');
      const pendingCount = installationCount();
      const pendingReason = installationReason();

      // THE WINDOW: first request outstanding, panel live. Sampled more than
      // once — the field report was a panel sitting on a fabricated 0 for ~13 s,
      // so a single lucky read is not evidence.
      const fetchingCounts = [];
      const fetchingReasons = [];
      for (let i = 0; i < 6; i++) {
        fetchingCounts.push(installationCount());
        fetchingReasons.push(installationReason());
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      released = true;
      const contacts = await settleWithin(transition, 20_000);
      styleManager.cockpitView.syncEntry();
      // Measured AFTER activation settles, not during it. The sibling pin above
      // ("Contacts blocks early Cockpit entry, then adopts the already tracked
      // flight after settlement") establishes that Contacts HIDES the entry
      // while the transition is changing — that is the designed contract, and
      // asserting the opposite (as this scenario used to) could never pass.
      // What matters is that a slow dependency does not lock it away for good.
      const cockpitAvailableAfterActivation = !document.getElementById('cockpit-entry')?.hidden;
      const installed = await settleWithin((async () => {
        while (dataManager.getLayerLifecycleState('military-installations')?.lifecycleState !== 'enabled') {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        return true;
      })(), 20_000);
      const answered = await settleWithin((async () => {
        for (let i = 0; i < 160 && !/^\d+$/.test(String(installationCount())); i++) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return true;
      })(), 25_000);

      return {
        exercised: true,
        disabledCleanly,
        stubEngaged: requestSeen,
        started,
        contacts,
        pendingLifecycle,
        pendingCount,
        pendingReason,
        cockpitAvailableAfterActivation,
        installed,
        settledLifecycle: dataManager.getLayerLifecycleState('military-installations'),
        fetchingCounts,
        fetchingReasons,
        answered,
        settledCount: installationCount(),
        settledReason: installationReason(),
      };
    } finally {
      released = true;
      window.fetch = realFetch;
      if (transition) await settleWithin(transition, 20_000);
      if (styleManager._contextMode !== 'flights') {
        await settleWithin(styleManager._selectContextMode('flights'), 15_000);
      }
    }
  });
  // The panel has two truthful ways to say "nothing has answered yet" — the
  // cohort count renders `?`, and an UNKNOWN relationship renders as that word.
  // Which one is on screen depends on which panel surface is mounted, and the
  // property under test is not the token: it is that the operator is NEVER
  // shown a fabricated NUMBER for a source that has not answered. So these
  // assert numeric-vs-not, which is exactly the field report.
  const readsUnknown = (value) => typeof value === 'string' && value.length > 0 && !/^\d/.test(value);
  const readsNumber = (value) => typeof value === 'string' && /^\d+$/.test(value);
  check(
    'mapped installations load behind Contacts without a false all-clear or a locked Cockpit',
    deferredInstallationReadiness.exercised
      && deferredInstallationReadiness.disabledCleanly
      && deferredInstallationReadiness.started?.settled
      && deferredInstallationReadiness.contacts?.settled
      && deferredInstallationReadiness.contacts.value === true
      && deferredInstallationReadiness.pendingLifecycle?.lifecycleState === 'enabling'
      && readsUnknown(deferredInstallationReadiness.pendingCount)
      && /unavailable|stale/i.test(String(deferredInstallationReadiness.pendingReason))
      && deferredInstallationReadiness.cockpitAvailableAfterActivation
      && deferredInstallationReadiness.installed?.settled,
    JSON.stringify(deferredInstallationReadiness),
  );
  check(
    'installations still fetching behind a live Contacts panel never reads a number',
    deferredInstallationReadiness.exercised
      && deferredInstallationReadiness.pendingLifecycle?.lifecycleState === 'enabling'
      && Array.isArray(deferredInstallationReadiness.fetchingCounts)
      && deferredInstallationReadiness.fetchingCounts.length > 0
      && deferredInstallationReadiness.fetchingCounts.every(readsUnknown)
      && Array.isArray(deferredInstallationReadiness.fetchingReasons)
      && deferredInstallationReadiness.fetchingReasons.every((r) => /unavailable|stale/i.test(String(r))),
    JSON.stringify({
      settledLifecycle: deferredInstallationReadiness.settledLifecycle,
      fetchingCounts: deferredInstallationReadiness.fetchingCounts,
    }),
  );
  check(
    'the mapped-installations count appears once the first fetch actually answers',
    deferredInstallationReadiness.exercised
      && deferredInstallationReadiness.answered?.settled
      && readsNumber(deferredInstallationReadiness.settledCount)
      && !/unavailable|stale/i.test(String(deferredInstallationReadiness.settledReason)),
    JSON.stringify({
      answered: deferredInstallationReadiness.answered,
      settledCount: deferredInstallationReadiness.settledCount,
    }),
  );
  await ensureTrackedFlight();
  const locationContactHandoff = await page.evaluate(async () => {
    const { styleManager, dataManager, viewer } = window.__godsEyeView;
    const awareness = dataManager.layers.get('military-awareness')?.module;
    const before = awareness?.getContextSnapshot?.()?.subject || null;
    document.querySelector('#location-pills .location-pill')?.click();
    await new Promise((resolve) => setTimeout(resolve, 3600));
    const after = awareness?.getContextSnapshot?.()?.subject || null;
    const released = !viewer.trackedEntity;
    const refocused = awareness?.focusCurrent?.() === true;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const owningLayer = after?.layerId === 'militaryFlights' ? 'military-flights' : after?.layerId;
    const trackedInfo = dataManager.layers.get(owningLayer)?.module?.getTrackedInfo?.() || null;
    return {
      before: before ? { layerId: before.layerId, id: before.id } : null,
      after: after ? { layerId: after.layerId, id: after.id } : null,
      mode: styleManager._contextMode,
      released,
      refocused,
      trackedId: trackedInfo?.icao24 || trackedInfo?.id || null,
    };
  });
  check(
    'Location moves independently while Contact selection persists and Focus restores it',
    locationContactHandoff.before?.id
      && locationContactHandoff.after?.id === locationContactHandoff.before.id
      && locationContactHandoff.after?.layerId === locationContactHandoff.before.layerId
      && locationContactHandoff.mode === 'flights'
      && locationContactHandoff.released
      && locationContactHandoff.refocused
      && String(locationContactHandoff.trackedId).toLowerCase()
        === String(locationContactHandoff.before.id).toLowerCase(),
    JSON.stringify(locationContactHandoff),
  );
  await ensureTrackedFlight();
  const zoomedOutContactRefocus = await page.evaluate(async () => {
    const { dataManager, viewer } = window.__godsEyeView;
    const awareness = dataManager.layers.get('military-awareness')?.module;
    const before = awareness?.getContextSnapshot?.()?.subject || null;
    const entityBefore = viewer.trackedEntity;
    viewer.camera.zoomOut(1_500_000);
    const cameraRange = () => Math.hypot(
      viewer.camera.position.x,
      viewer.camera.position.y,
      viewer.camera.position.z,
    );
    const zoomedRange = cameraRange();
    const refocused = awareness?.focusCurrent?.() === true;
    // The reframe is delivered by the tracked camera's per-frame listener, so
    // it lands with a RENDERED frame — under SwiftShader those can be
    // seconds apart, and a fixed 180 ms sample caught the camera still
    // parked at the zoomed-out range (focusedRange === zoomedRange; a
    // standalone probe shows the same reframe landing between the 250 ms and
    // 500 ms marks). Poll to convergence instead of sampling a race.
    const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const reframeDeadline = Date.now() + 8000;
    let focusedRange = cameraRange();
    while (Date.now() < reframeDeadline && focusedRange >= 50_000) {
      await settle(250);
      focusedRange = cameraRange();
    }
    const after = awareness?.getContextSnapshot?.()?.subject || null;
    return {
      before: before ? { layerId: before.layerId, id: before.id } : null,
      after: after ? { layerId: after.layerId, id: after.id } : null,
      sameEntity: viewer.trackedEntity === entityBefore,
      refocused,
      zoomedRange: Math.round(zoomedRange),
      focusedRange: Math.round(focusedRange),
    };
  });
  check(
    'Contact Focus restores the canonical follow frame after a manual zoom-out',
    zoomedOutContactRefocus.before?.id
      && zoomedOutContactRefocus.after?.id === zoomedOutContactRefocus.before.id
      && zoomedOutContactRefocus.after?.layerId === zoomedOutContactRefocus.before.layerId
      && zoomedOutContactRefocus.sameEntity
      && zoomedOutContactRefocus.refocused
      && zoomedOutContactRefocus.zoomedRange > 1_000_000
      && zoomedOutContactRefocus.focusedRange < 50_000,
    JSON.stringify(zoomedOutContactRefocus),
  );
  await ensureTrackedFlight();
  await enterThroughCockpitEntryButton();
  await page.waitForFunction(
    () => document.body.classList.contains('cockpit-mode')
      && window.__godsEyeView.styleManager.cockpitView.active
      && !document.getElementById('cockpit-hud').hidden,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () => {
      // Require the node: `!missing?.hidden` is vacuously true, so a dropped
      // #cockpit-context would sail past this gate instead of failing here.
      const context = document.getElementById('cockpit-context');
      return Boolean(context) && !context.hidden;
    },
    { timeout: 10_000 },
  );
  const firstCockpitContact = await page.evaluate(() => {
    const awareness = window.__godsEyeView.dataManager.layers
      .get('military-awareness')?.module;
    const snapshot = awareness?.getContextSnapshot?.() || null;
    const context = document.getElementById('cockpit-context');
    const subjectText = document.getElementById('cockpit-context-subject')?.textContent || '';
    const previous = document.getElementById('cockpit-context-previous');
    const next = document.getElementById('cockpit-context-next');
    const signalText = document.getElementById('cockpit-signal-list')?.textContent || '';
    return {
      subject: snapshot?.subject ? {
        layerId: snapshot.subject.layerId,
        id: snapshot.subject.id,
        label: snapshot.subject.label,
      } : null,
      contextVisible: Boolean(context && !context.hidden
        && getComputedStyle(context).display !== 'none'),
      subjectText,
      previousDisabled: previous?.disabled,
      nextDisabled: next?.disabled,
      navigation: snapshot?.navigation || null,
      contextStandby: signalText.includes('CONTEXT STANDBY'),
    };
  });
  check(
    'first Cockpit entry shows matching Contact Previous/Next controls',
    firstCockpitContact.contextVisible
      && firstCockpitContact.subject?.layerId === 'flights'
      && String(firstCockpitContact.subject.id).toLowerCase()
        === String(tracked.id).toLowerCase()
      && firstCockpitContact.subjectText.startsWith(
        `${firstCockpitContact.subject.label} ·`,
      )
      && firstCockpitContact.previousDisabled
        === !firstCockpitContact.navigation?.canPrevious
      && firstCockpitContact.nextDisabled
        === !firstCockpitContact.navigation?.canNext
      && !firstCockpitContact.contextStandby,
    JSON.stringify(firstCockpitContact),
  );
  // Field test 2026-08-18: "when you click on Contacts, detections should
  // just turn on, and they should stay on in Cockpit or in third-person
  // tracking inside Contacts or inside Cockpit, both… when I leave the Cockpit,
  // detections go off" — that last part being the bug. Driven through the REAL
  // context-mode transaction and the REAL CockpitViewController with a live
  // tracked flight: the one path a Node unit test cannot boot.
  await ensureCockpitSession();
  const contactsDetection = await page.evaluate(async () => {
    const { styleManager } = window.__godsEyeView;
    const cockpit = styleManager.cockpitView;
    const mode = () => styleManager.getDetectionState().detectionMode;
    const density = () => styleManager.getDetectionState().densityPct;
    const settle = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms));
    // Cockpit entry needs an auto-focused subject, which arrives a beat after
    // the Contacts transaction settles. Bounded so a stall fails the check
    // rather than hanging the harness.
    const enterCockpit = async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (cockpit.enter() === true) return true;
        await settle(200);
      }
      return false;
    };
    const originalOverridden = styleManager._detectionUserOverridden;

    // Start from outside both, so activation is a real edge.
    cockpit.exit({ restoreTracking: true });
    await settle();
    await styleManager._selectContextMode(null);
    await settle(400);
    const cleanupSnapshotCleared = styleManager._contextSessionSnapshot === null;
    const cleanupBlockerId = '__qa_slow_contacts_sibling__';
    const cleanupUnregistered = await window.__gevQaUnregisterLayer(
      window.__godsEyeView.dataManager,
      cleanupBlockerId,
    );
    const cleanupBlockerAbsent = !window.__godsEyeView.dataManager.layers.has(cleanupBlockerId);
    // Adversarial precondition: detection explicitly OFF at a NON-tactical
    // density, and the operator already flagged as having overridden detection
    // this session — the flag that suppresses the military-style auto-enable.
    styleManager.setDetection({ enabled: false, densityPct: 25 });
    await settle();
    const beforeContacts = mode();
    const overriddenBeforeContacts = styleManager._detectionUserOverridden;

    // 1. Activating Contacts forces the tactical preset on.
    const contactsOn = await styleManager._selectContextMode('flights');
    await settle(400);
    const afterContactsOn = mode();
    const afterContactsOnDensity = density();

    // 2. Cockpit enter and exit are moves WITHIN the session: detection unchanged.
    const entered = await enterCockpit();
    await settle();
    const insideCockpit = mode();
    cockpit.cycleVisionMode(1);
    await settle();
    const afterVisionCycle = mode();
    cockpit.setVisionMode('optical');
    await settle();
    const exited = cockpit.exit({ restoreTracking: true }) === true;
    await settle();
    const afterCockpitExit = mode();
    const afterCockpitExitDensity = density();

    // 3. A manual off during the session holds — even across a cockpit re-entry.
    document.getElementById('detection-toggle')?.click();
    await settle();
    const afterManualOff = mode();
    const reentered = await enterCockpit();
    await settle();
    const afterCockpitReentry = mode();
    cockpit.exit({ restoreTracking: true });
    await settle();

    // 4. Deactivating Contacts restores the pre-Contacts state.
    await styleManager._selectContextMode(null);
    await settle(400);
    const afterContactsOff = mode();
    const afterContactsOffDensity = density();
    // The operator's next manual enable must come back at THEIR profile, not
    // the tactical density Contacts stamped on.
    document.getElementById('detection-toggle')?.click();
    await settle();
    const manualEnableMode = mode();
    const manualEnableDensity = density();
    styleManager.setDetection({ enabled: false });
    await settle();

    // Leave the session exactly as the following checks expect it.
    const restoredContacts = await styleManager._selectContextMode('flights');
    await settle(400);
    const restoredCockpit = await enterCockpit();
    styleManager._detectionUserOverridden = originalOverridden;
    await settle();
    return {
      beforeContacts,
      overriddenBeforeContacts,
      contactsOn,
      afterContactsOn,
      afterContactsOnDensity,
      entered,
      insideCockpit,
      afterVisionCycle,
      exited,
      afterCockpitExit,
      afterCockpitExitDensity,
      afterManualOff,
      reentered,
      afterCockpitReentry,
      afterContactsOff,
      afterContactsOffDensity,
      manualEnableMode,
      manualEnableDensity,
      restoredContacts,
      restoredCockpit,
      cockpitActive: cockpit.active,
      cleanupSnapshotCleared,
      cleanupUnregistered,
      cleanupBlockerAbsent,
    };
  });
  check(
    'Contacts owns detection: activation forces the tactical preset, cockpit transitions leave it alone, deactivation restores',
    contactsDetection.contactsOn === true
      && contactsDetection.entered
      && contactsDetection.exited
      && contactsDetection.reentered
      && contactsDetection.restoredContacts === true
      && contactsDetection.restoredCockpit
      && contactsDetection.cockpitActive
      && contactsDetection.cleanupSnapshotCleared
      && contactsDetection.cleanupUnregistered
      && contactsDetection.cleanupBlockerAbsent
      && contactsDetection.beforeContacts === 'OFF'
      && contactsDetection.overriddenBeforeContacts === true
      // Activation forces the military look — Dense @ 75%, not the 25% the
      // operator was sitting at, and regardless of the override flag.
      && contactsDetection.afterContactsOn === 'DENSE'
      && contactsDetection.afterContactsOnDensity === 75
      // Cockpit is a move WITHIN Contacts: enter, vision cycle and — the actual
      // bug — EXIT must all leave detection exactly where it was.
      && contactsDetection.insideCockpit === 'DENSE'
      && contactsDetection.afterVisionCycle === 'DENSE'
      && contactsDetection.afterCockpitExit === 'DENSE'
      && contactsDetection.afterCockpitExitDensity === 75
      // A manual off holds for the session, including across a cockpit re-entry.
      && contactsDetection.afterManualOff === 'OFF'
      && contactsDetection.afterCockpitReentry === 'OFF'
      // Leaving Contacts restores the pre-Contacts state — mode AND density, so
      // the operator's next manual enable returns their own 25% profile rather
      // than the tactical 75% Contacts stamped on.
      && contactsDetection.afterContactsOff === 'OFF'
      && contactsDetection.afterContactsOffDensity === 25
      && contactsDetection.manualEnableMode === 'SPARSE'
      && contactsDetection.manualEnableDensity === 25,
    JSON.stringify(contactsDetection),
  );
  await ensureCockpitSession();
  const densityNavigation = await page.evaluate(async () => {
    const { styleManager, dataManager, viewer } = window.__godsEyeView;
    const cockpit = styleManager.cockpitView;
    const awareness = dataManager.layers.get('military-awareness')?.module;
    const settle = (ms = 260) => new Promise((resolve) => setTimeout(resolve, ms));
    const snapshot = (step) => {
      const context = awareness?.getContextSnapshot?.() || null;
      const tracker = viewer.trackedEntity || cockpit.trackedEntity;
      return {
        step,
        cockpitActive: cockpit.active,
        bodyCockpit: document.body.classList.contains('cockpit-mode'),
        contextMode: styleManager._contextMode,
        contextChanging: styleManager._contextModeChanging,
        subject: context?.subject ? `${context.subject.layerId}:${context.subject.id}` : null,
        tracked: tracker?.gevTrackedId || null,
        density: styleManager.getDetectionState().densityPct,
        detectionMode: styleManager.getDetectionState().detectionMode,
        installations: dataManager.getLayerLifecycleState('military-installations'),
      };
    };
    const setDensityFromUi = (value) => {
      const slider = document.getElementById('detection-density-slider');
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const states = [snapshot('before')];
    setDensityFromUi(25);
    states.push(snapshot('sparse'));
    document.getElementById('cockpit-context-next')?.click();
    await settle(1700);
    states.push(snapshot('ui-next'));
    setDensityFromUi(75);
    document.getElementById('cockpit-context-previous')?.click();
    await settle(1700);
    states.push(snapshot('ui-previous'));
    const voiceNext = styleManager.controlCockpit('next');
    await settle(1700);
    states.push(snapshot('voice-next'));
    const voicePrevious = styleManager.controlCockpit('previous');
    await settle(1700);
    states.push(snapshot('voice-previous'));

    const exited = cockpit.exit({ restoreTracking: true }) === true;
    await settle(100);
    const mapBefore = snapshot('map-before');
    const mapNext = awareness?.navigateNext?.({ origin: 'user' }) === true;
    await settle();
    const mapAfterNext = snapshot('map-next');
    const mapPrevious = awareness?.navigatePrevious?.({ origin: 'user' }) === true;
    await settle();
    const mapAfterPrevious = snapshot('map-previous');
    const reentered = cockpit.enter() === true;
    await settle(100);
    states.push(snapshot('reentered'));
    return {
      states,
      voiceNext: voiceNext.ok,
      voicePrevious: voicePrevious.ok,
      exited,
      mapBefore,
      mapNext,
      mapAfterNext,
      mapPrevious,
      mapAfterPrevious,
      reentered,
    };
  });
  const cockpitStatesStable = densityNavigation.states.every((state) => (
    state.cockpitActive
      && state.bodyCockpit
      && state.contextMode === 'flights'
      && !state.contextChanging
      && state.subject
      && state.tracked
  ));
  check(
    'Dense/Sparse UI and voice Next/Previous keep Cockpit active and standard Flights tracking stable',
    cockpitStatesStable
      && densityNavigation.states.find(({ step }) => step === 'sparse')?.density === 25
      && densityNavigation.states.find(({ step }) => step === 'ui-next')?.density === 25
      && densityNavigation.states.find(({ step }) => step === 'ui-previous')?.density === 75
      && densityNavigation.voiceNext
      && densityNavigation.voicePrevious
      && densityNavigation.exited
      && !densityNavigation.mapBefore.cockpitActive
      && densityNavigation.mapBefore.contextMode === 'flights'
      && densityNavigation.mapNext
      && densityNavigation.mapAfterNext.tracked
      && densityNavigation.mapPrevious
      && densityNavigation.mapAfterPrevious.tracked
      && densityNavigation.reentered,
    JSON.stringify(densityNavigation),
  );
  await ensureCockpitSession();
  const cockpitExitOwnership = await page.evaluate(async () => {
    const { styleManager, dataManager, viewer } = window.__godsEyeView;
    const awareness = dataManager.layers.get('military-awareness')?.module;
    const entity = viewer.trackedEntity || styleManager.cockpitView.trackedEntity;
    const listenersBeforeExit = viewer.scene.preUpdate.numberOfListeners;
    const exited = styleManager.cockpitView.exit() === true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const listenersAfterExit = viewer.scene.preUpdate.numberOfListeners;
    const refocused = awareness?.focusCurrent?.() === true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      exited,
      refocused,
      sameEntity: viewer.trackedEntity === entity,
      listenersBeforeExit,
      listenersAfterExit,
      listenersAfterFocus: viewer.scene.preUpdate.numberOfListeners,
    };
  });
  check(
    'Cockpit exit and later Contact Focus retain one source-owned camera-frame listener',
    cockpitExitOwnership.exited
      && cockpitExitOwnership.refocused
      && cockpitExitOwnership.sameEntity
      && cockpitExitOwnership.listenersAfterExit === cockpitExitOwnership.listenersBeforeExit + 1
      && cockpitExitOwnership.listenersAfterFocus === cockpitExitOwnership.listenersAfterExit,
    JSON.stringify(cockpitExitOwnership),
  );
  await ensureTrackedFlight();
  const cockpitPanelRoundTrip = await page.evaluate(async () => {
    const manager = window.__godsEyeView.styleManager;
    const panelIds = [
      'data-panel',
      'cctv-panel',
      'scene-panel',
      'pp-toggles',
      'global-context-panel',
      'radio-panel',
    ];
    const read = () => Object.fromEntries(panelIds.map((panelId) => [
      panelId,
      document.getElementById(panelId)?.classList.contains('collapsed'),
    ]));
    const desired = new Map([
      ['data-panel', false],
      ['cctv-panel', true],
      ['scene-panel', true],
      ['pp-toggles', true],
      ['global-context-panel', false],
      ['radio-panel', true],
    ]);
    for (const [panelId, collapsed] of desired) {
      manager.setPanelCollapsed(panelId, collapsed, { persist: false, syncShare: false });
    }
    const before = read();
    document.getElementById('cockpit-entry')?.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const during = read();
    manager.setPanelCollapsed('data-panel', false, { persist: false, syncShare: false });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const dataRect = document.getElementById('data-panel')?.getBoundingClientRect();
    const contactRect = document.getElementById('cockpit-context')?.getBoundingClientRect();
    const clearancePx = dataRect && contactRect ? contactRect.top - dataRect.bottom : null;
    const contactAutoCollapsed = manager.cockpitView.contextCollapsed === true;
    manager.setPanelCollapsed('data-panel', true, { persist: false, syncShare: false });
    const contactAutoRestored = manager.cockpitView.contextCollapsed === false;
    manager.cockpitView.setContextCollapsed(true);
    manager.setPanelCollapsed('data-panel', false, { persist: false, syncShare: false });
    manager.setPanelCollapsed('data-panel', true, { persist: false, syncShare: false });
    const manualContactCollapseRetained = manager.cockpitView.contextCollapsed === true;
    manager.cockpitView.setContextCollapsed(false);
    const exited = manager.cockpitView.exit() === true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      before,
      during,
      after: read(),
      exited,
      clearancePx,
      contactAutoCollapsed,
      contactAutoRestored,
      manualContactCollapseRetained,
    };
  });
  check(
    'Cockpit temporarily collapses standard panels and restores the exact map layout on exit',
    cockpitPanelRoundTrip.exited
      && Object.values(cockpitPanelRoundTrip.during).every(Boolean)
      && JSON.stringify(cockpitPanelRoundTrip.after)
        === JSON.stringify(cockpitPanelRoundTrip.before)
      && Number.isFinite(cockpitPanelRoundTrip.clearancePx)
      && cockpitPanelRoundTrip.clearancePx >= 0
      && cockpitPanelRoundTrip.contactAutoCollapsed
      && cockpitPanelRoundTrip.contactAutoRestored
      && cockpitPanelRoundTrip.manualContactCollapseRetained,
    JSON.stringify(cockpitPanelRoundTrip),
  );
  await ensureTrackedFlight();
  await enterThroughCockpitEntryButton();
  await page.waitForFunction(
    () => document.body.classList.contains('cockpit-mode')
      && window.__godsEyeView.styleManager.cockpitView.active,
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager._setCockpitDisclosure('display', false);
    manager._setCockpitDisclosure('radio', false);
  });

  await ensureCockpitSession();
  const visionCycle = await page.evaluate(async () => {
    const manager = window.__godsEyeView.styleManager;
    const cockpit = manager.cockpitView;
    const current = document.getElementById('cockpit-vision-current');
    const label = document.getElementById('cockpit-vision-current-label');
    const read = () => ({
      mode: current?.dataset.cockpitVision,
      label: label?.textContent?.trim(),
      aria: current?.getAttribute('aria-label'),
      displayOpen: document.getElementById('cockpit-display-toggle-btn')?.getAttribute('aria-expanded'),
      radioOpen: document.getElementById('cockpit-radio-toggle-btn')?.getAttribute('aria-expanded'),
      parametersActive: document.getElementById('param-slider-panel')?.classList.contains('active'),
      parametersCollapsed: document.getElementById('param-slider-panel')?.classList.contains('collapsed'),
      signalCollapsed: cockpit.signalCollapsed,
      focusRetained: document.activeElement === current,
    });
    manager._setCockpitDisclosure('display', false);
    manager._setCockpitDisclosure('radio', false);
    cockpit.setVisionMode('optical');
    current.focus({ preventScroll: true });
    const states = [read()];
    for (let index = 0; index < 5; index += 1) {
      current.click();
      states.push(read());
    }
    const originalStyle = manager.activeStyle;
    manager.setStyle('noir');
    await new Promise((resolve) => setTimeout(resolve, 900));
    cockpit.setVisionMode('optical');
    const inheritedNoir = read();
    cockpit.setVisionMode('noir');
    const explicitNoir = read();
    cockpit.setVisionMode('optical');
    const restoredNoir = {
      ...read(),
      activeStyle: manager.activeStyle,
      intensity: manager.stages.noir?.uniforms?.intensity,
    };
    manager.setStyle(originalStyle);
    await new Promise((resolve) => setTimeout(resolve, 900));
    cockpit.setVisionMode('optical');
    return { states, inheritedNoir, explicitNoir, restoredNoir };
  });
  check(
    'Cockpit vision control exposes inherited, CRT, NVG, FLIR, and NOIR before wrapping',
    JSON.stringify(visionCycle.states.map((state) => state.mode))
      === JSON.stringify(['optical', 'crt', 'nvg', 'thermal', 'noir', 'optical'])
      && visionCycle.states[4]?.label === 'NOIR'
      && visionCycle.states[4]?.aria === 'Current cockpit vision style: Noir. Activate for next style.',
    JSON.stringify(visionCycle),
  );
  check(
    'user vision changes open Display for every temporary treatment and retain selector focus',
    visionCycle.states[1]?.mode === 'crt'
      && visionCycle.states.slice(1, 5).every((state) => state.displayOpen === 'true')
      && visionCycle.states.slice(1, 5).every((state) => state.radioOpen === 'false')
      && visionCycle.states.slice(1, 5).every((state) => state.parametersActive)
      && visionCycle.states.slice(1, 5).every((state) => !state.parametersCollapsed)
      && visionCycle.states.slice(1, 5).every((state) => state.signalCollapsed)
      && visionCycle.states.every((state) => state.focusRetained),
    JSON.stringify(visionCycle.states),
  );
  check(
    'inherited Noir and explicit Noir keep distinct ownership and restore the Noir map preset',
    visionCycle.inheritedNoir?.mode === 'optical'
      && visionCycle.inheritedNoir?.label === 'NOIR'
      && visionCycle.explicitNoir?.mode === 'noir'
      && visionCycle.explicitNoir?.label === 'NOIR'
      && visionCycle.restoredNoir?.mode === 'optical'
      && visionCycle.restoredNoir?.activeStyle === 'noir'
      && visionCycle.restoredNoir?.intensity === 1,
    JSON.stringify(visionCycle),
  );
  await page.evaluate(() => window.__godsEyeView.styleManager.cockpitView.setVisionMode('noir'));
  await page.screenshot({ path: path.join(shotsDir, 'vision-noir.png') });
  await page.evaluate(() => window.__godsEyeView.styleManager.cockpitView.setVisionMode('optical'));

  const desktopState = async (variant, openKind) => page.evaluate(async ({ variantName, kind }) => {
    const manager = window.__godsEyeView.styleManager;
    const hud = document.getElementById('cockpit-hud');
    const signal = document.getElementById('cockpit-signal-stream');
    const utility = document.getElementById('cockpit-utility-controls');
    const display = document.getElementById('cockpit-display-toggle-btn');
    const radio = document.getElementById('cockpit-radio-toggle-btn');
    const displayControl = display.closest('.cockpit-utility-control');
    const radioControl = radio.closest('.cockpit-utility-control');
    manager._setCockpitDisclosure('display', false);
    manager._setCockpitDisclosure('radio', false);
    if (variantName === 'off') manager.hud.setMode('off');
    else {
      manager._setHudVariant(variantName);
      manager.hud.setMode('on');
    }
    manager._updateHudButtonState();
    await new Promise((resolve) => setTimeout(resolve, 360));
    document.body.classList.add('cockpit-mode');
    manager.cockpitView.active = true;
    hud.hidden = false;
    signal.hidden = false;
    // Cockpit owns --cockpit-utility-top and republishes it every layout tick,
    // so the corridor is driven through its real input: how far up the briefing
    // card reaches. A short card leaves the strip a roomy corridor.
    const priorSignalMaxHeight = signal.style.maxHeight;
    signal.style.maxHeight = '150px';
    manager._setCockpitDisclosure(kind, true);
    // One pass must be enough. Record the result of the FIRST layout call, then
    // confirm a second changes nothing, so a convergence regression cannot hide
    // behind a repeated call.
    manager.cockpitView.syncSignalLayout();
    const firstPassTop = hud.style.getPropertyValue('--cockpit-utility-top');
    const firstPassPrimaryOnly = utility.classList.contains('layout-primary-only');
    manager.cockpitView.syncSignalLayout();
    const signalTop = signal.getBoundingClientRect().top;
    const expanded = kind === 'display' ? displayControl : radioControl;
    const sibling = kind === 'display' ? radioControl : displayControl;
    const state = {
      variant: variantName,
      kind,
      signalTop: Math.round(signalTop),
      firstPassTop,
      idempotent: firstPassTop === hud.style.getPropertyValue('--cockpit-utility-top')
        && firstPassPrimaryOnly === utility.classList.contains('layout-primary-only'),
      utilityTop: hud.style.getPropertyValue('--cockpit-utility-top'),
      primaryOnly: utility.classList.contains('layout-primary-only'),
      expandedRect: expanded.getBoundingClientRect().toJSON(),
      siblingRect: sibling.getBoundingClientRect().toJSON(),
      siblingDisplay: getComputedStyle(sibling).display,
      siblingAriaHidden: sibling.getAttribute('aria-hidden'),
      siblingExpanded: sibling.querySelector('[aria-expanded]')?.getAttribute('aria-expanded'),
      contained: expanded.getBoundingClientRect().bottom <= signalTop - 7,
    };
    signal.style.maxHeight = priorSignalMaxHeight;
    manager.cockpitView.syncSignalLayout();
    return state;
  }, { variantName: variant, kind: openKind });

  for (const variant of ['off', 'minimal', 'tactical', 'operator']) {
    for (const kind of ['display', 'radio']) {
      const state = await desktopState(variant, kind);
      check(
        `${variant} ${kind} keeps its collapsed sibling visible in a roomy corridor`,
        !state.primaryOnly
          && state.expandedRect.width > 0
          && state.siblingRect.width > 0
          && state.siblingRect.height > 0
          && state.siblingDisplay !== 'none'
          && state.siblingAriaHidden === 'false'
          && state.siblingExpanded === 'false'
          && state.contained,
        JSON.stringify(state),
      );
      check(
        `${variant} ${kind} settles the strip anchor in one layout pass`,
        state.idempotent && state.firstPassTop === state.utilityTop,
        `first=${state.firstPassTop} settled=${state.utilityTop}`,
      );
    }
  }
  await page.screenshot({ path: path.join(shotsDir, 'roomy-desktop.png') });
  check(
    'roomy screenshot remains in a real Cockpit session',
    await page.evaluate(() => document.body.classList.contains('cockpit-mode')
      && window.__godsEyeView.styleManager.cockpitView.active
      && getComputedStyle(document.getElementById('cockpit-utility-controls')).display !== 'none'),
  );

  await ensureCockpitSession();
  const portalScroll = await page.evaluate(async () => {
    const manager = window.__godsEyeView.styleManager;
    const standard = document.getElementById('pp-toggles');
    const cockpit = document.getElementById('cockpit-display-panel');
    const waitFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Scroll-event trace: identifies which move/restore produces the final
    // cockpit offset when the round trip drifts.
    const trace = [];
    let tracePhase = 'prep';
    cockpit.addEventListener('scroll', () => {
      trace.push(`cockpit=${cockpit.scrollTop} owner=${JSON.stringify(manager._displayPortalScrollRestoreOwner)}`
        + ` active=${manager._cockpitDisplayPortalActive} saved=${manager._cockpitDisplayScrollTop} phase=${tracePhase}`);
    }, { passive: true });
    const priorStandardMaxHeight = standard.style.maxHeight;
    const priorStandardHeight = standard.style.height;
    const priorStandardOverflow = standard.style.overflowY;
    const priorCockpitMaxHeight = cockpit.style.maxHeight;
    const priorCockpitHeight = cockpit.style.height;
    const priorCockpitOverflow = cockpit.style.overflowY;
    const standardWasCollapsed = standard.classList.contains('collapsed');
    manager._setCockpitDisplayPortalActive(false);
    document.body.classList.remove('cockpit-mode');
    await waitFrames();
    standard.classList.remove('collapsed');
    standard.style.height = '120px';
    standard.style.maxHeight = '120px';
    standard.style.overflowY = 'auto';
    standard.scrollTop = Math.min(80, standard.scrollHeight - standard.clientHeight);
    await waitFrames();
    const standardBefore = standard.scrollTop;
    tracePhase = 'activate-1';
    document.body.classList.add('cockpit-mode');
    manager._setCockpitDisplayPortalActive(true);
    manager._setCockpitDisclosure('display', true);
    await waitFrames();
    cockpit.style.height = '120px';
    cockpit.style.maxHeight = '120px';
    cockpit.style.overflowY = 'auto';
    tracePhase = 'seed-cockpit-60';
    cockpit.scrollTop = Math.min(60, cockpit.scrollHeight - cockpit.clientHeight);
    await waitFrames();
    const cockpitBefore = cockpit.scrollTop;
    tracePhase = 'deactivate';
    document.body.classList.remove('cockpit-mode');
    manager._setCockpitDisplayPortalActive(false);
    await waitFrames();
    const standardAfter = standard.scrollTop;
    const standardSaved = manager._standardDisplayScrollTop;
    const standardClientHeight = standard.clientHeight;
    const standardScrollHeight = standard.scrollHeight;
    tracePhase = 'activate-2';
    document.body.classList.add('cockpit-mode');
    manager._setCockpitDisplayPortalActive(true);
    manager._setCockpitDisclosure('display', true);
    await waitFrames();
    const cockpitAfter = cockpit.scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cockpitSettled = cockpit.scrollTop;
    standard.style.height = priorStandardHeight;
    standard.style.maxHeight = priorStandardMaxHeight;
    standard.style.overflowY = priorStandardOverflow;
    cockpit.style.height = priorCockpitHeight;
    cockpit.style.maxHeight = priorCockpitMaxHeight;
    cockpit.style.overflowY = priorCockpitOverflow;
    standard.classList.toggle('collapsed', standardWasCollapsed);
    return {
      standardBefore,
      standardAfter,
      standardSaved,
      standardClientHeight,
      standardScrollHeight,
      cockpitBefore,
      cockpitAfter,
      cockpitSettled,
      trace,
    };
  });
  check(
    'Display portal round trip preserves standard and Cockpit scroll owners',
    portalScroll.standardBefore > 0
      && portalScroll.cockpitBefore > 0
      && portalScroll.standardAfter === portalScroll.standardBefore
      && portalScroll.cockpitAfter === portalScroll.cockpitBefore,
    JSON.stringify(portalScroll),
  );

  await ensureCockpitSession();
  const boundary = await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    const hud = document.getElementById('cockpit-hud');
    const signal = document.getElementById('cockpit-signal-stream');
    const utility = document.getElementById('cockpit-utility-controls');
    const display = document.getElementById('cockpit-display-toggle-btn');
    const radio = document.getElementById('cockpit-radio-toggle-btn');
    const displayControl = display.closest('.cockpit-utility-control');
    const radioControl = radio.closest('.cockpit-utility-control');
    document.body.classList.add('cockpit-mode');
    manager.cockpitView.active = true;
    hud.hidden = false;
    signal.hidden = false;
    manager._setCockpitDisclosure('radio', false);
    manager._setCockpitDisclosure('display', true);
    const priorSignalMaxHeight = signal.style.maxHeight;
    const priorSignalHeight = signal.style.height;
    // The strip is pinned to the viewport ceiling once the briefing card grows
    // into its lane, so the corridor is sized by moving that card's top edge —
    // the wall Cockpit actually solves against — not by injecting an anchor.
    // The card is bottom-anchored (bottom: var(--cockpit-bottom-rail-safe)),
    // so an explicit height moves its top edge. The previous 40 px lever floor
    // capped the card top at viewport - 199 - 40 = 661.1 px — exactly ON the
    // fit boundary for this strip — which turned every seed into the same
    // sub-pixel coin flip. A 4 px floor keeps the element boxable while
    // letting the top edge traverse the whole boundary region.
    const minTop = Math.max(96, window.innerHeight * 0.12);
    const LEVER_MIN_HEIGHT_PX = 4;
    const bottomOffsetPx = Number.parseFloat(getComputedStyle(signal).bottom) || 0;
    const maxCardTop = window.innerHeight - bottomOffsetPx - LEVER_MIN_HEIGHT_PX;
    const moveSignalTopTo = (rawWantTop) => {
      // Seeds beyond the geometric maximum (fully-collapsed card) clamp to it;
      // "roomy"/"restored" only need to sit safely inside the fit, and the
      // clamped position is deeper inside than any seed could demand.
      const wantTop = Math.min(rawWantTop, maxCardTop);
      const passes = [];
      for (let pass = 0; pass < 10; pass += 1) {
        const rect = signal.getBoundingClientRect();
        const delta = wantTop - rect.top;
        if (Math.abs(delta) < 0.2) break;
        // `current` is the SPECIFIED height; whatever constant the box model
        // and the card's 3D projection add on top (the rendered-vs-specified
        // drift) is re-incurred automatically on the next render, so it must
        // NOT be folded in here. Subtracting it too cancelled the correction
        // every pass: the spec settled at `current − delta − drift + drift`
        // and the card froze ~5.8 px short of the target forever.
        const current = Number.parseFloat(signal.style.height) || rect.height;
        const next = Math.max(LEVER_MIN_HEIGHT_PX, current - delta);
        signal.style.height = `${next}px`;
        passes.push({
          pass,
          connected: signal.isConnected,
          beforeTop: Number(rect.top.toFixed(3)),
          delta: Number(delta.toFixed(3)),
          current: Number(current.toFixed(3)),
          drift: Number((rect.height - current).toFixed(3)),
          next: Number(next.toFixed(3)),
        });
      }
      // One layout pass owns the decision; the second only proves it settled.
      // (A pass that newly hides the collapsed sibling legitimately re-anchors
      // the now-shorter strip, so idempotence is asserted where the strip's
      // composition is unchanged.)
      manager.cockpitView.syncSignalLayout();
      const firstPassTop = hud.style.getPropertyValue('--cockpit-utility-top');
      const firstPassPrimaryOnly = utility.classList.contains('layout-primary-only');
      manager.cockpitView.syncSignalLayout();
      const landed = signal.getBoundingClientRect();
      return {
        wantTop: Number(wantTop.toFixed(3)),
        passes,
        landedTop: Number(landed.top.toFixed(3)),
        landedHeight: Number(landed.height.toFixed(3)),
        firstPassTop,
        firstPassPrimaryOnly,
        idempotent: firstPassTop === hud.style.getPropertyValue('--cockpit-utility-top')
          && firstPassPrimaryOnly === utility.classList.contains('layout-primary-only'),
      };
    };
    signal.style.maxHeight = 'none';
    // The card's briefing content carries its own minimum height (~200 px),
    // which pins the card's top edge just under the strip and turns `height`
    // into a dead lever — the corridor then always equals the rendered strip
    // and the fit boundary can never be straddled. Park the content so the
    // explicit height is the only driver of the card's top edge. The window's
    // own box chrome floors it too: ~15.8 px of padding/border/min-height
    // kept the rendered height at ~19.8 px no matter what was specified,
    // which put the card's lowest reachable top ABOVE the fit boundary —
    // no "inside the fit" seed was geometrically reachable at all (the floor
    // left available = strip + 0.008 px, i.e. inside by luck of rounding).
    // Zero the chrome so height drives the top edge 1:1 down to the lever
    // floor.
    const cardChildren = [...signal.querySelectorAll(':scope > *')];
    const priorChildDisplays = cardChildren.map((child) => child.style.display);
    cardChildren.forEach((child) => { child.style.display = 'none'; });
    const priorBoxChrome = {
      padding: signal.style.padding,
      borderWidth: signal.style.borderWidth,
      minHeight: signal.style.minHeight,
    };
    signal.style.padding = '0px';
    signal.style.borderWidth = '0px';
    signal.style.minHeight = '0px';
    // Take the REC readout out of the anchor too. With it rendered, the strip
    // anchors at recBottom + 12 ≈ 182 — only ~5 px above the card's fully
    // collapsed floor, so "inside the fit" and "outside the fit" were both
    // within 0.1 px of the same position: available ≡ rendered strip vs
    // budget to within sub-pixel measurement noise, a structural coin flip
    // (run 20's restored phase re-collapsed on 0.06 px). Production already
    // defines the no-REC case — isRenderedOnScreen() → recBottom 0 → the
    // anchor drops to minTop — which widens the inside-the-fit corridor by
    // the full anchor delta (74 px here) without inventing any state.
    const recReadout = document.querySelector('#intel-hud .hud-top-right');
    const priorRecDisplay = recReadout ? recReadout.style.display : '';
    if (recReadout) recReadout.style.display = 'none';
    // Seed a RELAXED corridor before measuring the requirement: a squeezed
    // panel reports a compressed scrollHeight (flex children shrink under
    // height pressure), which under-quotes the height the production decision
    // actually compares against. The old 40 px seed was not relaxed at all —
    // it landed within 0.002 px of this strip's exact fit boundary.
    signal.style.height = `${LEVER_MIN_HEIGHT_PX}px`;
    manager.cockpitView.syncSignalLayout();
    const seededRect = signal.getBoundingClientRect();
    const expandedHeight = Math.max(displayControl.scrollHeight, displayControl.getBoundingClientRect().height);
    // Mirror production's decision inputs exactly: resolveCockpitUtilityLayout
    // compares against the collapsed LAUNCHER's scrollHeight (floored at 50),
    // not the launcher control's — the control's padding made this harness's
    // budget 2 px larger than production's, which swallowed the entire 2 px
    // straddle and left the "constrained" seed 1.1 px inside the fit.
    const radioLauncher = radioControl.querySelector('.cockpit-utility-launcher');
    const collapsedHeight = Math.max(50, radioLauncher
      ? radioLauncher.scrollHeight
      : radioControl.scrollHeight);
    // The decision budget production actually compares against:
    // primaryOnly ⇔ expandedHeight + 7 + collapsedHeight > available.
    const budget = expandedHeight + 7 + collapsedHeight;
    // Straddle the fit by a pixel instead of aiming AT it. `moveSignalTopTo` only
    // converges to within 0.2 px and the production decision is a strict `>`
    // against exactly that budget, so a corridor sized to the boundary itself
    // resolves on sub-pixel residue — a coin flip, not a behaviour. It happened to
    // land heads until Display grew 36 px on 2026-08-22 (the 3D Proximity/All row
    // now ships open), which is what surfaced it. One pixel inside the fit and one
    // pixel outside proves the same transition, deterministically.
    const BOUNDARY_EPSILON_PX = 1;
    // With the REC readout parked, production anchors at minTop (its own
    // no-REC path) — read the solved var back rather than assuming it.
    const solvedAnchorTop = Number.parseFloat(hud.style.getPropertyValue('--cockpit-utility-top'));
    const anchorTop = Number.isFinite(solvedAnchorTop)
      ? solvedAnchorTop
      : minTop;
    // The anchor regime decides where a constraint can even bite. For a card
    // top between minTop + 8 + renderedStrip and anchorTop + 8 + renderedStrip,
    // production solves top = signalTop − 8 − strip, so `available` comes out
    // EQUAL to the rendered strip no matter where the card sits — no position
    // in that whole band can flip the decision (this is what froze every seed
    // to the same verdict). Available only drops below the budget when the top
    // clamps at minTop (card grown tall): then available = signalTop − minTop
    // − 8, and the strict `>` flips one pixel below minTop + 8 + budget.
    const stripRendered = utility.getBoundingClientRect().height;
    const exactSignalTop = anchorTop + 8 + stripRendered + BOUNDARY_EPSILON_PX;
    const constrainedSignalTop = minTop + 8 + budget - BOUNDARY_EPSILON_PX;
    // Production measurements at each seed, to expose which side of the model
    // the live solve disagrees with when the boundary misbehaves.
    const samples = [];
    const sample = (tag) => {
      const expandedRect = displayControl.getBoundingClientRect().height;
      const rec = document.querySelector('#intel-hud .hud-top-right');
      samples.push({
        tag,
        primaryOnly: utility.classList.contains('layout-primary-only'),
        stripRendered: Number(utility.getBoundingClientRect().height.toFixed(3)),
        expandedScroll: displayControl.scrollHeight,
        expandedRect: Number(expandedRect.toFixed(3)),
        collapsedLauncherScroll: collapsedHeight,
        radioRect: Number(radioControl.getBoundingClientRect().height.toFixed(3)),
        expandedMaxVar: hud.style.getPropertyValue('--cockpit-utility-expanded-max-height'),
        topVar: hud.style.getPropertyValue('--cockpit-utility-top'),
        maxVar: hud.style.getPropertyValue('--cockpit-utility-max-height'),
        signalTop: Number(signal.getBoundingClientRect().top.toFixed(3)),
        recBottom: rec ? Number(rec.getBoundingClientRect().bottom.toFixed(3)) : null,
      });
    };
    // The boundary is only meaningful when approached from the TWO-control
    // composition. The anchor is solved against the strip's currently RENDERED
    // height, so arriving here already collapsed to primary-only makes the strip
    // short, pushes the resolved top above minTop, and the "exact" corridor is
    // then never evaluated at the boundary at all — the check would fail while
    // production is behaving correctly.
    //
    // The fixed `height: 150px` card seed above used to guarantee that; it stopped
    // once Display grew (the 3D Proximity/All row ships open from 2026-08-22, +36 px),
    // because 150 px of card leaves a corridor sized for the OLD strip. Seed from
    // the measured requirement instead, which holds for any future panel height,
    // and assert the precondition rather than assuming it.
    const roomySeed = moveSignalTopTo(exactSignalTop + 80);
    sample('roomy');
    const roomySeedExpanded = !utility.classList.contains('layout-primary-only')
      && roomySeed.firstPassPrimaryOnly === false;
    const exact = {
      ...moveSignalTopTo(exactSignalTop),
      utilityTop: hud.style.getPropertyValue('--cockpit-utility-top'),
      primaryOnly: utility.classList.contains('layout-primary-only'),
      siblingVisible: getComputedStyle(radioControl).display !== 'none',
      siblingAriaHidden: radioControl.getAttribute('aria-hidden'),
    };
    sample('exact');
    radio.focus({ preventScroll: true });
    const constrained = {
      // The minTop-anchored regime one pixel below its own flip point (see the
      // constrainedSignalTop derivation): available = budget − 1, so the
      // strict `>` must resolve primary-only on the first pass.
      ...moveSignalTopTo(constrainedSignalTop),
      utilityTop: hud.style.getPropertyValue('--cockpit-utility-top'),
      primaryOnly: utility.classList.contains('layout-primary-only'),
      siblingDisplay: getComputedStyle(radioControl).display,
      siblingRect: radioControl.getBoundingClientRect().toJSON(),
      siblingAriaHidden: radioControl.getAttribute('aria-hidden'),
      focusReturned: document.activeElement === display,
      contained: displayControl.getBoundingClientRect().bottom
        <= signal.getBoundingClientRect().top - 7,
    };
    sample('constrained');
    const restored = {
      // exactSignalTop is anchor-based (see above), so +140 here is a plain
      // re-widen well inside the fit — the sibling must come back regardless
      // of which anchor (minTop or REC) governed the solve.
      ...moveSignalTopTo(exactSignalTop + 140),
      utilityTop: hud.style.getPropertyValue('--cockpit-utility-top'),
      primaryOnly: utility.classList.contains('layout-primary-only'),
      siblingVisible: getComputedStyle(radioControl).display !== 'none',
      siblingAriaHidden: radioControl.getAttribute('aria-hidden'),
    };
    sample('restored');
    cardChildren.forEach((child, index) => {
      child.style.display = priorChildDisplays[index];
    });
    if (recReadout) recReadout.style.display = priorRecDisplay;
    signal.style.padding = priorBoxChrome.padding;
    signal.style.borderWidth = priorBoxChrome.borderWidth;
    signal.style.minHeight = priorBoxChrome.minHeight;
    signal.style.maxHeight = priorSignalMaxHeight;
    signal.style.height = priorSignalHeight;
    manager.cockpitView.syncSignalLayout();
    return {
      minTop,
      budget,
      stripRendered: Number(stripRendered.toFixed(3)),
      exactSignalTop,
      constrainedSignalTop,
      roomySeedExpanded,
      bottomOffsetPx,
      maxCardTop,
      seededTop: Number(seededRect.top.toFixed(3)),
      seededHeight: Number(seededRect.height.toFixed(3)),
      samples,
      exact,
      constrained,
      restored,
    };
  });
  check(
    'exact fit keeps the sibling; one-pixel constraint hides it, transfers focus, and restores it',
    boundary.roomySeedExpanded
      && !boundary.exact.primaryOnly
      && boundary.exact.siblingVisible
      && boundary.exact.siblingAriaHidden === 'false'
      && boundary.constrained.primaryOnly
      && boundary.constrained.siblingDisplay === 'none'
      && boundary.constrained.siblingRect.width === 0
      && boundary.constrained.siblingAriaHidden === 'true'
      && boundary.constrained.focusReturned
      && boundary.constrained.contained
      && !boundary.restored.primaryOnly
      && boundary.restored.siblingVisible
      && boundary.restored.siblingAriaHidden === 'false',
    JSON.stringify(boundary),
  );
  check(
    'each corridor change is decided by the first layout pass, not a repeated one',
    boundary.exact.idempotent
      && boundary.restored.idempotent
      && boundary.constrained.firstPassPrimaryOnly,
    JSON.stringify({
      exact: { first: boundary.exact.firstPassTop, idempotent: boundary.exact.idempotent },
      constrained: {
        first: boundary.constrained.firstPassTop,
        firstPassPrimaryOnly: boundary.constrained.firstPassPrimaryOnly,
      },
      restored: { first: boundary.restored.firstPassTop, idempotent: boundary.restored.idempotent },
    }),
  );

  await ensureCockpitSession();
  const signalTransition = await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    const cockpit = manager.cockpitView;
    const signalToggle = document.getElementById('cockpit-signal-toggle');
    let expandedEvents = 0;
    const onExpanded = () => { expandedEvents += 1; };
    cockpit.signalUserCollapsed = false;
    manager._setCockpitDisclosure('display', false);
    manager._setCockpitDisclosure('radio', false);
    cockpit.setSignalCollapsed(true);
    window.addEventListener('gev:cockpit-signal-expanded', onExpanded);
    try {
      cockpit.setSignalCollapsed(false);
      const afterExpansion = expandedEvents;
      cockpit.setSignalCollapsed(false);
      const afterRepeatedExpansion = expandedEvents;

      manager._setCockpitDisclosure('display', true);
      const displayCollapsedSignals = cockpit.signalCollapsed;
      manager._setCockpitDisclosure('display', false);
      const afterUtilityClose = expandedEvents;
      const utilityCloseReopenedSignals = !cockpit.signalCollapsed;

      cockpit.setSignalCollapsed(true, { user: true });
      manager._setCockpitDisclosure('radio', true);
      manager._setCockpitDisclosure('radio', false);
      const manualCollapseRetained = cockpit.signalCollapsed && cockpit.signalUserCollapsed;
      return {
        afterExpansion,
        afterRepeatedExpansion,
        afterUtilityClose,
        displayCollapsedSignals,
        utilityCloseReopenedSignals,
        manualCollapseRetained,
        signalAriaExpanded: signalToggle?.getAttribute('aria-expanded'),
      };
    } finally {
      window.removeEventListener('gev:cockpit-signal-expanded', onExpanded);
      cockpit.signalUserCollapsed = false;
      cockpit.setSignalCollapsed(false);
    }
  });
  check(
    'Live Signals expansion is edge-triggered and manual collapse remains authoritative',
    signalTransition.afterExpansion === 1
      && signalTransition.afterRepeatedExpansion === 1
      && signalTransition.afterUtilityClose === 2
      && signalTransition.displayCollapsedSignals
      && signalTransition.utilityCloseReopenedSignals
      && signalTransition.manualCollapseRetained
      && signalTransition.signalAriaExpanded === 'false',
    JSON.stringify(signalTransition),
  );
  await ensureCockpitSession();
  const contextTransition = await page.evaluate(() => {
    const cockpit = window.__godsEyeView.styleManager.cockpitView;
    const priorCollapsed = cockpit.contextCollapsed;
    const contextToggle = document.getElementById('cockpit-context-toggle');
    let expandedEvents = 0;
    const onExpanded = () => { expandedEvents += 1; };
    cockpit.setContextCollapsed(true);
    window.addEventListener('gev:cockpit-context-expanded', onExpanded);
    try {
      cockpit.setContextCollapsed(false);
      const afterExpansion = expandedEvents;
      cockpit.setContextCollapsed(false);
      return {
        afterExpansion,
        afterRepeatedExpansion: expandedEvents,
        ariaExpanded: contextToggle?.getAttribute('aria-expanded'),
        label: contextToggle?.getAttribute('aria-label'),
      };
    } finally {
      window.removeEventListener('gev:cockpit-context-expanded', onExpanded);
      cockpit.setContextCollapsed(priorCollapsed);
    }
  });
  check(
    'Contact expansion is edge-triggered and retains its disclosure semantics',
    contextTransition.afterExpansion === 1
      && contextTransition.afterRepeatedExpansion === 1
      && contextTransition.ariaExpanded === 'true'
      && contextTransition.label === 'Collapse Contact panel',
    JSON.stringify(contextTransition),
  );
  await page.screenshot({ path: path.join(shotsDir, 'restored-desktop.png') });
  check(
    'restored screenshot remains in a real Cockpit session',
    await page.evaluate(() => document.body.classList.contains('cockpit-mode')
      && window.__godsEyeView.styleManager.cockpitView.active
      && getComputedStyle(document.getElementById('cockpit-utility-controls')).display !== 'none'),
  );
  await ensureCockpitSession();
  const desktopViewActions = await page.evaluate(() => {
    const reset = document.getElementById('cockpit-reset-globe')?.getBoundingClientRect();
    const exit = document.getElementById('map-view-switch')?.getBoundingClientRect();
    return {
      reset: reset?.toJSON() || null,
      exit: exit?.toJSON() || null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  check(
    'desktop Cockpit Reset and Exit remain readable without overlap',
    desktopViewActions.reset?.width > 44
      && desktopViewActions.exit?.width > 70
      && desktopViewActions.reset.right <= desktopViewActions.exit.left
      && desktopViewActions.reset.left >= 0
      && desktopViewActions.exit.right <= desktopViewActions.viewport.width,
    JSON.stringify(desktopViewActions),
  );

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await ensureCockpitSession();
  const mobile = await page.evaluate(async () => {
    const manager = window.__godsEyeView.styleManager;
    const hud = document.getElementById('cockpit-hud');
    const signal = document.getElementById('cockpit-signal-stream');
    const display = document.getElementById('cockpit-display-toggle-btn');
    const radio = document.getElementById('cockpit-radio-toggle-btn');
    const displayControl = display.closest('.cockpit-utility-control');
    const radioControl = radio.closest('.cockpit-utility-control');
    document.body.classList.add('cockpit-mode');
    manager.cockpitView.active = true;
    hud.hidden = false;
    signal.hidden = false;
    manager._setCockpitDisclosure('display', false);
    manager._setCockpitDisclosure('radio', false);
    manager.cockpitView.syncSignalLayout();
    const collapsed = {
      display: displayControl.getBoundingClientRect().toJSON(),
      radio: radioControl.getBoundingClientRect().toJSON(),
    };
    display.click();
    manager.cockpitView.syncSignalLayout();
    return {
      collapsed,
      expandedDisplay: displayControl.getBoundingClientRect().toJSON(),
      radioDisplay: getComputedStyle(radioControl).display,
      radioAriaHidden: radioControl.getAttribute('aria-hidden'),
    };
  });
  check(
    'mobile keeps both collapsed launchers and the existing fixed expanded behavior',
    mobile.collapsed.display.width > 0
      && mobile.collapsed.radio.width > 0
      && mobile.expandedDisplay.width > 0
      && mobile.expandedDisplay.width <= 366
      && mobile.radioDisplay === 'none'
      && mobile.radioAriaHidden === 'true',
    JSON.stringify(mobile),
  );
  await page.screenshot({ path: path.join(shotsDir, 'mobile.png') });
  check(
    'mobile screenshot remains in a real Cockpit session',
    await page.evaluate(() => document.body.classList.contains('cockpit-mode')
      && window.__godsEyeView.styleManager.cockpitView.active
      && getComputedStyle(document.getElementById('cockpit-utility-controls')).display !== 'none'),
  );
  await ensureCockpitSession();
  const narrowViewActions = await page.evaluate(() => {
    const reset = document.getElementById('cockpit-reset-globe')?.getBoundingClientRect();
    const exit = document.getElementById('map-view-switch')?.getBoundingClientRect();
    return {
      reset: reset?.toJSON() || null,
      exit: exit?.toJSON() || null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  check(
    'narrow Cockpit Reset and Exit remain readable without overlap',
    narrowViewActions.reset?.width > 44
      && narrowViewActions.exit?.width > 70
      && narrowViewActions.reset.right <= narrowViewActions.exit.left
      && narrowViewActions.reset.left >= 0
      && narrowViewActions.exit.right <= narrowViewActions.viewport.width,
    JSON.stringify(narrowViewActions),
  );

  await ensureCockpitSession();
  const resetResult = await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    const awareness = window.__godsEyeView.dataManager.layers.get('military-awareness')?.module;
    window.__qaCockpitReset = {
      calls: 0,
      original: manager.resetToGlobeView,
      subjectId: awareness?.getContextSnapshot?.()?.subject?.id || null,
    };
    manager.resetToGlobeView = function qaCountedCockpitReset(...args) {
      window.__qaCockpitReset.calls += 1;
      return window.__qaCockpitReset.original.apply(this, args);
    };
    return Boolean(document.getElementById('cockpit-reset-globe'));
  });
  check('Cockpit Reset is present before keyboard activation', resetResult);
  await page.focus('#cockpit-reset-globe');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => !window.__godsEyeView.styleManager.cockpitView.active,
    { timeout: 6_000 },
  );
  await page.waitForFunction(() => {
    const viewer = window.__godsEyeView.viewer;
    if (!viewer) return false;
    const height = viewer.camera.positionCartographic?.height;
    return Math.abs(height - 18_000_000) < 150_000;
  }, { timeout: 6_000 });
  // Sample in the EXITED state — the check's contract is about what reset
  // itself did (one route, cockpit exit, globe restore, hidden chrome). The
  // subject-preservation probe reads the Contact selection, which the next
  // check's own ensureCockpitSession() re-entry re-engages; sampling after a
  // re-entry would invert every one of those assertions (cockpitActive true,
  // reset visible again, follow camera at 7 km).
  const resetState = await page.evaluate(() => {
    const gev = window.__godsEyeView;
    const qa = window.__qaCockpitReset;
    const awareness = gev.dataManager.layers.get('military-awareness')?.module;
    const subjectId = awareness?.getContextSnapshot?.()?.subject?.id || null;
    const height = gev.viewer.camera.positionCartographic?.height;
    // Live-feed attrition can retire the Contact between capture and here;
    // identity preservation is only assertable while the original Contact
    // still exists in the feed. Presence comes from the owning layer's O(1)
    // `hasContact` (the same probe awareness itself uses), across every
    // Contact-capable source; null means no layer could answer.
    const listed = ['flights', 'military', 'ais-live-vessels'].map((layerId) => {
      const module = gev.dataManager.layers.get(layerId)?.module;
      return typeof module?.hasContact === 'function' ? module.hasContact(qa.subjectId) : null;
    });
    const originalStillListed = qa.subjectId
      ? (listed.includes(true) ? true : (listed.includes(false) ? false : null))
      : null;
    gev.styleManager.resetToGlobeView = qa.original;
    delete window.__qaCockpitReset;
    return {
      calls: qa.calls,
      cockpitActive: gev.styleManager.cockpitView.active,
      trackedEntity: Boolean(gev.viewer.trackedEntity),
      resetHidden: document.getElementById('cockpit-reset-globe')?.hidden,
      height,
      subjectBefore: qa.subjectId,
      subjectAfter: subjectId,
      originalStillListed,
      subjectPreserved: Boolean(qa.subjectId && subjectId === qa.subjectId),
      subjectAttrited: originalStillListed === false,
    };
  });
  // Reset's own contract (one route, exit, globe restore, hidden chrome) is
  // absolute. Contact identity is asserted while the original Contact is
  // still in the live feed; when attrition retired it, a changed id is the
  // feed's doing, not the reset's — but the swap is still surfaced so the
  // run log shows it. `originalStillListed === null` (no layer could answer)
  // conservatively requires identity, same as presence.
  const contactIdentityHeld = resetState.subjectPreserved
    || resetState.originalStillListed === false;
  check(
    'keyboard Cockpit Reset uses one canonical route and preserves Contact selection',
    resetState.calls === 1
      && !resetState.cockpitActive
      && !resetState.trackedEntity
      && resetState.resetHidden
      && Math.abs(resetState.height - 18_000_000) < 150_000
      && contactIdentityHeld,
    JSON.stringify(resetState),
  );
  if (!resetState.subjectPreserved) {
    console.log(`WARN contact selection swapped by live-feed attrition during Cockpit Reset: ${resetState.subjectBefore} -> ${resetState.subjectAfter}`);
  }
  // Keyless deployments answer their own google/openai endpoints with the
  // honest 503 "not set" contract (the same allowance the L9 matrix's C3
  // makes). Probing keeps the assertion about UNEXPECTED console dirt.
  let keylessServer = false;
  try {
    const keylessProbe = await fetch(`${appUrl}/api/google/nearby-places?lat=30.2672&lon=-97.7431`);
    keylessServer = keylessProbe.status === 503 && /not set/i.test(await keylessProbe.text());
  } catch { /* keyed or unreachable — treat as keyed */ }
  const KEYLESS_PATH = /^\/api\/(google\/(?:nearby-places|text-search)|openai\/hud-summary|realtime\/token|firms)$/;
  // Chrome logs every non-2xx subresource as "Failed to load resource: …
  // (status) [origin/path]" — map those texts back to their endpoint so the
  // same tolerance applies to both record shapes. Bracket handling matters:
  // an IPv6-literal base URL (http://[::1]:4173) puts ']' inside the URL, so
  // the capture runs from the FIRST wrapper bracket to end-of-line and the
  // single trailing wrapper bracket is stripped afterwards — a no-brackets
  // class would truncate the URL at '::1' and strand keyless 503s as dirt.
  const CONSOLE_RESOURCE_TEXT = /Failed to load resource: the server responded with a status of (\d+)\b[^[]*\[(.+)/;
  const stripWrapperBracket = (target) => (target.endsWith(']') ? target.slice(0, -1) : target);
  // Records keep the full request target (path + query) so details identify
  // the exact request the page made.
  const parseEntry = (entry) => {
    const match = /^(\d+) (.+)$/.exec(entry);
    if (!match) return null;
    try {
      const url = new URL(match[2], appUrl);
      return { status: Number(match[1]), path: url.pathname, target: `${url.pathname}${url.search}` };
    } catch {
      return null;
    }
  };
  const consoleResourcePath = (text) => {
    const match = CONSOLE_RESOURCE_TEXT.exec(text);
    return match ? parseEntry(`${match[1]} ${stripWrapperBracket(match[2])}`) : null;
  };
  const keylessLocal = (entry) => {
    const parsed = entry.startsWith('503 ') ? parseEntry(entry) : null;
    return Boolean(parsed) && keylessServer && KEYLESS_PATH.test(parsed.path);
  };
  const keylessConsole = (text) => {
    const resource = consoleResourcePath(text);
    return Boolean(resource) && keylessServer && resource.status === 503 && KEYLESS_PATH.test(resource.path);
  };
  const survivors = {
    local: localHttpErrors.filter((entry) => !keylessLocal(entry)),
    console: consoleErrors.filter((text) => !keylessConsole(text)),
  };
  // Server-owned statuses are environmental, full stop: 5xx means the
  // upstream or the proxy failed (replaying from Node proves nothing —
  // /api/terrain/heights 502s come and go within seconds), and 429/420
  // (adsb.lol throttles with 420) mean this harness's own polling exhausted
  // a shared budget. A page cannot fabricate either. Deterministic middleware
  // regressions are the L9 matrix's direct API checks' job, not this page
  // dirt check's. Everything else (4xx) stays a failure.
  const isEnvironmentStatus = (status) => status >= 500 || status === 429 || status === 420;
  const isEnvironmentLocal = (entry) => {
    const parsed = parseEntry(entry);
    return Boolean(parsed) && parsed.target.startsWith('/api/') && isEnvironmentStatus(parsed.status);
  };
  const cleanLocalErrors = survivors.local.filter((entry) => !isEnvironmentLocal(entry));
  const cleanConsoleErrors = survivors.console.filter((text) => {
    const resource = consoleResourcePath(text);
    return !resource || !(resource.target.startsWith('/api/') && isEnvironmentStatus(resource.status));
  });
  const toleratedCount = (localHttpErrors.length - cleanLocalErrors.length)
    + (consoleErrors.length - cleanConsoleErrors.length);
  if (toleratedCount > 0) {
    console.log(`INFO environment responses tolerated: ${toleratedCount} (keyless 503 contract / server-owned 5xx+429+420)`);
  }
  check('runtime console remains clean', cleanConsoleErrors.length === 0 && cleanLocalErrors.length === 0,
    [...cleanLocalErrors, ...cleanConsoleErrors].slice(0, 6).join(' | '));
} finally {
  await page.evaluate(() => {
    const manager = window.__godsEyeView?.styleManager;
    const prior = window.__qaCockpitUtilityPrior;
    if (!manager || !prior) return;
    manager._setCockpitDisclosure('display', false);
    manager._setCockpitDisclosure('radio', false);
    if (manager.cockpitView.active && !prior.active) manager.cockpitView.exit();
    else manager.cockpitView.active = prior.active;
    const hud = document.getElementById('cockpit-hud');
    const signal = document.getElementById('cockpit-signal-stream');
    hud.hidden = prior.hudHidden;
    signal.hidden = prior.signalHidden;
    manager._setHudVariant(prior.hudVariant);
    manager.hud.setMode(prior.hudVisible ? 'on' : 'off');
    if (prior.utilityTop) hud.style.setProperty('--cockpit-utility-top', prior.utilityTop);
    else hud.style.removeProperty('--cockpit-utility-top');
    if (!prior.cockpit) document.body.classList.remove('cockpit-mode');
  }).catch(() => {});
  await browser.close();
}

console.log(`RESULT: ${failures.length ? 'NOT_READY' : 'READY'} (${failures.length} failures)`);
process.exitCode = failures.length ? 1 : 0;
