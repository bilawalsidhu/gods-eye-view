// The Stories views' buttons and checkboxes are the kit's: neither the
// Stories entry nor any Explore or Story screen hand-writes a <button> or an
// `<input type="checkbox">`. Their glyphs are inline SVG drawn for Stories
// (play, pause, back, filter, search, clear, expand, the GEV eye); no
// Material symbol the page loads draws any of them the same, so they stay
// SVG, and no view hand-writes a Material Symbols span. The three search
// fields (Explore's two and the Story context sheet's) keep their own markup
// rather than UiSearchField, whose Material magnifier would replace their
// SVG one, and Explore's two clear buttons stay ghost UiButtons with an SVG
// cross rather than UiCloseButtons, whose glyph is × or the Material `close`
// symbol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** A view's template block: everything outside script and style. */
function template(file) {
  const source = readFileSync(
    new URL(`../views/${file}`, import.meta.url),
    'utf8',
  );
  return source.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/g, '');
}
const views = {
  // The Stories entry, the popup's Browse stories and Not now, and the
  // toast's Back to story.
  'StoriesView.vue': { buttons: 4, svgs: 2 },
  // The list grip, Filter, the two search clears, the topic chips (All and
  // each topic), the filter's Clear and Show, Clear all, a card's thumbnail
  // play and Play story, the map pins and the preview's Play story.
  'stories/ExploreScreen.vue': { buttons: 13, svgs: 8 },
  // Back, the logo, the breadcrumb's link, search, Share and Back to GEV or
  // GEV Stories.
  'stories/StoriesHeader.vue': { buttons: 8, svgs: 5 },
  // The sheet handle, voice search, the search results, Close, the key
  // moments and the related stories.
  'stories/StoryContext.vue': { buttons: 6, svgs: 3 },
  // Open in GEV and Share.
  'stories/StoryRail.vue': { buttons: 2, svgs: 1 },
  // A chapter, Minimise, Expand, the card's page dots, the big Play and
  // Context.
  'stories/StoryScreen.vue': { buttons: 6, svgs: 5 },
  // Play, the key moment pips and Expand map.
  'stories/StoryTimeline.vue': { buttons: 3, svgs: 2 },
};
// A tag's attributes, read past quoted values so a handler's `=>` does not
// end the tag early.
const ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;
const tag = (pattern, flags = '') =>
  new RegExp(pattern.replaceAll('ATTRS', ATTRS), flags);
const markup = Object.fromEntries(
  Object.keys(views).map((file) => [file, template(file)]),
);

test('the Stories views hand-write no button; each is a UiButton', () => {
  for (const [file, { buttons }] of Object.entries(views)) {
    assert.deepEqual(markup[file].match(/<button\b/gi) ?? [], [], file);
    assert.equal(markup[file].match(/<UiButton\b/g)?.length, buttons, file);
  }
});

test('the pressed toggles take the kit pressed state', () => {
  for (const view of Object.values(markup))
    assert.doesNotMatch(view, tag(String.raw`<UiButton\bATTRS\saria-pressed`));
  const explore = markup['stories/ExploreScreen.vue'];
  // All, each topic and the map pins; the cards are role="button" divs that
  // keep their own aria-pressed.
  assert.equal(
    explore.match(tag(String.raw`<UiButton\bATTRS\s:pressed=`, 'g'))?.length,
    3,
  );
  assert.match(
    explore,
    tag(String.raw`class="card"\s+role="button"ATTRS\s:aria-pressed=`),
  );
  assert.match(
    markup['stories/StoryScreen.vue'],
    tag(String.raw`<UiButton\s+id="btnCtx"ATTRS\s:pressed="ctxOpen"`),
  );
  assert.match(
    markup['stories/StoryTimeline.vue'],
    tag(String.raw`<UiButton\s+id="stExpand"ATTRS\s:pressed="expanded"`),
  );
});

test("Explore's filter options are UiCheckboxes in their own label", () => {
  const explore = markup['stories/ExploreScreen.vue'];
  assert.deepEqual(
    explore.match(tag(String.raw`<input\bATTRS\stype="checkbox"`, 'g')) ?? [],
    [],
  );
  const boxes = explore.match(tag(String.raw`<UiCheckbox\bATTRS>`, 'g')) ?? [];
  assert.equal(boxes.length, 1);
  assert.match(boxes[0], /class="fopt"/);
  // Controlled, so the box always shows the applied filter.
  assert.match(boxes[0], /:model-value="Boolean\(/);
});

test('the glyphs stay inline SVG; no view hand-writes a Material span', () => {
  for (const [file, { svgs }] of Object.entries(views)) {
    assert.deepEqual(
      markup[file].match(/material-symbols-outlined/g) ?? [],
      [],
      file,
    );
    assert.equal(markup[file].match(/<svg\b/g)?.length, svgs, file);
  }
});
