import {
  getScopeMaskFeather,
  getScopeMaskOpacity,
  isScopeMaskEnabled,
  setScopeMaskEnabled,
  setScopeMaskFeather,
  setScopeMaskOpacity,
} from '../scopeMask.js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  HUD_LAYOUTS,
  isLegacySonarHudLayout,
  LEGACY_SONAR_HUD_LAYOUTS,
  normalizeHudLayout,
} from '../hudLayouts.js';
import {
  isCyberMapThemeActive,
  isCyberSonarActive,
  isCyberSonarEnabled,
  setCyberSonarEnabled,
} from '../cyberSonar.js';
import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { StyleManager } from './applicationShell.js';
import { setCyberSonarControls } from './cyberSonarControls.js';
import { createPinia } from 'pinia';
import { useDisplayStore } from './stores/display.js';
import { VisualSettings } from './visualSettings.js';
import { normalizeShot } from '../scenes/project.js';
import {
  SCENE_DOCUMENT_VERSION,
  validateSceneDocument,
} from '../director/document.js';
import { decodeShareView, encodeShareView } from '../share/viewCodec.js';
import { toLegacyShareState } from '../share/legacyShareState.js';
import { STYLES } from './visualPresets.js';

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

function cssRuleBody(styles, selector) {
  const match = styles.match(new RegExp(`${selector.source}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector.source}`);
  return match[1];
}

function styleOwner(t, initialVariant = 'tactical') {
  const previous = { document: globalThis.document, window: globalThis.window };
  const root = { dataset: {} };
  globalThis.document = { documentElement: root, querySelectorAll: () => [] };
  globalThis.window = { dispatchEvent() {} };
  t.after(() => Object.assign(globalThis, previous));
  let variant = initialVariant;
  const calls = [];
  const hud = {
    getVariant: () => variant,
    // Normalize like the real HUD so removed layouts fall back.
    setVariant: (value) => (variant = normalizeHudLayout(value)),
    setMode: (value) => calls.push(['mode', value]),
    onStyleChange: (value) => calls.push(['style', value]),
    visible: true,
  };
  hud.setVariant(initialVariant);
  const owner = Object.create(VisualSettings.prototype);
  Object.assign(owner, {
    activeStyle: 'normal',
    store: { publish() {} },
    readHud: () => hud,
    readShareLinks: () => ({ onStyleChange() {} }),
    _visualEffects: {
      stages: Object.fromEntries(
        Object.entries(STYLES).map(([name, config]) => [
          name,
          { uniforms: { ...config.uniforms, intensity: 0 } },
        ]),
      ),
    },
    services: {
      governorRequestRender: (reason) => calls.push(['render', reason]),
      setDetectionStyle() {},
    },
    _setBloomEnabled: (value) => calls.push(['bloom', value]),
    _setSharpenEnabled: (value) => calls.push(['sharpen', value]),
    _applyDetectionPreset: (value) => calls.push(['detection', value]),
    _syncShareState: () => calls.push(['share', variant]),
  });
  for (const name of [
    'setCelestialRingEnabled',
    '_startTransition',
    '_publishActiveStyle',
    '_updateSliderPanel',
    '_updateHudButtonState',
    '_syncIrBoost',
    '_syncCockpitInheritedStyle',
    '_syncCyberSonarControl',
    '_scheduleAdaptivePanelLayout',
    '_setDetectionFade',
    // Intensities: the fixture has no post-process stages to drive.
    '_setBloomIntensity',
    '_setSharpenIntensity',
  ])
    owner[name] = () => {};
  return { owner, hud, root, calls };
}

test('Tactical and Minimal are the HUD layouts; Cyber is only a Sonar alias', () => {
  assert.deepEqual(HUD_LAYOUTS, ['tactical', 'minimal']);
  assert.deepEqual(LEGACY_SONAR_HUD_LAYOUTS, ['cyber']);
  assert.equal(normalizeHudLayout('cyber'), 'tactical');
  assert.equal(normalizeHudLayout('CYBER'), 'tactical');
  assert.equal(normalizeHudLayout('operator'), 'tactical');
  assert.equal(normalizeHudLayout('Minimal'), 'minimal');
  assert.equal(isLegacySonarHudLayout('Cyber'), true);
  assert.equal(isLegacySonarHudLayout('operator'), false);
  assert.equal(isLegacySonarHudLayout('tactical'), false);
});

test('a share link, scene or saved view naming Cyber opens Tactical with Sonar on', async (t) => {
  const { owner, hud, root, calls } = styleOwner(t, 'minimal');
  assert.equal(isCyberSonarEnabled(root), false);
  await owner.restoreShareState({ hudVariant: 'cyber' });
  assert.equal(hud.getVariant(), 'tactical');
  assert.equal(root.dataset.cyberSonar, 'on');
  assert.equal(root.dataset.uiTheme, undefined);
  // Turning it on asks for a frame, so a parked map starts the sweep.
  assert.ok(
    calls.some(
      ([name, reason]) => name === 'render' && reason === 'cyber-sonar-toggle',
    ),
  );
  // The viewer's own layout choice afterwards leaves the Sonar style alone.
  owner._setHudVariant('minimal');
  assert.equal(hud.getVariant(), 'minimal');
  assert.equal(isCyberSonarEnabled(root), true);
  // A restored state is authoritative: one that does not name Cyber turns
  // Sonar off, whether from a link or a scene shot.
  await owner.restoreShareState({ hudVariant: 'tactical' });
  assert.equal(isCyberSonarEnabled(root), false);
  setCyberSonarEnabled(true, root);
  await owner.applyVisualState({ hud: { variant: 'minimal' } });
  assert.equal(hud.getVariant(), 'minimal');
  assert.equal(isCyberSonarEnabled(root), false);
  await owner.applyVisualState({ hud: { variant: 'cyber' } });
  assert.equal(hud.getVariant(), 'tactical');
  assert.equal(isCyberSonarEnabled(root), true);
});

/** A styleOwner that can also read its share state and scene shot. */
function sharingOwner(t, initialVariant) {
  const fixture = styleOwner(t, initialVariant);
  Object.assign(fixture.owner.services, {
    getDetectionTuning: () => ({ allocationStrategy: 'ELASTIC' }),
    getDetectionMode: () => 'OFF',
    isScopeMaskEnabled: () => true,
    getScopeMaskFeather: () => 1,
    getScopeMaskOpacity: () => 1,
    getScopeTerminusOverride: () => null,
  });
  fixture.owner.readCelestialRing = () => null;
  return fixture;
}

test('links and scene shots record Tactical with Sonar as the Cyber code, and only that', (t) => {
  const { owner, root } = sharingOwner(t, 'tactical');
  const shared = () => {
    const { hudVariant, hudSonar } = owner._readShareState().options;
    return [hudVariant, hudSonar];
  };
  const shot = () => owner.getVisualState().hud;
  assert.deepEqual(shared(), ['tactical', false]);
  assert.deepEqual(shot(), { visible: true, variant: 'tactical' });
  owner._setCyberSonarEnabled(true);
  // Tactical with Sonar is the Cyber code alone, as older readers expect.
  assert.deepEqual(shared(), ['cyber', false]);
  assert.deepEqual(shot(), { visible: true, variant: 'cyber' });
  // Minimal has no such code, so Sonar is carried beside it.
  owner._setHudVariant('minimal');
  assert.deepEqual(shared(), ['minimal', true]);
  assert.deepEqual(shot(), { visible: true, variant: 'minimal', sonar: true });
  owner._setCyberSonarEnabled(false);
  assert.deepEqual(shared(), ['minimal', false]);
  assert.deepEqual(shot(), { visible: true, variant: 'minimal' });
  owner._setHudVariant('tactical');
  assert.deepEqual(shared(), ['tactical', false]);
  assert.equal(isCyberSonarEnabled(root), false);
});

test('Minimal with Sonar round-trips through a compact link and a scene shot', async (t) => {
  const { owner, hud, root } = sharingOwner(t, 'minimal');
  owner._setCyberSonarEnabled(true);
  const options = owner._readShareState().options;
  const shot = normalizeShot(
    JSON.parse(JSON.stringify({ visual: owner.getVisualState() })),
  );
  validateSceneDocument({
    version: SCENE_DOCUMENT_VERSION,
    scenes: [{ id: 'scene', title: 'Scene', shots: [shot] }],
  });
  const code = encodeShareView({
    hudVariant: options.hudVariant,
    hudSonar: options.hudSonar,
  });
  const link = decodeShareView(code, { nowMs: Date.now() }).state;

  // The viewer is elsewhere: Tactical, Sonar off.
  owner._setHudVariant('tactical');
  owner._setCyberSonarEnabled(false);
  // The HUD fields of the parsed link (the fixture drives no detection).
  const { hudVariant, hudSonar } = toLegacyShareState(link);
  assert.deepEqual([hudVariant, hudSonar], ['minimal', true]);
  await owner.restoreShareState({ hudVariant, hudSonar });
  assert.equal(hud.getVariant(), 'minimal');
  assert.equal(isCyberSonarEnabled(root), true);

  owner._setHudVariant('tactical');
  owner._setCyberSonarEnabled(false);
  // The saved shot's HUD, as the editor normalized and validated it.
  assert.deepEqual(shot.visual.hud, {
    visible: true,
    variant: 'minimal',
    sonar: true,
  });
  await owner.applyVisualState({ hud: shot.visual.hud });
  assert.equal(hud.getVariant(), 'minimal');
  assert.equal(isCyberSonarEnabled(root), true);
});

test('a link or scene shot that does not mention Sonar restores as before', async (t) => {
  const { owner, hud, root } = sharingOwner(t, 'minimal');
  // Made before Sonar was carried: Minimal turns the viewer's Sonar off...
  setCyberSonarEnabled(true, root);
  await owner.restoreShareState({ hudVariant: 'minimal' });
  assert.equal(isCyberSonarEnabled(root), false);
  setCyberSonarEnabled(true, root);
  await owner.applyVisualState({ hud: { variant: 'minimal' } });
  assert.equal(isCyberSonarEnabled(root), false);
  // ...and Cyber still opens Tactical with Sonar on.
  await owner.restoreShareState({ hudVariant: 'cyber', hudSonar: false });
  assert.equal(hud.getVariant(), 'tactical');
  assert.equal(isCyberSonarEnabled(root), true);
  owner._setCyberSonarEnabled(false);
  await owner.applyVisualState({ hud: { variant: 'cyber' } });
  assert.equal(isCyberSonarEnabled(root), true);
  // Sonar beside a layout counts only in a restore, not a layout choice.
  owner._setCyberSonarEnabled(false);
  owner._setHudVariant('minimal', { sonar: true });
  assert.equal(isCyberSonarEnabled(root), false);
});

test('Sonar is opt-in and gated on its toggle, the HUD, Cockpit and motion, not a theme', () => {
  const classes = new Set();
  const root = { dataset: {} };
  const body = { classList: { contains: (name) => classes.has(name) } };
  const gate = (extra = {}) => ({
    root,
    body,
    hudActive: true,
    reducedMotion: false,
    ...extra,
  });
  assert.equal(isCyberSonarEnabled(root), false);
  assert.equal(isCyberSonarActive(gate()), false);
  assert.equal(isCyberMapThemeActive(gate()), false);
  // The removed Cyber theme attribute no longer enables anything.
  root.dataset.uiTheme = 'cyber';
  assert.equal(isCyberSonarActive(gate()), false);
  delete root.dataset.uiTheme;

  assert.equal(setCyberSonarEnabled(true, root), true);
  assert.equal(root.dataset.cyberSonar, 'on');
  assert.equal(isCyberSonarActive(gate()), true);
  assert.equal(isCyberMapThemeActive(gate()), true);
  assert.equal(isCyberSonarActive(gate({ hudActive: false })), false);
  assert.equal(isCyberMapThemeActive(gate({ hudActive: false })), false);
  // Reduced motion keeps the static treatment and stops the sweep.
  assert.equal(isCyberSonarActive(gate({ reducedMotion: true })), false);
  assert.equal(isCyberMapThemeActive(gate({ reducedMotion: true })), true);
  classes.add('cockpit-mode');
  assert.equal(isCyberSonarActive(gate()), false);
  assert.equal(isCyberMapThemeActive(gate()), false);
  classes.delete('cockpit-mode');

  assert.equal(setCyberSonarEnabled(false, root), false);
  assert.equal(root.dataset.cyberSonar, 'off');
  assert.equal(isCyberSonarActive(gate()), false);
  assert.equal(isCyberMapThemeActive(gate()), false);
});

test('Sonar controls apply under Tactical and Minimal and still validate input', () => {
  for (const layout of ['tactical', 'minimal']) {
    const root = { dataset: {} };
    const doc = {
      documentElement: root,
      body: { classList: { contains: () => false } },
      getElementById: () => null,
    };
    const calls = [];
    const owner = {
      hud: { getVariant: () => layout, visible: true },
      _setCyberSonarSetting: (name, value) => calls.push([name, value]),
      _setCyberSonarEnabled: (value) => {
        calls.push(['enabled', value]);
        setCyberSonarEnabled(value, root);
      },
    };
    const applied = setCyberSonarControls(
      owner,
      { enabled: true, rings: 6, sectorDeg: 30 },
      doc,
    );
    assert.equal(applied.ok, true, layout);
    assert.equal(applied.sonar.enabled, true);
    assert.equal('cyberSelected' in applied.sonar, false);
    assert.deepEqual(calls, [
      ['rings', 6],
      ['sector', 30],
      ['enabled', true],
    ]);
    assert.equal(
      setCyberSonarControls(owner, { enabled: 'yes' }, doc).error,
      'enabled must be a boolean.',
    );
    assert.equal(
      setCyberSonarControls(owner, { pulse: 3 }, doc).error,
      'Unknown sonar setting.',
    );
    assert.equal(
      setCyberSonarControls(owner, { rings: 13 }, doc).error,
      'rings must be an integer from 3 to 12.',
    );
  }
});

test('Display and voice HUD routes offer Tactical and Minimal, and Cyber turns Sonar on', async (t) => {
  const makeOwner = () => {
    const { owner, hud, root } = styleOwner(t, 'tactical');
    owner.setStyle('noir');
    owner.setHudLayout = (...args) =>
      StyleManager.prototype.setHudLayout.call(owner, ...args);
    owner.getControlState = () => ({
      hud: { layout: hud.getVariant(), visible: true },
    });
    return { owner, hud, root };
  };

  const display = makeOwner();
  const store = useDisplayStore(createPinia());
  const token = store.connect({
    setHudLayout: (value) => display.owner.setHudLayout(value),
    setStyle: (value) => display.owner.setStyle(value),
  });
  store.act('setHudLayout', 'minimal');
  assert.equal(display.hud.getVariant(), 'minimal');
  // Switching layouts never changes the visual preset.
  assert.equal(display.owner.activeStyle, 'noir');
  store.act('setStyle', 'anime');
  assert.equal(display.owner.activeStyle, 'anime');
  store.detach(token);

  const setHud = GEV_ACTION_SCHEMAS.find((tool) => tool.name === 'set_hud');
  assert.deepEqual(setHud.parameters.properties.layout.enum, HUD_LAYOUTS);

  const voice = makeOwner();
  const eventSource = { addEventListener() {}, removeEventListener() {} };
  const viewer = {
    camera: { moveEnd: { addEventListener() {} } },
    clock: { onTick: { addEventListener: () => () => {} } },
    canvas: eventSource,
    scene: { canvas: eventSource },
  };
  const runVoiceAction = createGevActionRunner({
    viewer,
    styleManager: voice.owner,
    dataManager: {},
  });
  const minimal = await runVoiceAction('set_hud', { layout: 'minimal' });
  assert.equal(minimal.ok, true);
  assert.equal(voice.hud.getVariant(), 'minimal');
  assert.equal(isCyberSonarEnabled(voice.root), false);
  const legacy = await runVoiceAction('set_hud', { layout: 'cyber' });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.layout, 'tactical');
  assert.equal(voice.hud.getVariant(), 'tactical');
  assert.equal(isCyberSonarEnabled(voice.root), true);
  assert.equal(voice.owner.activeStyle, 'noir');
  const unknown = await runVoiceAction('set_hud', { layout: 'operator' });
  assert.equal(unknown.ok, false);
});

