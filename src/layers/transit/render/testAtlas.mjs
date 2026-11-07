// The transit glyph atlas for tests: every glyph's cell, laid out as the
// display's atlas lays them out, on a canvas that draws nothing.

import { imageAtlasLayout } from '../../shared/render/imageAtlas.js';
import { transitAtlasIcons } from './display.js';

export function transitAtlasLayout() {
  return imageAtlasLayout(
    transitAtlasIcons().map((key) => ({ key, width: 48, height: 48 })),
    { cell: 52, pad: 2 },
  );
}

export const transitTestAtlas = async () => {
  const layout = transitAtlasLayout();
  return {
    canvas: { width: layout.width, height: layout.height },
    cells: layout.cells,
  };
};
