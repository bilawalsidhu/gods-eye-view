import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MOBILE_SHELL_CLASS,
  MOBILE_SHELL_MEDIA_QUERY,
  MOBILE_SHEET_ATTR,
  MOBILE_SHEET_PANELS,
  MOBILE_TAB_SHEETS,
  applyMobileShellMatch,
  nextMobileSheetState,
  sheetForPanelId,
  syncMobileSheetFromPanel,
} from './mobileShell.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const ui = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

test('tab bar markup maps Search, Layers, Context, Display, Presets, and More', () => {
  const match = html.match(/<nav id="mobile-tab-bar"[\s\S]*?<\/nav>/);
  assert.ok(match, 'mobile tab bar is missing');
  assert.deepEqual([...MOBILE_TAB_SHEETS], ['search', 'layers', 'context', 'display', 'presets', 'more']);
  for (const sheet of MOBILE_TAB_SHEETS) {
    assert.match(match[0], new RegExp(`data-mobile-sheet="${sheet}"`));
  }
  assert.match(html, /viewport-fit=cover/);
});

test('sheet ownership stays exclusive and complete', () => {
  assert.deepEqual(Object.keys(MOBILE_SHEET_PANELS), ['layers', 'context', 'display', 'more', 'search', 'presets']);
  assert.deepEqual([...MOBILE_SHEET_PANELS.layers], ['data-panel']);
  assert.deepEqual([...MOBILE_SHEET_PANELS.context], ['global-context-panel']);
  assert.deepEqual([...MOBILE_SHEET_PANELS.display], ['pp-toggles']);
  assert.deepEqual([...MOBILE_SHEET_PANELS.more], ['cctv-panel', 'scene-panel', 'geo-status-panel']);
  assert.deepEqual([...MOBILE_SHEET_PANELS.search], ['location-bar']);
  assert.deepEqual([...MOBILE_SHEET_PANELS.presets], ['control-panel']);
  assert.equal(sheetForPanelId('data-panel'), 'layers');
  assert.equal(sheetForPanelId('location-bar'), 'search');
  assert.equal(sheetForPanelId('control-panel'), 'presets');
});

test('setPanelCollapsed hook is a no-op without mobile-shell', () => {
  assert.equal(
    nextMobileSheetState({
      mobileShellActive: false,
      currentSheet: null,
      panelId: 'global-context-panel',
      collapsed: false,
    }).changed,
    false,
  );
  const body = {
    classList: { contains: () => false },
    getAttribute: () => null,
    setAttribute() { throw new Error('desktop must not write sheet state'); },
    removeAttribute() { throw new Error('desktop must not write sheet state'); },
  };
  syncMobileSheetFromPanel('global-context-panel', {
    collapsed: false,
    documentRef: { body, getElementById: () => null },
  });
});

test('restored desktop prefs do not open a phone sheet', () => {
  const next = nextMobileSheetState({
    mobileShellActive: true,
    currentSheet: null,
    panelId: 'global-context-panel',
    collapsed: false,
    restore: true,
  });
  assert.equal(next.changed, false);
  assert.equal(next.sheet, null);
});

test('explicit expand opens the matching sheet and explicit collapse closes it', () => {
  const opened = nextMobileSheetState({
    mobileShellActive: true,
    currentSheet: null,
    panelId: 'data-panel',
    collapsed: false,
  });
  assert.deepEqual(opened, { changed: true, sheet: 'layers' });
  const closed = nextMobileSheetState({
    mobileShellActive: true,
    currentSheet: 'layers',
    panelId: 'data-panel',
    collapsed: true,
    explicit: true,
  });
  assert.deepEqual(closed, { changed: true, sheet: null });
  const housekeeping = nextMobileSheetState({
    mobileShellActive: true,
    currentSheet: 'layers',
    panelId: 'data-panel',
    collapsed: true,
    explicit: false,
  });
  assert.equal(housekeeping.changed, false);
});

test('crossing 721px drops the shell class and the open sheet', () => {
  const attrs = new Map([[MOBILE_SHEET_ATTR, 'layers']]);
  const classes = new Set([MOBILE_SHELL_CLASS]);
  const body = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => attrs.delete(name),
    getAttribute: (name) => attrs.get(name) ?? null,
  };
  assert.equal(applyMobileShellMatch({ matches: true, body }), true);
  assert.equal(applyMobileShellMatch({ matches: false, body }), false);
  assert.equal(classes.has(MOBILE_SHELL_CLASS), false);
  assert.equal(attrs.has(MOBILE_SHEET_ATTR), false);
});

