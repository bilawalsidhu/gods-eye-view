import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWildlifeSelectedLabel,
  buildWildlifeThumbnailEntry,
} from '../layers/wildlifeSightings/cards.js';
import {
  normalizeOverlayEntry,
  paintLaneForOverlayEntry,
} from './worldOverlay.js';
import {
  clearWorldOverlayTextMeasureCache,
  measureOverlayEntry,
  paintOverlayEntry,
} from './worldOverlayDraw.js';
import { WORLD_OVERLAY_STYLE } from './worldOverlayTokens.js';

function paintingContext(glyphWidth = 6) {
  const text = [];
  const fills = [];
  const strokes = [];
  const images = [];
  return {
    text,
    fills,
    strokes,
    images,
    measureText: (text) => ({ width: Array.from(text).length * glyphWidth }),
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    moveTo() {},
    lineTo() {},
    fillRect() {},
    fill() {
      fills.push(this.fillStyle);
    },
    stroke() {
      strokes.push(this.strokeStyle);
    },
    fillText(value) {
      text.push(value);
    },
    drawImage(...args) {
      images.push(args);
    },
  };
}

test('wildlife thumbnail titles paint a word-boundary ellipsis after normalization and width fitting', () => {
  for (const [commonName, glyphWidth, expected] of [
    ["Bullock's Oriole", 6, "BULLOCK'S…"],
    ['Great Blue Heron', 11, 'GREAT…'],
    ['Superlongunbrokentaxon', 6, 'SUPERLONGUNBRO…'],
  ]) {
    clearWorldOverlayTextMeasureCache();
    const entry = normalizeOverlayEntry('wildlife-sightings', {
      ...buildWildlifeThumbnailEntry(
        {
          stableId: 'inat:1',
          commonName,
          observedAt: 0,
          photo: {
            square:
              'https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg',
            licence: 'cc-by',
            attribution: 'Synthetic Photographer',
          },
        },
        0,
        { image: { width: 75, height: 75 } },
      ),
      position: { x: 1, y: 2, z: 3 },
    });
    const ctx = paintingContext(glyphWidth);
    entry._overlayLayout = measureOverlayEntry(ctx, entry);
    paintOverlayEntry(ctx, entry, {
      rect: {
        x: 10,
        y: 20,
        w: entry._overlayLayout.w,
        h: entry._overlayLayout.h,
      },
    });
    assert.equal(ctx.text[0], expected);
    assert.ok(ctx.measureText(ctx.text[0]).width <= 96);
    assert.ok(entry.accessibilityLabel.includes(commonName));
  }
});

test('selected thumbnails retain their image in the host selected chrome and lane, without a link line', () => {
  const entry = normalizeOverlayEntry('wildlife-sightings', {
    ...buildWildlifeThumbnailEntry(
      {
        stableId: 'inat:1',
        commonName: 'Synthetic bird',
        observedAt: 0,
        uri: 'https://www.inaturalist.org/observations/1',
        photo: {
          square:
            'https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg',
          licence: 'cc-by',
          attribution: 'Synthetic Photographer',
        },
      },
      0,
      { selected: true, image: { width: 75, height: 75 } },
    ),
    position: { x: 1, y: 2, z: 3 },
  });
  const ctx = paintingContext();
  entry._overlayLayout = measureOverlayEntry(ctx, entry);
  paintOverlayEntry(ctx, entry, {
    rect: {
      x: 10,
      y: 20,
      w: entry._overlayLayout.w,
      h: entry._overlayLayout.h,
    },
  });
  assert.equal(entry.selected, true);
  assert.equal(
    paintLaneForOverlayEntry(entry),
    paintLaneForOverlayEntry({ selected: true }),
  );
  assert.equal(entry._overlayLayout.thumbH, 72);
  assert.equal(ctx.images.length, 1);
  assert.ok(ctx.fills.includes(WORLD_OVERLAY_STYLE.selectedBackground));
  assert.ok(ctx.strokes.includes(WORLD_OVERLAY_STYLE.selectedBorder));
  assert.ok(!ctx.text.some((line) => String(line).includes('↗')));
});

test('selected wildlife names retain a bounded title with the host selected metrics', () => {
  for (const origin of ['inaturalist', 'acartia']) {
    clearWorldOverlayTextMeasureCache();
    const row = {
      stableId: `${origin}:1`,
      origin,
      commonName:
        'Synthetic bird with a very long common name that cannot widen the globe label',
      scientificName: 'Avis synthetica',
      iconic: 'Aves',
      photo: {
        square:
          'https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg',
        attribution:
          'Synthetic Photographer, full attribution belongs in the dialog',
        licence: 'cc-by',
      },
    };
    const entry = normalizeOverlayEntry('wildlife-sightings-selected', {
      ...buildWildlifeSelectedLabel(row),
      position: { x: 1, y: 2, z: 3 },
    });
    const fonts = [];
    const ctx = {
      font: '',
      measureText(text) {
        fonts.push(this.font);
        return { width: [...text].length * 6 };
      },
    };
    const layout = measureOverlayEntry(ctx, entry);
    assert.equal(entry.variant, 'label');
    assert.equal(
      entry.selected,
      true,
      'selected names use the host selected painter',
    );
    assert.equal(entry.protected, true);
    assert.equal(entry.paintLane, 'selected');
    assert.equal(
      paintLaneForOverlayEntry(entry),
      paintLaneForOverlayEntry({ selected: true }),
    );
    assert.equal(entry.pinned, false);
    assert.equal(entry.interactive, false);
    assert.equal(entry.placement, 'above');
    assert.deepEqual(entry.details, []);
    assert.equal(entry.image, null);
    assert.equal(layout.h, 31, 'shared selected title and padding');
    assert.ok(layout.w <= 264, `bounded name, got ${layout.w}px`);
    assert.deepEqual(fonts, [WORLD_OVERLAY_STYLE.fontSelected]);
  }
});
