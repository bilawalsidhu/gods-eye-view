import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyHudUiTheme,
  CYBER_VISUAL_DEFAULTS,
  cyberVisualDefaultsForHudTransition,
  HUD_LAYOUTS,
  normalizeHudLayout,
} from '../hudLayouts.js';
import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { StyleManager } from './applicationShell.js';
import { bindDisplayControls } from './displayControls.js';
import { VisualSettings } from './visualSettings.js';
import { STYLES } from './visualPresets.js';

test('CCTV and Context keep their headers outside Cyber-only scroll bodies', () => {
  for (const file of ['layer-panels.html', 'context.html']) {
    const markup = readFileSync(
      new URL(`./templates/${file}`, import.meta.url),
      'utf8',
    );
    assert.match(markup, /class="cyber-panel-body" data-rail-scroller/);
    assert.ok(
      markup.indexOf('class="panel-header"') <
        markup.indexOf('class="cyber-panel-body"'),
    );
  }
  const shared = readFileSync(
    new URL('./styles/controls.css', import.meta.url),
    'utf8',
  );
  const cyber = readFileSync(
    new URL('./styles/cyber.css', import.meta.url),
    'utf8',
  );
  assert.match(shared, /\.cyber-panel-body\s*\{\s*display: contents;/);
  assert.match(
    cyber,
    /:root\[data-ui-theme='cyber'\] \.cyber-panel-body\s*\{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/,
  );
});

function styleOwner(t, initialVariant = 'cyber') {
  const previous = { document: globalThis.document, window: globalThis.window };
  const root = { dataset: {} };
  globalThis.document = { documentElement: root, querySelectorAll: () => [] };
  globalThis.window = { dispatchEvent() {} };
  t.after(() => Object.assign(globalThis, previous));
  let variant = initialVariant;
  const calls = [];
  const hud = {
    getVariant: () => variant,
    setVariant: (value) => {
      variant = value;
      applyHudUiTheme(root, value);
    },
    setMode: (value) => calls.push(['mode', value]),
    onStyleChange: (value) => calls.push(['style', value]),
  };
  hud.setVariant(initialVariant);
  const owner = Object.create(VisualSettings.prototype);
  Object.assign(owner, {
    activeStyle: 'normal',
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
    services: { governorRequestRender() {}, setDetectionStyle() {} },
    _hudLayoutSelect: { value: initialVariant },
    _styleIndicator: {},
    _setBloomEnabled: (value) => calls.push(['bloom', value]),
    _setSharpenEnabled: (value) => calls.push(['sharpen', value]),
    _applyDetectionPreset: (value) => calls.push(['detection', value]),
    _syncShareState: () => calls.push(['share', variant]),
  });
  for (const name of [
    'setCelestialRingEnabled',
    '_startTransition',
    '_updateStyleMiniStatus',
    '_updateSliderPanel',
    '_updateHudButtonState',
    '_syncIrBoost',
    '_syncCockpitInheritedStyle',
    '_syncCyberSonarControl',
    '_scheduleAdaptivePanelLayout',
    '_applyDetectionFadeFromUi',
  ])
    owner[name] = () => {};
  return { owner, hud, root, calls };
}

test('visual styles retain Cyber through real preset application without dropping other defaults', (t) => {
  const { owner, hud, root, calls } = styleOwner(t);
  for (const style of [
    'surveillance',
    'normal',
    'noir',
    'anime',
    'snow',
    'thermal',
    'retro',
  ]) {
    owner.setStyle(style);
    assert.equal(owner.activeStyle, style);
    assert.equal(hud.getVariant(), 'cyber');
    assert.equal(root.dataset.uiTheme, 'cyber');
    assert.equal(owner._hudLayoutSelect.value, 'cyber');
    assert.deepEqual(calls.at(-1), ['share', 'cyber']);
  }
  assert.equal(owner.stages.thermal.uniforms.sensitivity, 0.85);
  assert.equal(calls.filter(([name]) => name === 'detection').length, 3);
  assert.equal(
    calls.filter(([name, value]) => name === 'bloom' && value === false).length,
    3,
  );
  assert.equal(
    calls.filter(([name, value]) => name === 'sharpen' && value === true)
      .length,
    3,
  );
});

test('non-Cyber style presets and explicit HUD choices remain authoritative', (t) => {
  const { owner, hud, root } = styleOwner(t);
  for (const variant of ['tactical', 'operator', 'minimal']) {
    owner._setHudVariant(variant);
    assert.equal(hud.getVariant(), variant);
    assert.equal(root.dataset.uiTheme, undefined);
    owner.setStyle('normal');
    owner.setStyle('surveillance');
    assert.equal(hud.getVariant(), 'tactical');
  }
});

test('leaving Cyber without a preset choice restores the prior visual preset', (t) => {
  const { owner, hud } = styleOwner(t, 'tactical');
  owner.setStyle('noir');

  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  assert.equal(owner.activeStyle, 'thermal');
  assert.equal(owner._preCyberStyle, 'noir');
  assert.equal(owner._cyberStyleUserSelected, false);

  owner._setHudVariant('operator', { applyVisualDefaults: true });
  assert.equal(hud.getVariant(), 'operator');
  assert.equal(owner.activeStyle, 'noir');
  assert.equal(owner._preCyberStyle, null);
  assert.equal(owner._cyberStyleUserSelected, false);
});

test('a preset explicitly selected in Cyber survives exit and resets for re-entry', (t) => {
  const { owner, hud } = styleOwner(t, 'tactical');
  owner.setStyle('noir');

  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  owner.setStyle('snow', { userInitiated: true });
  assert.equal(owner.activeStyle, 'snow');
  assert.equal(owner._preCyberStyle, 'noir');
  assert.equal(owner._cyberStyleUserSelected, true);

  // Reselecting the active mode must not erase the user's preset intent.
  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  assert.equal(owner._preCyberStyle, 'noir');
  owner._setHudVariant('operator', { applyVisualDefaults: true });
  assert.equal(hud.getVariant(), 'operator');
  assert.equal(owner.activeStyle, 'snow');
  assert.equal(owner._preCyberStyle, null);
  assert.equal(owner._cyberStyleUserSelected, false);

  // A later untouched Cyber round trip restores the new pre-Cyber preset.
  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  assert.equal(owner.activeStyle, 'thermal');
  assert.equal(owner._preCyberStyle, 'snow');
  owner._setHudVariant('minimal', { applyVisualDefaults: true });
  assert.equal(owner.activeStyle, 'snow');
});

test('an explicit same-value FLIR choice is preserved on Cyber exit', (t) => {
  const { owner } = styleOwner(t, 'tactical');
  owner.setStyle('noir');
  owner._setHudVariant('cyber', { applyVisualDefaults: true });

  owner.setStyle('thermal', { userInitiated: true });
  assert.equal(owner.activeStyle, 'thermal');
  assert.equal(owner._cyberStyleUserSelected, true);
  owner._setHudVariant('operator', { applyVisualDefaults: true });
  assert.equal(owner.activeStyle, 'thermal');
});

test('an authoritative same-Cyber reset clears local preset ownership', (t) => {
  const { owner } = styleOwner(t, 'tactical');
  owner.setStyle('noir');
  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  owner.setStyle('snow', { userInitiated: true });
  assert.equal(owner._cyberStyleUserSelected, true);

  owner._setHudVariant('cyber');
  assert.equal(owner.activeStyle, 'snow');
  assert.equal(owner._preCyberStyle, null);
  assert.equal(owner._cyberStyleUserSelected, false);
  owner._setHudVariant('operator', { applyVisualDefaults: true });
  assert.equal(owner.activeStyle, 'snow');
});

test('Display and voice HUD routes preserve explicit Cyber entry and exit authority', async (t) => {
  const makeOwner = () => {
    const { owner, hud } = styleOwner(t, 'tactical');
    owner.setStyle('noir');
    owner.setHudLayout = (...args) =>
      StyleManager.prototype.setHudLayout.call(owner, ...args);
    owner.getControlState = () => ({
      hud: { layout: hud.getVariant(), visible: true },
    });
    return { owner, hud };
  };

  const display = makeOwner();
  const hudLayout = new EventTarget();
  hudLayout.value = 'cyber';
  const snowButton = new EventTarget();
  snowButton.dataset = { style: 'snow' };
  const controls = bindDisplayControls({
    elements: { hudLayout, styleButtons: [snowButton] },
    actions: {
      setHudLayout: (value) => display.owner.setHudLayout(value),
      setStyle: (value) =>
        display.owner.setStyle(value, { userInitiated: true }),
    },
  });
  hudLayout.dispatchEvent(new Event('change'));
  assert.equal(display.hud.getVariant(), 'cyber');
  assert.equal(display.owner.activeStyle, 'thermal');
  snowButton.dispatchEvent(new Event('click'));
  assert.equal(display.owner.activeStyle, 'snow');
  hudLayout.value = 'operator';
  hudLayout.dispatchEvent(new Event('change'));
  assert.equal(display.hud.getVariant(), 'operator');
  assert.equal(display.owner.activeStyle, 'snow');
  controls.destroy();

  const voice = makeOwner();
  const eventSource = { addEventListener() {}, removeEventListener() {} };
  const viewer = {
    camera: { moveEnd: { addEventListener() {} } },
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: eventSource },
  };
  const runVoiceAction = createGevActionRunner({
    viewer,
    styleManager: voice.owner,
    dataManager: {},
  });
  const entered = await runVoiceAction('set_hud', { layout: 'cyber' });
  assert.equal(entered.ok, true);
  assert.equal(voice.hud.getVariant(), 'cyber');
  assert.equal(voice.owner.activeStyle, 'thermal');
  const selected = await runVoiceAction('set_visual_style', { style: 'snow' });
  assert.equal(selected.ok, true);
  assert.equal(voice.owner.activeStyle, 'snow');
  const exited = await runVoiceAction('set_hud', { layout: 'operator' });
  assert.equal(exited.ok, true);
  assert.equal(voice.hud.getVariant(), 'operator');
  assert.equal(voice.owner.activeStyle, 'snow');
});

test('scene and share HUD transitions do not restore a local pre-Cyber preset', async (t) => {
  const { owner, hud } = styleOwner(t, 'tactical');
  owner.setStyle('noir');
  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  owner.setStyle('snow', { userInitiated: true });
  assert.equal(owner._cyberStyleUserSelected, true);

  await owner.applyVisualState({ style: 'retro', hud: { variant: 'cyber' } });
  assert.equal(hud.getVariant(), 'cyber');
  assert.equal(owner.activeStyle, 'retro');
  assert.equal(owner._preCyberStyle, null);
  assert.equal(owner._cyberStyleUserSelected, false);
  owner._setHudVariant('operator', { applyVisualDefaults: true });
  assert.equal(owner.activeStyle, 'retro');

  owner.setStyle('surveillance');
  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  assert.equal(owner._preCyberStyle, 'surveillance');
  owner.setStyle('snow', { userInitiated: true });
  await owner.restoreShareState({
    style: 'thermal',
    hudVariant: 'cyber',
  });
  assert.equal(hud.getVariant(), 'cyber');
  assert.equal(owner.activeStyle, 'thermal');
  assert.equal(owner._preCyberStyle, null);
  assert.equal(owner._cyberStyleUserSelected, false);
  owner._setHudVariant('tactical', { applyVisualDefaults: true });
  assert.equal(owner.activeStyle, 'thermal');
  assert.equal(owner._preCyberStyle, null);
});

test('scene and share restoration override Cyber and preserve restored Cyber parameters', async (t) => {
  const { owner, hud } = styleOwner(t);
  await owner.applyVisualState({ style: 'retro', hud: { variant: 'minimal' } });
  assert.equal(hud.getVariant(), 'minimal');
  owner._setHudVariant('cyber');
  await owner.restoreShareState({
    style: 'surveillance',
    hudVariant: 'operator',
  });
  assert.equal(hud.getVariant(), 'operator');
  await owner.restoreShareState({
    style: 'thermal',
    hudVariant: 'cyber',
    styleParams: { palette: 0.73 },
  });
  assert.equal(hud.getVariant(), 'cyber');
  assert.equal(owner.activeStyle, 'thermal');
  assert.equal(owner.stages.thermal.uniforms.palette, 0.73);
  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  assert.equal(owner.stages.thermal.uniforms.palette, 0.73);
  owner._setHudVariant('tactical');
  owner._setHudVariant('cyber', { applyVisualDefaults: true });
  assert.equal(owner.stages.thermal.uniforms.palette, 0.42);
});

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('Cyber setup uses a compact toolbar icon and highlights the north-up letter', () => {
  const css = read('./styles/cyber.css');
  assert.match(
    css,
    /#top-center-actions #key-setup-chip\s*\{[^}]*inset: auto;[^}]*width: 36px;/,
  );
  assert.match(css, /#key-setup-chip\[hidden\]\s*\{\s*display: none;/);
  assert.match(
    css,
    /#north-up-view\[data-north-up='true'\]\s+\.camera-compass-n\s*\{[^}]*color: var\(--cyber-red-bright\)/,
  );
});
const cyberStyles = read('./styles/cyber.css');

// Source guards supplement rendered popup/hit-target checks. Inspect one rule
// at a time so a safe declaration on a child cannot excuse a clipped ancestor.
function cssRuleBody(styles, selector) {
  const match = styles.match(new RegExp(`${selector.source}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector.source}`);
  return match[1];
}

test('Cyber Voice clips its decoration without clipping descendant help and errors', () => {
  const owner = cssRuleBody(
    cyberStyles,
    /:root\[data-ui-theme='cyber'\] #command-dock > #gev-voice-control/,
  );
  assert.match(owner, /isolation:\s*isolate;/);
  assert.match(owner, /overflow:\s*visible;/);
  assert.match(owner, /clip-path:\s*none;/);

  const decoration = cssRuleBody(
    cyberStyles,
    /:root\[data-ui-theme='cyber'\] #command-dock > #gev-voice-control::before/,
  );
  assert.match(decoration, /clip-path:\s*polygon\(/);
  assert.match(decoration, /pointer-events:\s*none;/);
  assert.match(decoration, /inset:\s*0;/);
  assert.match(decoration, /z-index:\s*-1;/);
});

test('Cyber dock pins escape the tray mask and its decoration overrides the legacy arrow geometry', () => {
  const owner = cssRuleBody(
    cyberStyles,
    /:root\[data-ui-theme='cyber'\] #command-dock \.dock-popover-content/,
  );
  assert.match(owner, /clip-path:\s*none;/);
  assert.match(owner, /isolation:\s*isolate;/);

  // Including the tray owners beats #control-panel's more specific old
  // ::after arrow positioning. Otherwise left:auto can collapse the frame.
  const decoration = cssRuleBody(
    cyberStyles,
    /:root\[data-ui-theme='cyber'\]\s+#command-dock\s+:is\(#location-bar, #control-panel\)\s+\.dock-popover-content::after/,
  );
  assert.match(decoration, /inset:\s*0;/);
  assert.match(decoration, /width:\s*auto;/);
  assert.match(decoration, /height:\s*auto;/);
  assert.match(decoration, /transform:\s*none;/);
  assert.match(decoration, /clip-path:\s*var\(--cyber-panel-frame\);/);
  assert.match(decoration, /pointer-events:\s*none;/);
});

test('Cyber lower-left telemetry tracks the credit anchor with clearance for its logo row', () => {
  const telemetry = cssRuleBody(
    cyberStyles,
    /#intel-hud\[data-variant='cyber'\] \.hud-bottom-left/,
  );
  const offset = telemetry.match(/bottom:\s*calc\(2vh \+ ([\d.]+)rem\);/);
  assert.ok(offset, 'telemetry must retain the attribution viewport anchor');
  const credits = read('./styles/command-dock-trays.css');
  const creditOffsets = [
    ...credits.matchAll(
      /#cesium-credits\s*\{[^}]*bottom:\s*calc\(2vh \+ ([\d.]+)rem\);/g,
    ),
  ];
  assert.ok(creditOffsets.length > 0);
  for (const credit of creditOffsets) {
    assert.ok(
      Number(offset[1]) - Number(credit[1]) >= 2.75,
      'reserve the 28px logo row, baseline descent and 12px clearance at the 16px root size',
    );
  }
  assert.doesNotMatch(cyberStyles, /\.hud-bottom-left\s*\{\s*bottom:\s*60px;/);
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

test('Cyber clipped expand controls retain an inset keyboard-focus outline in map and cockpit', () => {
  assert.match(
    cyberStyles,
    /:root\[data-ui-theme='cyber'\]\s+:is\(\s*\.panel-collapse-btn,\s*body\.cockpit-mode \.cockpit-utility-glyph\s*\):focus-visible\s*\{[^}]*outline: 2px solid var\(--cyber-red-bright\) !important;[^}]*outline-offset: -3px;[^}]*box-shadow: none;/,
  );
  assert.match(
    cyberStyles,
    /:root\[data-ui-theme='cyber'\]\s+:is\(\.panel-collapse-btn, body\.cockpit-mode \.cockpit-utility-glyph\):is\(\s*:hover,\s*:focus-visible\s*\)\s*\{[^}]*border-color: var\(--cyber-red-bright\);/,
  );
});

test('Cyber Radio retains upstream nested Context ownership', () => {
  assert.doesNotMatch(cyberStyles, /#right-context-rail\s*>\s*#radio-panel/);
});

test('Cyber cockpit launchers share Data Layers frame and expand-control treatment', () => {
  assert.match(
    cyberStyles,
    /:is\(\.panel-collapse-btn, body\.cockpit-mode \.cockpit-utility-glyph\)/,
  );
  assert.match(
    cyberStyles,
    /body\.cockpit-mode \.cockpit-utility-launcher \{[^}]*width: var\(--cyber-panel-width\);[^}]*min-height: 60px;[^}]*clip-path: var\(--cyber-panel-frame\);/,
  );
  assert.match(
    cyberStyles,
    /\.cockpit-utility-glyph::after \{\s*content: '\+';/,
  );
  assert.match(
    cyberStyles,
    /\.cockpit-utility-glyph\[aria-expanded='true'\]::after \{\s*content: '−';/,
  );
  assert.match(
    cyberStyles,
    /\.cockpit-utility-control\.is-expanded\s+\.cockpit-utility-launcher \{[^}]*width: 100%;[^}]*clip-path: none;/,
  );
});

test('Cyber side panels share one width and one framed surface material', () => {
  assert.match(cyberStyles, /--cyber-panel-width: 272px;/);
  assert.match(cyberStyles, /--cyber-right-panel-width: 312px;/);
  assert.match(cyberStyles, /--cyber-panel-collapsed-width: 200px;/);
  assert.match(cyberStyles, /--cyber-panel-control-size: 30px;/);
  assert.match(
    cyberStyles,
    /--cyber-panel-surface: rgba\(18, 24, 27, 0\.92\);/,
  );
  assert.match(
    cyberStyles,
    /\.cockpit-utility-control\.is-expanded \{[\s\S]*?width: var\(--cyber-right-panel-width\);[\s\S]*?background-color: var\(--cyber-panel-surface\);[\s\S]*?background-image: var\(--cyber-panel-surface-detail\);[\s\S]*?clip-path: var\(--cyber-panel-frame\);/,
  );
  assert.match(
    cyberStyles,
    /\.cockpit-utility-control\.is-expanded::after \{[\s\S]*?width: 36px;[\s\S]*?border-top: 1px solid rgba\(225, 102, 102, 0\.84\);/,
  );
  assert.match(
    cyberStyles,
    /#global-context-panel #radio-panel\.collapsed \{\s*width: 100%;/,
  );
  assert.match(
    cyberStyles,
    /#left-panel-stack\s*> :is\(#data-panel, #scene-panel\)\.collapsed \{\s*width: var\(--cyber-panel-collapsed-width\);/,
  );
  assert.match(
    cyberStyles,
    /:is\(#data-panel, #scene-panel\)\.collapsed\s+:is\(\.data-panel-inner, \.scene-panel-inner\) \{[\s\S]*?height: 50px;[\s\S]*?min-height: 50px;/,
  );
  assert.match(
    cyberStyles,
    /\.cockpit-utility-control:not\(\.is-expanded\)\s+\.cockpit-utility-launcher \{\s*width: var\(--cyber-panel-collapsed-width\);/,
  );
  assert.match(
    cyberStyles,
    /#pp-toggles\s*> \.pp-header-row\s+\.pp-collapse-btn \{[\s\S]*?width: var\(--cyber-panel-control-size\);[\s\S]*?height: var\(--cyber-panel-control-size\);/,
  );
  assert.match(
    cyberStyles,
    /#right-context-rail\s+:is\(\s*\.cctv-panel-inner,\s*\.weather-panel-inner,\s*\.recent-imagery-panel-inner,\s*\.global-context-panel-inner\s*\) \{\s*padding-right: 8px;/,
  );
  assert.match(
    cyberStyles,
    /#right-context-rail[\s\S]*?:is\(\s*#cctv-panel,\s*#weather-panel,\s*#recent-imagery-panel,\s*#global-context-panel\s*\)\.collapsed[\s\S]*?> \.panel-header \{[\s\S]*?height: 48px;[\s\S]*?padding: 0 10px 0 14px;/,
  );
  assert.doesNotMatch(
    cyberStyles,
    /\.cockpit-utility-control\.is-expanded\s*\{[^}]*order:/,
    'expanded Cockpit utilities must retain Display-then-Radio DOM order',
  );
});

test('Cyber is a canonical HUD layout with a safe Tactical fallback', () => {
  assert.deepEqual(HUD_LAYOUTS, ['tactical', 'operator', 'minimal', 'cyber']);
  assert.equal(normalizeHudLayout('CYBER'), 'cyber');
  assert.equal(normalizeHudLayout('unknown'), 'tactical');
});

test('the Cyber HUD owns the global shell skin and leaving it restores defaults', () => {
  const root = { dataset: { unrelated: 'preserved' } };
  assert.equal(applyHudUiTheme(root, 'cyber'), 'cyber');
  assert.equal(root.dataset.uiTheme, 'cyber');
  assert.equal(applyHudUiTheme(root, 'minimal'), null);
  assert.equal(root.dataset.uiTheme, undefined);
  assert.equal(root.dataset.unrelated, 'preserved');
});

test('an explicit transition into Cyber selects FLIR with Ironbow 0.42 once', () => {
  assert.deepEqual(CYBER_VISUAL_DEFAULTS, {
    style: 'thermal',
    ironbow: 0.42,
  });
  assert.equal(
    cyberVisualDefaultsForHudTransition('tactical', 'cyber', {
      explicit: true,
    }),
    CYBER_VISUAL_DEFAULTS,
  );
  assert.equal(
    cyberVisualDefaultsForHudTransition('cyber', 'cyber', {
      explicit: true,
    }),
    null,
  );
  assert.equal(cyberVisualDefaultsForHudTransition('tactical', 'cyber'), null);
  assert.equal(
    cyberVisualDefaultsForHudTransition('cyber', 'operator', {
      explicit: true,
    }),
    null,
  );
});

test('Cyber visual defaults update the style, thermal palette and render state', () => {
  const calls = [];
  const owner = {
    stages: { thermal: { uniforms: { palette: 0 } } },
    services: {
      governorRequestRender: (reason) => calls.push(['render', reason]),
    },
    setStyle: (style, options) => calls.push(['style', style, options]),
    _updateSliderPanel: (style, options) =>
      calls.push(['sliders', style, options]),
  };

  VisualSettings.prototype._applyCyberVisualDefaults.call(
    owner,
    CYBER_VISUAL_DEFAULTS,
  );

  assert.equal(owner.stages.thermal.uniforms.palette, 0.42);
  assert.deepEqual(calls, [
    [
      'style',
      'thermal',
      {
        applyPreset: false,
        revealParameters: false,
        preserveCyberRestore: true,
      },
    ],
    ['sliders', 'thermal', { reveal: false }],
    ['render', 'cyber-visual-defaults'],
  ]);
});

test('the Display selector, voice schema and final stylesheet expose Cyber', () => {
  const display = read('./templates/display-controls.html');
  const stylesheet = read('../../style.css');
  const rightRail = read('./rightPanelRail.js');
  const hud = read('../hud.js');
  const detection = read('../data/detection.js');
  const civilRendering = read('../layers/flights/rendering.js');
  const militaryRendering = read('../layers/military/rendering.js');
  const setHud = GEV_ACTION_SCHEMAS.find((schema) => schema.name === 'set_hud');

  assert.match(display, /<option value="cyber">Cyber<\/option>/);
  assert.match(display, /id="cyber-sonar-toggle"/);
  assert.match(
    display,
    /id="cyber-sonar-opacity"[^>]*value="84"[^>]*aria-label="Cyber contact and label opacity"/,
  );
  assert.match(display, /id="cyber-sonar-sector"/);
  assert.deepEqual(setHud.parameters.properties.layout.enum, HUD_LAYOUTS);
  assert.match(stylesheet, /@import '\.\/src\/ui\/styles\/cyber\.css';\s*$/);
  assert.match(cyberStyles, /:root\[data-ui-theme='cyber'\]/);
  assert.match(cyberStyles, /\.material-symbols-outlined/);
  assert.match(cyberStyles, /\.pp-label/);
  assert.match(cyberStyles, /#intel-hud\[data-variant='cyber'\]/);
  assert.match(cyberStyles, /#left-panel-stack/);
  assert.match(cyberStyles, /#right-context-rail/);
  assert.match(cyberStyles, /#command-dock/);
  assert.match(cyberStyles, /--cyber-panel-frame: polygon/);
  assert.match(cyberStyles, /\.data-panel-inner,/);
  assert.match(cyberStyles, /#pp-toggles\.collapsed > \.pp-header-row/);
  assert.match(
    cyberStyles,
    /\.panel-collapsible:not\(#location-bar\):not\(#control-panel\)::after/,
  );
  assert.match(cyberStyles, /clip-path: var\(--cyber-panel-frame\);/);
  assert.match(hud, /class="hud-sonar" aria-hidden="true"/);
  assert.match(cyberStyles, /\.hud-sonar::before/);
  assert.match(cyberStyles, /\.hud-sonar::after/);
  assert.match(cyberStyles, /@keyframes cyber-sonar-sweep/);
  assert.match(
    cyberStyles,
    /animation-delay:\s*var\(--cyber-sonar-phase-delay, 0ms\)/,
  );
  assert.doesNotMatch(cyberStyles, /--cyber-sonar-angle/);
  assert.match(cyberStyles, /prefers-reduced-motion: reduce/);
  assert.match(detection, /candidate\.sonarFactor \?\? 1/);
  assert.match(detection, /sonarActive && !obj\.skipLabel/);
  assert.match(detection, /const bracketAlpha = admissionAlpha \* sonarFactor/);
  assert.match(detection, /sonarSampler\.label\(sonarFactor\)/);
  assert.match(detection, /createCyberSonarSampler\(width, height, now\)/);
  assert.match(cyberStyles, /data-cyber-sonar='off'/);
  assert.match(detection, /governorRequestRender\('cyber-sonar-cadence'\)/);
  assert.match(
    detection,
    /const animatingCount = countAnimatingRenderEntries\(renderEntries\);/,
  );
  assert.doesNotMatch(detection, /sonarActive \? 1 : 0/);
  assert.match(
    civilRendering,
    /alpha: flightState\._irBoost \? 1 : treatment\.alpha/,
  );
  assert.match(
    militaryRendering,
    /baseAlpha:[\s\S]*?alpha: flightState\._irBoost \? 1 : treatment\.alpha/,
  );
  assert.match(
    cyberStyles,
    /#title-bar \.title-logo #globe \{[\s\S]*?fill: var\(--cyber-red\);[\s\S]*?stroke: var\(--cyber-red-bright\);/,
  );
  assert.match(cyberStyles, /#title-bar \.title-logo #globe_cage/);
  assert.match(
    cyberStyles,
    /#top-center-actions button\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?clip-path:\s*polygon\(\s*29% 0,\s*71% 0,[\s\S]*?0 29%\s*\);/,
  );
  assert.match(cyberStyles, /#top-center-actions button::before/);
  assert.match(cyberStyles, /\.hud-top-left/);
  assert.match(cyberStyles, /transparent 0 min\(40vw, 52vh\)/);
  assert.match(cyberStyles, /\.hud-bottom-bar \{\s*display: none;/);
  assert.match(
    cyberStyles,
    /#intel-hud\[data-variant='cyber'\] \.hud-top-bar \{\s*display: none;/,
  );
  // Cyber shares the measured rail/credit keep-out rather than overriding it.
  assert.doesNotMatch(
    cyberStyles,
    /#right-context-rail\s*\{[^}]*\b(?:top|bottom|height|max-height):/,
  );
  assert.match(cyberStyles, /--cyber-hud-card-top: max\(100px, 10\.25vh\);/);
  assert.match(
    cyberStyles,
    /--cyber-left-rail-top: max\([\s\S]*?220px,[\s\S]*?calc\(var\(--cyber-hud-card-top\) \+ 120px\)/,
  );
  assert.match(
    cyberStyles,
    /\.hud-top-left \{[\s\S]*?top: var\(--cyber-hud-card-top\);/,
  );
  assert.match(
    cyberStyles,
    /#left-panel-stack \{[\s\S]*?top: var\(--cyber-left-rail-top\) !important;[\s\S]*?bottom: calc\(2vh \+ 13rem\);/,
  );
  assert.match(
    cyberStyles,
    /\.hud-left-edge \{\s*top: calc\(var\(--cyber-left-rail-top\) - 18px\);\s*left: 14px;/,
  );
  assert.match(
    rightRail,
    /const leftStackTop = leftStack\?\.getBoundingClientRect\(\)\.top;[\s\S]*?const alignedTop = Number\.isFinite\(leftStackTop\)[\s\S]*?baseTop: alignedTop,/,
  );
  assert.match(
    cyberStyles,
    /--right-display-collapsed-width: var\(--cyber-panel-collapsed-width\);/,
  );
  assert.match(
    cyberStyles,
    /clip-path: polygon\([\s\S]*?12px 0,[\s\S]*?0 12px/,
  );
  assert.match(cyberStyles, /\.hud-corner::before/);
  assert.match(
    cyberStyles,
    /--cyber-telemetry-fill: rgba\(13, 20, 23, 0\.985\);/,
  );
  assert.match(cyberStyles, /var\(--cyber-telemetry-fill\)/);
  assert.match(cyberStyles, />\s*\.panel-header\s+\.panel-title::before/);
  assert.match(cyberStyles, /\.panel-collapsible\.collapsed::after/);
  assert.match(cyberStyles, /\.panel-collapsible:not\(\.collapsed\)::after/);
  assert.match(cyberStyles, /\.context-mode-standby:not\(\[hidden\]\)/);
  assert.match(cyberStyles, /mask-image: linear-gradient\(/);
  assert.match(cyberStyles, /flex: 1 1 auto;/);
  assert.match(cyberStyles, /#left-panel-stack:has/);
  assert.match(cyberStyles, /left: 54px;/);
  assert.match(cyberStyles, /right: 62px;/);
  assert.match(cyberStyles, /bottom: calc\(2vh \+ 13rem\);/);
  assert.doesNotMatch(cyberStyles, /NAV 01  \/\/  COMMAND BUS  \/\/  VIS 03/);
  assert.match(cyberStyles, /data-layer-id='satellites'/);
  assert.match(cyberStyles, /#search-toggle::before/);
  assert.match(cyberStyles, /VISUAL MATRIX  \/\/  03/);
  assert.match(cyberStyles, /body\.cockpit-mode #cockpit-hud/);
  assert.match(cyberStyles, /TARGET SCANNING  \/\/  LIVE VECTOR/);
  assert.match(
    cyberStyles,
    /body\.cockpit-mode #global-loading-status \{[\s\S]*?top: 60px;[\s\S]*?z-index: 146;/,
  );
  assert.match(
    cyberStyles,
    /body\.cockpit-mode #global-loading-detail \{[\s\S]*?color: var\(--cockpit-accent\);/,
  );
  assert.match(cyberStyles, /body\.cockpit-mode \.cockpit-visor-shell::before/);
  assert.match(cyberStyles, /body\.cockpit-mode \.cockpit-scan-array/);
  assert.match(cyberStyles, /body\.cockpit-mode \.cockpit-target-side-arcs/);
  assert.match(cyberStyles, /body\.cockpit-mode \.cockpit-target-ticks/);
  assert.match(cyberStyles, /body\.cockpit-mode \.cockpit-target-core/);
  assert.match(cyberStyles, /width: min\(48vw, 60vh\);/);
  assert.match(cyberStyles, /body\.cockpit-mode \.cockpit-context-window/);
  assert.match(cyberStyles, /body\.cockpit-mode \.cockpit-signal-window/);
  assert.match(cyberStyles, /body\.cockpit-mode #intel-hud\.active/);
});

test('Cyber voice telemetry renders a live scan scope without replacing audio ownership', () => {
  assert.match(
    cyberStyles,
    /#gev-voice-control\s*\{[\s\S]*?--cyber-voice-wave:/,
  );
  assert.match(cyberStyles, /\.gev-voice-visualizer::before/);
  assert.match(cyberStyles, /\.gev-voice-visualizer::after/);
  assert.match(cyberStyles, /@keyframes gev-cyber-voice-scan/);
  assert.match(cyberStyles, /@keyframes gev-cyber-voice-lock/);
  assert.match(cyberStyles, /\[data-speaker='user'\]/);
  assert.match(cyberStyles, /\[data-speaker='ai'\]/);
  assert.match(
    cyberStyles,
    /prefers-reduced-motion: reduce[\s\S]*?gev-voice-visualizer::after[\s\S]*?animation: none/,
  );
});

test('Cyber Cockpit Display uses the released briefing lane instead of the legacy viewport cap', () => {
  assert.match(
    cyberStyles,
    /body\.cockpit-mode\s+#cockpit-display-panel\s*\{[\s\S]*?max-height:\s*calc\(var\(--cockpit-utility-expanded-max-height, 72vh\) - 62px\)/,
  );
  assert.match(
    cyberStyles,
    /#cockpit-hud:has\(\.cockpit-utility-control\.is-expanded\)[\s\S]*?\.cockpit-signal-window\[data-collapsed='true'\][\s\S]*?bottom: 80px;[\s\S]*?visibility:\s*visible/,
  );
});

test('Cyber Cockpit keeps Data Layers inside its bounded rail', () => {
  assert.match(
    cyberStyles,
    /body:not\(\.cockpit-mode\)\s+#left-panel-stack:has\([\s\S]*?max-height:\s*none;/,
  );
  assert.match(
    cyberStyles,
    /body\.cockpit-mode #left-panel-stack > #data-panel \{[\s\S]*?max-height: min\(64vh, 610px\);/,
  );
});

test('Cyber desktop cockpit collapsed utility frames match the 50px Data Layers frame', () => {
  const desktop = cyberStyles.slice(
    cyberStyles.indexOf('@media (min-width: 961px) and (min-height: 650px)'),
    cyberStyles.indexOf('@media (max-width: 720px)'),
  );
  assert.match(
    desktop,
    /:root\[data-ui-theme='cyber'\]\s+body\.cockpit-mode\s+\.cockpit-utility-control:not\(\.is-expanded\)\s+\.cockpit-utility-launcher\s*\{\s*height: 50px;\s*min-height: 50px;\s*padding: 9px 18px 9px 24px;/,
  );
  assert.match(
    desktop,
    /\.cockpit-utility-control:not\(\.is-expanded\)\s+\.cockpit-utility-launcher::after\s*\{\s*bottom: 6px;/,
  );
});

test('Cyber right panels preserve intrinsic sizing and the shared rail allocation', () => {
  assert.doesNotMatch(
    cyberStyles.slice(cyberStyles.indexOf(":root[data-ui-theme='cyber'] {")),
    /#right-context-rail\s*>[^{}]+\{[^{}]*\b(?:flex|height|max-height):/,
  );
});

test('Cyber panels retain clean edges without the added footer band', () => {
  assert.doesNotMatch(cyberStyles, /--cyber-panel-foot-/);
  assert.doesNotMatch(cyberStyles, /border-bottom: 24px solid transparent/);
});

test('Cyber keeps Sonar on/off without the removed CSS effect switch or dimmer', () => {
  const template = readFileSync(
    new URL('./templates/display-controls.html', import.meta.url),
    'utf8',
  );
  assert.match(template, /id="cyber-sonar-toggle"/);
  assert.doesNotMatch(template, /data-sonar-mode|cyber-sonar-mode-row/);
  assert.doesNotMatch(cyberStyles, /cyber-scene-dimmer|data-cyber-sonar-mode/);
});

test('Cyber Display uses a red title without a panel-specific center tab', () => {
  assert.match(
    cyberStyles,
    /#pp-toggles \.pp-header-label\s*\{\s*color: var\(--cyber-red-bright\);/,
  );
  assert.doesNotMatch(cyberStyles, /#pp-toggles[^,{]*::after\s*\{/);
  assert.match(cyberStyles, /isolation: isolate;\s*clip-path: none;/);
  assert.match(cyberStyles, /#pp-toggles:not\(\.collapsed\)::before/);
});

test('Cyber omits only the fictional classification and system header lines', () => {
  assert.match(
    cyberStyles,
    /#intel-hud\[data-variant='cyber'\] \.hud-top-left \.hud-classification,\s*#intel-hud\[data-variant='cyber'\] \.hud-top-left \.hud-system\s*\{\s*display: none;\s*\}/,
  );
});