test('ui.js keeps the desktop setPanelCollapsed hook and 720px layout gate', () => {
  assert.match(ui, /import \{ initMobileShell, syncMobileSheetFromPanel \} from '\.\/mobileShell\.js'/);
  assert.match(ui, /syncMobileSheetFromPanel\(panelId, \{ collapsed: nextCollapsed, restore, explicit \}\)/);
  assert.match(ui, /window\.matchMedia\('\(max-width: 720px\)'\)\.matches/);
  assert.match(css, /\(max-width:\s*720px\)/);
  assert.equal(MOBILE_SHELL_MEDIA_QUERY, '(max-width: 720px)');
});

test('phone boot keeps desktop MSAA and falls back if tiles hang', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /const phoneLayout = window\.matchMedia\('\(max-width: 720px\)'\)\.matches/);
  assert.match(main, /msaaSamples: phoneLayout \? 1 : 4/);
  assert.match(main, /Google 3D Tiles timed out on this device/);
  assert.match(main, /loadPhotorealisticTileset/);
  assert.match(main, /: await createTileset/);
});

test('tab bar is display:none by default and only appears under mobile-shell at 720px', () => {
  assert.match(css, /#mobile-tab-bar,\s*\n#mobile-sheet-backdrop,\s*\n#mobile-modal-close \{\s*\n\s*display:\s*none;/);
  assert.match(html, /id="mobile-modal-close"/);
  const shellBlock = css.match(
    /\/\* ── Mobile tab-shell \(720px, body\.mobile-shell only\) ── \*\/\s*@media \(max-width: 720px\) \{([\s\S]*?)\n\}\n\n@media \(max-width: 720px\) and \(max-height: 500px\)/,
  );
  assert.ok(shellBlock, 'mobile-shell 720px block is missing');
  assert.match(shellBlock[1], /body\.mobile-shell #mobile-tab-bar \{/);
  assert.match(shellBlock[1], /display:\s*flex;/);
  assert.match(shellBlock[1], /body\.cockpit-mode\.mobile-shell #mobile-tab-bar/);
  assert.match(shellBlock[1], /body\.ui-clean-view\.mobile-shell #mobile-tab-bar/);
  assert.match(shellBlock[1], /body\.recording-mode\.mobile-shell #mobile-tab-bar/);
  assert.match(shellBlock[1], /z-index:\s*160/);
  assert.match(shellBlock[1], /#mobile-modal-close/);
  assert.match(shellBlock[1], /data-mobile-sheet='search'/);
  assert.match(shellBlock[1], /data-mobile-sheet='presets'/);
});

test('every body.mobile-shell rule stays inside the 720px gate', () => {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let index = 0;
  let prelude = '';
  const mediaStack = [];
  const leaks = [];
  while (index < src.length) {
    const char = src[index];
    if (char === '{') {
      const head = prelude.replace(/\s+/g, ' ').trim();
      prelude = '';
      if (head.startsWith('@media')) {
        mediaStack.push(head.slice('@media'.length).trim());
        index += 1;
        continue;
      }
      if (head.startsWith('@')) {
        let level = 1;
        index += 1;
        while (index < src.length && level > 0) {
          if (src[index] === '{') level += 1;
          else if (src[index] === '}') level -= 1;
          index += 1;
        }
        continue;
      }
      if (/\bbody\.mobile-shell\b/.test(head)) {
        const gated = mediaStack.some((condition) => condition.includes('max-width: 720px'));
        if (!gated) leaks.push(head);
      }
      const close = src.indexOf('}', index);
      index = close + 1;
      continue;
    }
    if (char === '}') {
      mediaStack.pop();
      prelude = '';
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  assert.deepEqual(leaks, [], `mobile-shell rules leaked outside 720px:\n  ${leaks.join('\n  ')}`);
});

test('mobile-shell credit and dock offsets lift only under the shell selector', () => {
  assert.match(
    css,
    /body\.mobile-shell #command-dock \{\s*bottom:\s*calc\(3\.25rem \+ 8px\);/,
  );
  assert.match(
    css,
    /body\.mobile-shell #command-dock:has\(#location-bar:not\(\.collapsed\)\),\s*\n\s*body\.mobile-shell #command-dock:has\(#control-panel:not\(\.collapsed\)\) \{\s*\n\s*left:\s*0;\s*\n\s*transform:\s*none;/,
  );
  assert.match(
    css,
    /body\.mobile-shell:not\(\.ui-clean-view\):not\(\.recording-mode\) #cesium-credits,[\s\S]*?bottom:\s*calc\(2vh \+ 8\.5rem\);/,
  );
});
