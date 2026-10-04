'use strict';

const fs = require('node:fs');

const DEFAULT_SIZE = Object.freeze({ width: 1440, height: 900 });
const MIN_SIZE = Object.freeze({ width: 960, height: 600 });

/** Whether the rectangle overlaps at least `margin` pixels of any display. */
function visibleOnSomeDisplay(bounds, displays, margin = 80) {
  return displays.some(({ workArea: area }) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y);
    return overlapX >= margin && overlapY >= margin;
  });
}

/**
 * Validate a saved window state against the current displays. Anything
 * malformed or off-screen (a disconnected monitor) falls back to defaults.
 * @returns {{x?: number, y?: number, width: number, height: number, maximized: boolean}}
 */
function sanitizeState(saved, displays) {
  const fallback = { ...DEFAULT_SIZE, maximized: false };
  if (!saved || typeof saved !== 'object') return fallback;
  const numbers = ['x', 'y', 'width', 'height'].every((key) =>
    Number.isFinite(saved[key]),
  );
  if (!numbers) return fallback;
  const width = Math.max(MIN_SIZE.width, Math.round(saved.width));
  const height = Math.max(MIN_SIZE.height, Math.round(saved.height));
  const bounds = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width,
    height,
  };
  if (!visibleOnSomeDisplay(bounds, displays)) return fallback;
  return { ...bounds, maximized: saved.maximized === true };
}

function loadState(file, displays) {
  try {
    return sanitizeState(JSON.parse(fs.readFileSync(file, 'utf8')), displays);
  } catch {
    return sanitizeState(null, displays);
  }
}

function saveState(file, window) {
  try {
    const maximized = window.isMaximized();
    const bounds = maximized ? window.getNormalBounds() : window.getBounds();
    fs.writeFileSync(file, JSON.stringify({ ...bounds, maximized }));
  } catch {
    // Window geometry is a convenience, never a failure.
  }
}

module.exports = {
  DEFAULT_SIZE,
  MIN_SIZE,
  loadState,
  sanitizeState,
  saveState,
  visibleOnSomeDisplay,
};