test('style presets keep their own HUD layout and never touch Sonar', (t) => {
  const { owner, hud, root } = styleOwner(t);
  setCyberSonarEnabled(true, root);
  for (const variant of ['tactical', 'minimal']) {
    owner._setHudVariant(variant);
    assert.equal(hud.getVariant(), variant);
    owner.setStyle('normal');
    owner.setStyle('surveillance');
    assert.equal(hud.getVariant(), 'tactical');
    assert.equal(isCyberSonarEnabled(root), true);
  }
});

test('the Display panel offers Sonar as an opt-in toggle under the HUD layout', () => {
  const view = read('./views/panels/DisplayPanel.vue');
  assert.doesNotMatch(view, /value="cyber"/);
  assert.match(view, /<option value="tactical">/);
  assert.match(view, /<option value="minimal">/);
  assert.match(
    view,
    /const sonarOn = computed\(\(\) => sonar\.value\?\.enabled \?\? false\);/,
  );
  // The toggle shows with the HUD; its sliders only once Sonar is on.
  assert.match(
    view,
    /cyber-sonar-toggle-row" :class="\{ visible: hud\?\.visible \}" id="cyber-sonar-row"/,
  );
  assert.equal(
    view.match(
      /cyber-sonar-setting" :class="\{ visible: hud\?\.visible && sonarOn \}"/g,
    )?.length,
    5,
  );
  assert.match(view, /:aria-label="t\('Sonar contact scanner'\)"/);
  // Its renderer status speaks only for a Sonar the viewer turned on.
  assert.match(
    view,
    /<output id="cyber-sonar-status"[^>]*:hidden="!\(hud\?\.visible && sonarOn\)"/,
  );
  assert.doesNotMatch(view, /t\('Cyber/);
});

test('stylesheets carry no Cyber theme and show the sweep only while Sonar is on', () => {
  const entry = readFileSync(
    new URL('../../style.css', import.meta.url),
    'utf8',
  );
  assert.match(entry, /@import '\.\/src\/ui\/styles\/sonar\.css';/);
  assert.doesNotMatch(entry, /cyber\.css/);
  const dir = new URL('./styles/', import.meta.url);
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.css')))
    assert.doesNotMatch(
      readFileSync(new URL(name, dir), 'utf8'),
      /data-ui-theme/,
      name,
    );

  const sonar = read('./styles/sonar.css');
  assert.match(cssRuleBody(sonar, /\n\.hud-sonar/), /display: none;/);
  assert.match(
    cssRuleBody(
      sonar,
      /\n:root\[data-cyber-sonar='on'\] #intel-hud \.hud-sonar/,
    ),
    /display: block;/,
  );
  // Cockpit and a hidden HUD keep no sweep, not even an invisible one.
  assert.match(
    cssRuleBody(
      sonar,
      /:root\[data-cyber-sonar='on'\] body\.cockpit-mode #intel-hud \.hud-sonar,\s*:root\[data-cyber-sonar='on'\] #intel-hud:not\(\.active\) \.hud-sonar/,
    ),
    /display: none;/,
  );
  assert.match(
    sonar,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\[data-cyber-sonar='on'\] #intel-hud \.hud-sonar::after\s*\{\s*display: none;\s*animation: none;/,
  );
  // The Vue bindings own the Sonar rows' visibility now.
  const controls = read('./styles/controls.css');
  assert.doesNotMatch(controls, /\.cyber-sonar-control\s*\{\s*display: none/);
  assert.doesNotMatch(controls, /data-cyber-sonar='off'/);
});

test('the desktop bottom row: credits on the Power Up baseline, the dock lifted, the corners level', () => {
  const rem = 16;
  const lift = 'var\\(--world-timeline-lift, 0px\\)';
  const value = (text, pattern) => {
    const match = text.match(pattern);
    assert.ok(match, pattern.source);
    return Number(match[1]);
  };
  const block = (text, header) => {
    const start = text.indexOf(header);
    assert.ok(start >= 0, header);
    let depth = 0;
    for (let i = text.indexOf('{', start); i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}' && --depth === 0)
        return text.slice(start, i + 1);
    }
    assert.fail(`unclosed ${header}`);
  };
  // Measured constants: the Power Up / language row is 32px tall, 14px up
  // and about 20rem wide in English; the attribution logo line is 28px; the
  // single-row dock is 62px; the bottom-right readout is one 26px line
  // taller than the coordinates.
  const POWER_UP = { bottom: 14, height: 32 };
  const CREDIT_HEIGHT = 28;
  const DOCK_HEIGHT = 62;
  const timeline = read('./styles/world-timeline.css');
  const timelineLift = value(
    timeline,
    /body:has\(#world-timeline\) \{\s*--world-timeline-lift: (\d+)px;/,
  );

  // From 1200px the dock and the World Timeline leave the bottom 74px; below
  // it they return to the bottom edge, where the dock spans the corners.
  const dock = read('./styles/command-dock.css');
  const dockFloor = value(
    dock,
    new RegExp(
      `\\n#command-dock \\{[^}]*bottom: calc\\((\\d+)px \\+ ${lift}\\)`,
    ),
  );
  assert.match(
    block(dock, '@media (max-width: 1199px)'),
    new RegExp(`#command-dock \\{\\s*bottom: calc\\(2vh \\+ ${lift}\\);`),
  );
  assert.equal(
    value(timeline, /\n#world-timeline \{[^}]*bottom: (\d+)px;/),
    dockFloor,
  );
  assert.match(
    block(timeline, '@media (max-width: 1199px)'),
    /#world-timeline \{\s*bottom: 2vh;/,
  );
  assert.ok(dockFloor >= POWER_UP.bottom + POWER_UP.height + 8);

  // Both credit renderers share Power Up's row, centred on it, below the
  // dock, and stop short of the corner row instead of running under it:
  // GEV's own line on its anchor, Cesium's on the absolutely placed box it
  // draws inside its empty anchor.
  const trays = read('./styles/command-dock-trays.css');
  const trayWide = block(trays, '@media (min-width: 1200px)');
  const caps = {
    'gev-credits': trays.match(
      /#gev-credits \{\s*right: auto;\s*bottom: ([\d.]+)rem;\s*left: 1\.5rem;\s*width: max-content !important;\s*max-width: calc\(100vw - 1\.5rem - ([\d.]+)rem\);\s*white-space: normal;/,
    ),
    'cesium-credits': (() => {
      const anchor = trays.match(
        /#cesium-credits \{\s*right: auto;\s*bottom: ([\d.]+)rem;\s*left: 1\.5rem;/,
      );
      // From 1200px, and in the Omnibar layout at every width: a long line
      // wraps rather than running under the corner row.
      const box = trayWide.match(
        /\n\s*#cesium-credits \.cesium-widget-credits \{\s*width: max-content;\s*max-width: calc\(100vw - 1\.5rem - ([\d.]+)rem\);\s*white-space: normal;/,
      );
      assert.match(
        trays,
        /:has\(#command-dock > #gev-voice-control\)\s*\)\s*#cesium-credits\s*\.cesium-widget-credits \{\s*width: max-content;\s*max-width: calc\(100vw - 1\.5rem - 26rem\);/,
      );
      return anchor && box && [null, anchor[1], box[1]];
    })(),
  };
  for (const [id, match] of Object.entries(caps)) {
    assert.ok(match, id);
    const creditsBottom = Number(match[1]) * rem;
    assert.equal(
      creditsBottom + CREDIT_HEIGHT / 2,
      POWER_UP.bottom + POWER_UP.height / 2,
    );
    assert.ok(creditsBottom + CREDIT_HEIGHT + 8 <= dockFloor);
    assert.ok(Number(match[2]) >= 20 + 1.5, `${id} leaves the corner row room`);
  }
  // Below 1200px the row returns above the bottom-edge dock, on one line.
  const narrow = block(trays, '@media (max-width: 1199px)');
  for (const id of ['cesium-credits', 'gev-credits'])
    assert.match(narrow, new RegExp(`#${id}[,\\s]`));
  assert.match(
    narrow,
    new RegExp(
      `\\{\\s*bottom: calc\\(2vh \\+ 5rem \\+ ${lift}\\);\\s*width: auto !important;\\s*max-width: calc\\(100vw - 3rem\\);\\s*white-space: nowrap;`,
    ),
  );
  // Right to left the corner row is at the bottom left, so the row moves
  // right, with the Minimal HUD too (its placement names #intel-hud).
  assert.match(
    trayWide,
    /html\[dir='rtl'\]\s*body:not\(\.context-docked\):not\(\.ui-clean-view\):not\(\.recording-mode\)\s*:is\(#cesium-credits, #gev-credits\),\s*html\[dir='rtl'\]\s*body:not\(\.context-docked\):not\(\.ui-clean-view\):not\(\.recording-mode\):has\(\s*#intel-hud\[data-variant='minimal'\]\.active\s*\)\s*:is\(#cesium-credits, #gev-credits\) \{\s*right: 1\.5rem;\s*left: auto;/,
  );
  // Its box hangs from the anchor's right edge there, and in the Omnibar
  // layout at every width; never in clean view or recording, where the
  // anchor stays on the left.
  assert.match(
    trayWide,
    /body:not\(\.context-docked\):not\(\.ui-clean-view\):not\(\.recording-mode\)\s*#cesium-credits\s*\.cesium-widget-credits \{\s*right: 0;\s*left: auto;/,
  );
  assert.match(
    trays,
    /html\[dir='rtl'\]\s*body:not\(\.mobile-shell\)[^{]*:not\(\.recording-mode\):not\(\.context-docked\)[^{]*#cesium-credits\s*\.cesium-widget-credits \{\s*right: 0;\s*left: auto;/,
  );
  // There the readout clears the row under it, however many lines it wraps
  // onto (--credit-line-height).
  assert.match(
    read('./styles/omnibar-dock.css'),
    /html\[dir='rtl'\] \*\):not\(\.context-docked\)\s*#intel-hud\[data-variant='tactical'\]\s*\.hud-bottom-right \{\s*bottom: max\(3\.375rem, var\(--omnibar-credits-clear\)\);/,
  );
  const locale = read('./styles/locale-picker.css');
  assert.match(locale, /#corner-actions \{[^}]*inset-inline-end: 0\.9rem;/);

  // From 1200px the readout keeps 8px above Power Up and the coordinates
  // start level with it. The World Timeline sits between the corners, so they
  // do not move while it shows.
  const split = read('./styles/rail-split.css');
  const wide = block(split, '@media (min-width: 1200px)');
  const readoutWide =
    value(
      wide,
      /\n  #intel-hud\[data-variant='tactical'\] \.hud-bottom-right \{\s*bottom: ([\d.]+)rem;/,
    ) * rem;
  assert.equal(readoutWide, POWER_UP.bottom + POWER_UP.height + 8);
  assert.equal(
    value(wide, /\.hud-bottom-left \{\s*bottom: calc\(([\d.]+)rem \+ 26px\);/) *
      rem,
    readoutWide,
  );
  assert.doesNotMatch(
    wide,
    /hud-bottom-(left|right) \{[^}]*world-timeline-lift/,
  );
  // Corners: coordinates ~302px from 36px, readout ~292px to 36px from the
  // right edge; the bar keeps 12px from each at every width from 1200px.
  const gutter =
    value(
      wide,
      /#world-timeline \{\s*width: min\(820px, calc\(100vw - ([\d.]+)rem\)\);/,
    ) * rem;
  assert.ok(gutter / 2 >= 36 + 302 + 12);
  assert.ok(timelineLift > 0);
  // Toasts keep 12px above the raised dock.
  assert.equal(
    value(
      wide,
      new RegExp(`#toast \\{\\s*bottom: calc\\((\\d+)px \\+ ${lift}\\);`),
    ),
    dockFloor + DOCK_HEIGHT + 12,
  );
  // The dock's panels lose the dock's rise from their height budgets.
  assert.match(
    wide,
    /\.gev-voice-panel \{[^}]*calc\(100dvh - 12rem - 74px \+ 2vh - var\(--gev-provider-lift, 0px\)\)/,
  );
  assert.match(
    block(read('./styles/ai-chat.css'), '@media (min-width: 1200px)'),
    /#gev-chat-panel \{\s*max-height: min\(34rem, calc\(100dvh - 10rem - 74px \+ 2vh\)\);/,
  );

  // Below 1200px the corners keep the committed layout: the coordinates clear
  // the raised credit row's logo line by 6px.
  assert.ok(
    value(
      trays.slice(
        trays.indexOf(
          '/* The coordinate readout shares the bottom-left corner',
        ),
      ),
      new RegExp(
        `\\.hud-bottom-left \\{\\s*bottom: calc\\(2vh \\+ ([\\d.]+)rem \\+ ${lift}\\);`,
      ),
    ) *
      rem >=
      5 * rem + CREDIT_HEIGHT + 6,
  );
  // The desktop Omnibar layout outranks these rules; its readout keeps the
  // same 8px above Power Up.
  const omnibarReadout = value(
    read('./styles/omnibar-dock.css'),
    /#intel-hud\[data-variant='tactical'\] \.hud-bottom-right \{\s*bottom: ([\d.]+)rem;/,
  );
  assert.equal(omnibarReadout * rem, POWER_UP.bottom + POWER_UP.height + 8);
});

test('scope choice and expanded feather survive every HUD layout and both restore paths', async (t) => {
  const { owner } = styleOwner(t, 'tactical');
  const previous = {
    enabled: isScopeMaskEnabled(),
    feather: getScopeMaskFeather(),
  };
  t.after(() => {
    setScopeMaskEnabled(previous.enabled);
    setScopeMaskFeather(previous.feather);
  });
  Object.assign(owner.services, { setScopeMaskEnabled, setScopeMaskFeather });
  let shown = null;
  owner.store = { publish: (view) => (shown = view.scope) };
  await owner.restoreShareState({ scopeEnabled: false, scopeFeatherPct: 200 });
  assert.deepEqual(shown, { enabled: false, featherPct: 200, opacityPct: 100 });
  for (const layout of ['minimal', 'cyber', 'tactical']) {
    owner._setHudVariant(layout);
    assert.equal(isScopeMaskEnabled(), false, layout);
    assert.equal(getScopeMaskFeather(), 2, layout);
    assert.equal(shown.enabled, false, layout);
  }
  await owner.applyVisualState({ scope: { enabled: true, featherPct: 175 } });
  assert.equal(isScopeMaskEnabled(), true);
  assert.equal(getScopeMaskFeather(), 1.75);
  assert.deepEqual(shown, { enabled: true, featherPct: 175, opacityPct: 100 });
  await owner.applyVisualState({ scope: { featherPct: 500 } });
  assert.equal(getScopeMaskFeather(), 2);
  assert.deepEqual(shown, { enabled: true, featherPct: 200, opacityPct: 100 });
});

test('a shared scope opacity is restored and rides in the next share state', async (t) => {
  const { owner } = styleOwner(t, 'tactical');
  const previous = getScopeMaskOpacity();
  t.after(() => setScopeMaskOpacity(previous));
  Object.assign(owner.services, {
    setScopeMaskEnabled() {},
    setScopeMaskFeather() {},
    setScopeMaskOpacity,
  });
  let shown = null;
  owner.store = { publish: (view) => (shown = view.scope) };
  await owner.restoreShareState({ scopeOpacityPct: 60 });
  assert.equal(getScopeMaskOpacity(), 0.6);
  assert.equal(shown.opacityPct, 60);
  // A state without it leaves the opacity alone.
  await owner.restoreShareState({ scopeFeatherPct: 80 });
  assert.equal(getScopeMaskOpacity(), 0.6);
  assert.equal(shown.opacityPct, 60);
  Object.assign(owner.services, {
    getDetectionTuning: () => ({ allocationStrategy: 'ELASTIC' }),
    getDetectionMode: () => 'OFF',
    isScopeMaskEnabled: () => true,
    getScopeMaskFeather: () => 0.8,
    getScopeMaskOpacity,
    getScopeTerminusOverride: () => null,
  });
  owner.readCelestialRing = () => null;
  assert.equal(owner._readShareState().options.scopeOpacityPct, 60);
  // A link asking for less than the floor opens at the floor, and says so.
  await owner.restoreShareState({ scopeOpacityPct: 20 });
  assert.equal(getScopeMaskOpacity(), 0.5);
  assert.equal(owner._readShareState().options.scopeOpacityPct, 50);
});

test('a scene shot saved with the retired Snow style plays on Normal', async (t) => {
  const { owner } = styleOwner(t, 'tactical');
  owner.setStyle('noir');
  await owner.applyVisualState({ style: 'snow' });
  assert.equal(owner.activeStyle, 'normal');
});

test('shared panel hooks affect only opted-in rail surfaces without overriding disclosure and concealment', () => {
  const styles = read('./styles/panel-surfaces.css');
  const rail = cssRuleBody(
    styles,
    /:is\(#left-panel-stack, #right-context-rail\)\s+> \[data-panel-id\]:has\(> \[data-panel-surface\]\)/,
  );
  assert.match(rail, /pointer-events:\s*auto;/);
  assert.doesNotMatch(rail, /(?:display|visibility):/);
  assert.doesNotMatch(
    styles,
    /:is\(#left-panel-stack, #right-context-rail\)\s*> \[data-panel-id\]\s*\{/,
  );
  assert.match(
    styles,
    /\[data-panel-surface\]:not\(\[hidden\]\):not\(dialog:not\(\[open\]\)\)\s*\{\s*display: flex;/,
  );
  assert.match(
    styles,
    /dialog\[data-panel-surface\]:not\(\[open\]\)\s*\{\s*display: none !important;/,
  );
  assert.match(
    styles,
    /body:is\(\.ui-clean-view, \.recording-mode\)[^{]+\{[^}]*visibility: hidden !important;[^}]*pointer-events: none !important;/,
  );
});

test('narrow Omnibar corners clear the World Timeline over the dock', () => {
  const css = read('./styles/omnibar-dock.css');
  const timeline = css.match(
    /#world-timeline \{\s*bottom: calc\(var\(--omnibar-dock-bottom\) \+ (\d+)px\);/,
  );
  const height = read('./styles/world-timeline.css').match(
    /#world-timeline \{[^}]*\n {2}height: (\d+)px;/,
  );
  const corners = css.match(
    /&:has\(#world-timeline\) \{\s*--omnibar-coordinates-bottom: max\(\s*calc\(var\(--omnibar-dock-bottom\) \+ (\d+)px \+ (\d+)px \+ (\d+)px\)/,
  );
  assert.ok(timeline && height && corners);
  assert.equal(Number(corners[1]), Number(timeline[1]));
  assert.equal(Number(corners[2]), Number(height[1]));
  assert.ok(Number(corners[3]) >= 6);
});
