import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(
  new URL('./ui/styles/mobile-first.css', import.meta.url),
  'utf8',
);
const panelChrome = fs.readFileSync(
  new URL('./ui/panelChrome.js', import.meta.url),
  'utf8',
);
const MOBILE_QUERY = '@media (max-width: 720px)';
const MOBILE_PORTRAIT_QUERY =
  '@media (max-width: 720px) and (orientation: portrait)';
const PORTRAIT_430_QUERY =
  '@media (max-width: 430px) and (orientation: portrait)';
const PORTRAIT_390_QUERY =
  '@media (max-width: 390px) and (orientation: portrait)';

function mediaBlock(query) {
  const start = css.indexOf(query);
  assert.notEqual(start, -1, `missing media query: ${query}`);
  const open = css.indexOf('{', start + query.length);
  assert.notEqual(open, -1, `missing opening brace for ${query}`);
  let depth = 0;
  let quote = '';
  let inComment = false;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index];
    const next = css[index + 1];
    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '*') {
      inComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated media block: ${query}`);
}

test('narrow portrait phones simplify and reflow the fixed HUD readouts', () => {
  const portrait430 = mediaBlock(PORTRAIT_430_QUERY);
  const mobile = mediaBlock(MOBILE_QUERY);

  assert.match(
    portrait430,
    /#intel-hud\.active \.hud-top-bar,[\s\S]*?#intel-hud \.hud-ais-vessel \{\s*display: none;/,
  );
  assert.match(portrait430, /#intel-hud \.hud-bottom-right,/);
  assert.match(
    portrait430,
    /#intel-hud \.hud-top-left \{[\s\S]*?top: calc\(var\(--mobile-safe-top\) \+ 42px\);[\s\S]*?right: auto;[\s\S]*?left: 10px;[\s\S]*?width: max-content;[\s\S]*?max-width: min\(72vw, 22rem\);/,
  );
  assert.match(
    portrait430,
    /#intel-hud \.hud-bottom-left \{[\s\S]*?bottom: calc\(var\(--mobile-attribution-zone-top\) \+ 56px\);/,
  );
  assert.match(
    portrait430,
    /#intel-hud \.hud-summary \{[\s\S]*?white-space: normal;[\s\S]*?-webkit-line-clamp: 3;/,
  );
  assert.match(
    portrait430,
    /#hud-mgrs,[\s\S]*?#hud-alt \{[\s\S]*?text-overflow: ellipsis;/,
  );
  assert.match(
    mobile,
    /#intel-hud \.hud-widget-toggle,[\s\S]*?#intel-hud \.hud-widget-chip \{[\s\S]*?pointer-events: auto;/,
  );
  assert.match(
    mobile,
    /#intel-hud\[data-hud-status-collapsed='true'\] \.hud-top-left \.hud-content,[\s\S]*?display: none;/,
  );
});

test('narrow portrait phones keep the floating mic and first-run launcher out of the bottom-nav lane', () => {
  const portrait430 = mediaBlock(PORTRAIT_430_QUERY);
  const portrait390 = mediaBlock(PORTRAIT_390_QUERY);
  const mobile = mediaBlock(MOBILE_QUERY);

  assert.match(
    portrait430,
    /body:not\(\[data-mobile-panel='controls'\]\)[\s\S]*?#command-dock[\s\S]*?> #gev-voice-control:not\(\[data-status='idle'\]\) \{[\s\S]*?left: auto;[\s\S]*?width: min\(15rem, calc\(100vw - 24px\)\);/,
  );
  assert.match(
    portrait430,
    /body\[data-mobile-panel='controls'\] #command-dock \.button-grid \{[\s\S]*?display: grid !important;[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/,
  );
  assert.match(
    portrait430,
    /body\[data-mobile-panel='controls'\] #command-dock \.map-stack-chip-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/,
  );
  assert.match(
    mobile,
    /body\[data-mobile-panel='controls'\] #command-dock \.gev-voice-error-tray \{[\s\S]*?left: 0;[\s\S]*?max-width: 100%;/,
  );
  assert.match(
    portrait430,
    /#first-run-launcher \{[\s\S]*?bottom: calc\(var\(--mobile-panel-bottom\) \+ 12px\);[\s\S]*?max-height: calc\(/,
  );
  assert.match(portrait390, /#hud-gsd \{\s*display: none;/);
  assert.match(
    portrait390,
    /body:not\(\[data-mobile-panel='controls'\]\)[\s\S]*?#command-dock[\s\S]*?> #gev-voice-control:not\(\[data-status='idle'\]\) \{[\s\S]*?width: min\(13\.5rem, calc\(100vw - 24px\)\);/,
  );
  assert.match(
    portrait390,
    /#first-run-launcher \{[\s\S]*?padding: 0\.72rem 0\.78rem;/,
  );
  assert.match(
    portrait390,
    /#first-run-description \{[\s\S]*?font-size: 0\.68rem;[\s\S]*?line-height: 1\.4;/,
  );
});

test('mobile bottom-nav panels reserve attribution-safe space and scroll within the panel', () => {
  const mobile = mediaBlock(MOBILE_QUERY);
  const mobilePortrait = mediaBlock(MOBILE_PORTRAIT_QUERY);

  assert.match(
    mobile,
    /--mobile-panel-safe-bottom: calc\(var\(--mobile-attribution-zone-top\) \+ 8px\);/,
  );
  assert.match(
    mobile,
    /--mobile-panel-safe-max-height: calc\([\s\S]*?var\(--mobile-panel-safe-bottom\)[\s\S]*?var\(--mobile-panel-viewport-gap\)[\s\S]*?\);/,
  );
  assert.match(
    mobile,
    /#data-panel,[\s\S]*?#scene-panel,[\s\S]*?#cctv-panel,[\s\S]*?#global-context-panel \{[\s\S]*?bottom: var\(--mobile-panel-safe-bottom\);[\s\S]*?max-height: var\(--mobile-panel-safe-max-height\);/,
  );
  assert.match(
    mobile,
    /body\[data-mobile-panel='controls'\] #command-dock \{[\s\S]*?overflow-y: auto;/,
  );
  assert.match(
    panelChrome,
    /_setMobileControlsSheetExpanded\(expanded\) \{[\s\S]*?dock\?\.style\.setProperty\('top', 'var\(--mobile-safe-top\)'\);[\s\S]*?dock\?\.style\.setProperty\('bottom', 'var\(--mobile-panel-safe-bottom\)'\);[\s\S]*?dock\?\.style\.removeProperty\('top'\);[\s\S]*?dock\?\.style\.removeProperty\('bottom'\);/,
  );
  assert.match(
    mobile,
    /:is\(#data-panel, #scene-panel, #cctv-panel, #global-context-panel\)[\s\S]*?\.panel-header \{[\s\S]*?position: sticky;[\s\S]*?top: 0;/,
  );
  assert.match(
    mobilePortrait,
    /--mobile-panel-safe-max-height: min\([\s\S]*?var\(--mobile-panel-safe-bottom\)[\s\S]*?75dvh[\s\S]*?\);/,
  );
});
