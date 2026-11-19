import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCreditsView } from './creditsView.js';
import { bindRenderer } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';
import { setLocale } from '../i18n/index.js';

function scene() {
  document.body.replaceChildren();
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  return { viewer, renderer };
}

test("the renderer's credits show on the line, and the rest in the list it opens", () => {
  const { viewer, renderer } = scene();
  renderer.credits.addStatic({
    text: 'Google',
    href: 'https://maps.google.com',
    inline: true,
  });
  const off = mountCreditsView(viewer);
  const line = document.querySelector('#gev-credits .gev-credits-line');
  assert.equal(line.textContent, 'Google');
  assert.equal(line.querySelector('a').href, 'https://maps.google.com/');
  const expand = document.querySelector('.gev-credits-expand');
  assert.equal(expand.hidden, true, 'nothing to list yet');

  const remove = renderer.credits.addStatic({ text: 'Wildlife: iNaturalist' });
  renderer.credits.addStatic({ text: 'Wildlife: iNaturalist' });
  renderer.credits.addStatic({ text: 'OSM', href: 'javascript:alert(1)' });
  assert.equal(expand.hidden, false);
  assert.equal(expand.textContent, 'Data attribution');
  const panel = document.getElementById('gev-credits-panel');
  assert.equal(panel.hidden, true);
  expand.click();
  assert.equal(panel.hidden, false);
  assert.equal(expand.getAttribute('aria-expanded'), 'true');
  const items = [...panel.querySelectorAll('li')].map((li) => li.textContent);
  assert.deepEqual(items, ['Wildlife: iNaturalist', 'OSM'], 'once each');
  assert.equal(panel.querySelector('li:last-child a'), null, 'unsafe link');

  panel.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, expand, 'focus goes back');

  remove();
  assert.equal(
    [...panel.querySelectorAll('li')].length,
    2,
    'a duplicate still credits it',
  );
  off();
  assert.equal(document.getElementById('gev-credits'), null);
  assert.equal(document.getElementById('gev-credits-panel'), null);
});

test('a credit with a logo is drawn as the logo, named by its text', () => {
  const { viewer, renderer } = scene();
  renderer.credits.addStatic({
    text: 'Google',
    logoUrl: 'https://example.com/logo.png',
    inline: true,
  });
  const off = mountCreditsView(viewer);
  const credit = document.querySelector('#gev-credits .gev-credit');
  const logo = credit.querySelector('img');
  assert.equal(logo.src, 'https://example.com/logo.png');
  assert.equal(logo.alt, 'Google', 'screen readers and copies keep the name');
  assert.equal(credit.textContent, '', 'the logo stands in place of the text');
  off();
});

test('a viewer with no renderer shows no credits line', () => {
  document.body.replaceChildren();
  const off = mountCreditsView({});
  assert.equal(document.getElementById('gev-credits'), null);
  off();
});

test('the credits line is placed wherever the renderer’s own display is', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('./styles/', import.meta.url);
  const missing = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(new URL(name, dir), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const parts = [...css.matchAll(/([^{};]+)\{/g)]
      .map((match) => match[1].replace(/\s+/g, ' ').trim())
      .filter((selector) => !selector.startsWith('@'))
      .flatMap((selector) =>
        selector.split(/,(?![^(]*\))/).map((part) => part.trim()),
      );
    // The display's own selectors, without its inner parts, each with the
    // line's counterpart in the same stylesheet.
    for (const part of parts)
      if (
        /#cesium-credits$/.test(part) &&
        !parts.includes(part.replace('#cesium-credits', '#gev-credits'))
      )
        missing.push(`${name}: ${part}`);
  }
  assert.deepEqual(missing, []);
});

test('focus in the list stays in it as it redraws, and goes to the line as it empties', () => {
  const { viewer, renderer } = scene();
  renderer.credits.addStatic({ text: 'Esri', inline: true });
  const remove = renderer.credits.addStatic({
    text: 'OSM',
    href: 'https://www.openstreetmap.org/copyright',
  });
  const off = mountCreditsView(viewer);
  const panel = document.getElementById('gev-credits-panel');
  document.querySelector('.gev-credits-expand').click();
  const link = panel.querySelector('li a');
  link.focus();
  const removeOther = renderer.credits.addStatic({ text: 'NOAA' });
  assert.equal(panel.hidden, false);
  assert.ok(panel.contains(document.activeElement), 'still in the list');
  assert.equal(document.activeElement, link, 'the focused link keeps it');
  remove();
  removeOther();
  assert.equal(panel.hidden, true);
  assert.equal(
    document.activeElement,
    document.getElementById('gev-credits'),
    'a line with no link takes it',
  );
  off();
});

test('a credit with linked words links only those words', () => {
  const { viewer, renderer } = scene();
  renderer.credits.addStatic({
    text: 'Street Level: imagery © Mapillary contributors, CC BY-SA 4.0',
    href: 'https://www.mapillary.com/',
    linkText: 'Mapillary',
    inline: true,
  });
  const off = mountCreditsView(viewer);
  const credit = document.querySelector('#gev-credits .gev-credit');
  const link = credit.querySelector('a');
  assert.equal(link.textContent, 'Mapillary');
  assert.equal(link.href, 'https://www.mapillary.com/');
  assert.equal(
    credit.textContent,
    'Street Level: imagery © Mapillary contributors, CC BY-SA 4.0',
  );
  off();
});

test('the line and its list follow the locale', () => {
  const { viewer, renderer } = scene();
  renderer.credits.addStatic({ text: 'NOAA' });
  const off = mountCreditsView(viewer);
  const expand = document.querySelector('.gev-credits-expand');
  const close = document.querySelector('.gev-credits-close');
  try {
    setLocale('fr');
    assert.equal(expand.textContent, 'Attribution des données');
    assert.equal(
      document.getElementById('gev-credits-panel-title').textContent,
      'Données fournies par\u202f:',
    );
    assert.equal(
      close.getAttribute('aria-label'),
      "Fermer l'attribution des données",
    );
  } finally {
    setLocale('en');
  }
  assert.equal(expand.textContent, 'Data attribution');
  off();
});

test('the line and its list are the last of the body, and its close button is the kit’s', () => {
  const { viewer, renderer } = scene();
  document.body.append(document.createElement('main'));
  renderer.credits.addStatic({ text: 'NOAA' });
  const off = mountCreditsView(viewer);
  const children = [...document.body.children];
  assert.deepEqual(
    children.slice(-2).map((element) => element.id),
    ['gev-credits', 'gev-credits-panel'],
    'the page’s rules select them as children of the body',
  );
  const close = document.querySelector('.gev-credits-close');
  assert.ok(close.classList.contains('ui-button'), 'a UiCloseButton');
  assert.equal(close.type, 'button');
  assert.equal(close.textContent, '×');
  assert.equal(close.hasAttribute('title'), false, 'no tip');
  assert.equal(
    close.classList.contains('ui-close-button'),
    false,
    'bare: it keeps the browser’s padding',
  );
  off();
  assert.deepEqual(
    [...document.body.children].map((element) => element.tagName),
    ['MAIN'],
  );
});
