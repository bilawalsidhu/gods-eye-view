import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLASS_COLOURS,
  CLASS_LABELS,
  EMERGENCY_COLOUR,
  EMERGENCY_PIXEL_SIZE,
  POINT_PIXEL_SIZE,
  colourFor,
  pixelSizeFor,
} from './palette';

/**
 * The class list is read from the committed contract rather than repeated here.
 *
 * That is what makes this a totality check: a class added to the backend enum arrives in
 * `openapi.json`, and a missing colour fails here instead of rendering as an invisible
 * point on the globe.
 */
function contractAircraftClasses(): string[] {
  // Relative to the frontend workspace root, which is where vitest runs.
  const contract = path.resolve(process.cwd(), '../openapi.json');
  const schema = JSON.parse(readFileSync(contract, 'utf8')) as {
    components: { schemas: { AircraftClass: { enum: string[] } } };
  };
  return schema.components.schemas.AircraftClass.enum;
}

describe('the class palette', () => {
  it('covers every aircraft class in the contract', () => {
    const classes = contractAircraftClasses();

    const expected = classes.toSorted((left, right) => left.localeCompare(right));

    expect(classes.length).toBeGreaterThan(0);
    expect(Object.keys(CLASS_COLOURS).toSorted((a, b) => a.localeCompare(b))).toEqual(expected);
    expect(Object.keys(CLASS_LABELS).toSorted((a, b) => a.localeCompare(b))).toEqual(expected);
  });

  it('gives every class its own hue, so two classes are never confusable', () => {
    const hues = Object.values(CLASS_COLOURS);

    expect(new Set(hues).size).toBe(hues.length);
  });

  it('reserves the alert colour, so nothing routine is drawn in red', () => {
    expect(Object.values(CLASS_COLOURS)).not.toContain(EMERGENCY_COLOUR);
  });

  it('paints an emergency red whatever the class', () => {
    for (const aircraftClass of Object.keys(CLASS_COLOURS) as (keyof typeof CLASS_COLOURS)[]) {
      expect(colourFor(aircraftClass, true)).toBe(EMERGENCY_COLOUR);
      expect(colourFor(aircraftClass, false)).toBe(CLASS_COLOURS[aircraftClass]);
    }
  });

  it('also encodes an emergency in size, because colour alone is not accessible', () => {
    expect(pixelSizeFor(true, false)).toBe(EMERGENCY_PIXEL_SIZE);
    expect(EMERGENCY_PIXEL_SIZE).toBeGreaterThan(POINT_PIXEL_SIZE);
    // Emergency wins over selection: selecting an aircraft must not shrink its alert.
    expect(pixelSizeFor(true, true)).toBe(EMERGENCY_PIXEL_SIZE);
  });

  it('draws a selected aircraft larger than an unselected one', () => {
    expect(pixelSizeFor(false, true)).toBeGreaterThan(pixelSizeFor(false, false));
  });
});
