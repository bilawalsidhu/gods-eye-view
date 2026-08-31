/**
 * Tests for the URL view state.
 *
 * The parsing and formatting are pure and are tested directly. The two functions that touch
 * Cesium's camera are tested against a fake one, for the same reason as everywhere else in
 * this suite: a real camera needs a WebGL context. `Cartesian3.fromDegrees` passes degrees
 * straight through so a test can read back what reached the camera.
 *
 * Half of what follows is hostile input. A hash is whatever was in somebody's address bar,
 * and the requirement is that a nonsensical one opens the globe at its default view rather
 * than throwing on the first paint.
 *
 * What a fake cannot prove is that a pasted link actually reproduces a view in a fresh tab.
 * That is a real browser reading a real address bar, and it belongs to the Playwright suite
 * in phase 9.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('cesium', () => ({
  Cartesian3: {
    fromDegrees: (lon: number, lat: number, height?: number) => ({
      x: lon,
      y: lat,
      z: height ?? 0,
    }),
  },
}));

const {
  DEFAULT_HEADING_DEG,
  DEFAULT_PITCH_DEG,
  MAXIMUM_ALTITUDE_M,
  applyCameraView,
  cameraView,
  formatViewHash,
  parseViewHash,
  trackViewInUrl,
} = await import('./url');

const DEG_PER_RAD = 180 / Math.PI;

const LONDON = {
  lon: -0.12,
  lat: 51.5,
  altitudeM: 2_400_000,
  headingDeg: DEFAULT_HEADING_DEG,
  pitchDeg: DEFAULT_PITCH_DEG,
};

interface SetView {
  destination: { x: number; y: number; z: number };
  orientation: { heading: number; pitch: number; roll: number };
}

/** A fake camera, plus handles on what was asked of it. */
function fakeCamera(view = LONDON) {
  const views: SetView[] = [];
  const listeners = new Set<() => void>();
  return {
    views,
    listeners,
    camera: {
      positionCartographic: {
        longitude: view.lon / DEG_PER_RAD,
        latitude: view.lat / DEG_PER_RAD,
        height: view.altitudeM,
      },
      heading: view.headingDeg / DEG_PER_RAD,
      pitch: view.pitchDeg / DEG_PER_RAD,
      setView(options: SetView): void {
        views.push(options);
      },
      moveEnd: {
        addEventListener(listener: () => void): () => void {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  };
}

function asCamera(fake: ReturnType<typeof fakeCamera>['camera']): Parameters<typeof cameraView>[0] {
  return fake as unknown as Parameters<typeof cameraView>[0];
}

describe('formatViewHash', () => {
  it('writes longitude first, matching every contract in this project', () => {
    // Latitude first would look right to anyone used to a mapping site, which is exactly
    // how the other four bounding-box conventions in this tree cost an afternoon each.
    expect(formatViewHash(LONDON)).toBe('#lon=-0.12&lat=51.5&alt=2400000');
  });

  it('leaves out a north-up straight-down camera, which is most of them', () => {
    expect(formatViewHash({ ...LONDON, headingDeg: 45, pitchDeg: -30 })).toBe(
      '#lon=-0.12&lat=51.5&alt=2400000&heading=45&pitch=-30',
    );
  });

  it('rounds to something a person could read out', () => {
    const hash = formatViewHash({
      lon: -0.123456,
      lat: 51.499999,
      altitudeM: 2_400_000.678,
      headingDeg: 12.3456,
      pitchDeg: -44.444,
    });

    expect(hash).toBe('#lon=-0.12346&lat=51.5&alt=2400001&heading=12.3&pitch=-44.4');
  });

  it('names the layers that are switched off', () => {
    expect(formatViewHash(LONDON, ['military', 'vessels'])).toBe(
      '#lon=-0.12&lat=51.5&alt=2400000&off=military,vessels',
    );
  });
});

describe('parseViewHash', () => {
  it('reads back what it wrote', () => {
    const view = { ...LONDON, headingDeg: 45.3, pitchDeg: -30.2 };

    const parsed = parseViewHash(formatViewHash(view, ['satellites']));

    expect(parsed.camera).toEqual(view);
    expect(parsed.hidden).toStrictEqual(['satellites']);
  });

  it('defaults a missing orientation to north up and straight down', () => {
    const parsed = parseViewHash('#lon=-0.12&lat=51.5&alt=2400000');

    expect(parsed.camera?.headingDeg).toBe(DEFAULT_HEADING_DEG);
    expect(parsed.camera?.pitchDeg).toBe(DEFAULT_PITCH_DEG);
  });

  it('works with or without the leading hash', () => {
    expect(parseViewHash('lon=1&lat=2&alt=3').camera?.lon).toBe(1);
  });

  it('has no camera at all in an empty hash', () => {
    expect(parseViewHash('')).toEqual({ camera: null, hidden: [] });
  });

  it('drops half a camera rather than filling the gap in', () => {
    // A guessed altitude over somebody else's longitude is a view nobody chose.
    expect(parseViewHash('#lon=-0.12&lat=51.5').camera).toBeNull();
    expect(parseViewHash('#lat=51.5&alt=1000').camera).toBeNull();
    expect(parseViewHash('#lon=-0.12&alt=1000').camera).toBeNull();
  });

  it('drops a camera that is not numbers', () => {
    expect(parseViewHash('#lon=abc&lat=51.5&alt=1000').camera).toBeNull();
    expect(parseViewHash('#lon=&lat=51.5&alt=1000').camera).toBeNull();
    expect(parseViewHash('#lon=NaN&lat=51.5&alt=1000').camera).toBeNull();
    expect(parseViewHash('#lon=1e999&lat=51.5&alt=1000').camera).toBeNull();
  });

  it('drops a latitude or an altitude that cannot mean anything', () => {
    expect(parseViewHash('#lon=0&lat=91&alt=1000').camera).toBeNull();
    expect(parseViewHash('#lon=0&lat=-91&alt=1000').camera).toBeNull();
    expect(parseViewHash('#lon=0&lat=0&alt=0').camera).toBeNull();
    expect(parseViewHash('#lon=0&lat=0&alt=-1000').camera).toBeNull();
    const tooHigh = parseViewHash(`#lon=0&lat=0&alt=${String(MAXIMUM_ALTITUDE_M + 1)}`);
    expect(tooHigh.camera).toBeNull();
  });

  it('wraps a longitude and a heading, because both have an unambiguous reading', () => {
    const parsed = parseViewHash('#lon=190&lat=0&alt=1000&heading=-90');

    expect(parsed.camera?.lon).toBe(-170);
    expect(parsed.camera?.headingDeg).toBe(270);
    expect(parseViewHash('#lon=-190&lat=0&alt=1000&heading=450').camera?.lon).toBe(170);
    expect(parseViewHash('#lon=0&lat=0&alt=1000&heading=450').camera?.headingDeg).toBe(90);
  });

  it('clamps a pitch rather than throwing the whole camera away for it', () => {
    expect(parseViewHash('#lon=0&lat=0&alt=1000&pitch=-400').camera?.pitchDeg).toBe(-90);
    expect(parseViewHash('#lon=0&lat=0&alt=1000&pitch=400').camera?.pitchDeg).toBe(90);
  });

  it('keeps the layer list even when the camera is nonsense', () => {
    // The two halves are independent: a bad camera must not lose the layer switches.
    expect(parseViewHash('#lon=abc&off=military').hidden).toStrictEqual(['military']);
  });

  it('tidies the layer list', () => {
    const parsed = parseViewHash('#off=Military,,%20vessels%20,military');

    expect(parsed.hidden).toStrictEqual(['military', 'vessels']);
  });
});

describe('cameraView', () => {
  it('reports degrees, because the radians stop at Cesium', () => {
    const fake = fakeCamera({ ...LONDON, headingDeg: 45, pitchDeg: -30 });

    const view = cameraView(asCamera(fake.camera));

    expect(view.lon).toBeCloseTo(-0.12, 9);
    expect(view.lat).toBeCloseTo(51.5, 9);
    expect(view.altitudeM).toBe(2_400_000);
    expect(view.headingDeg).toBeCloseTo(45, 9);
    expect(view.pitchDeg).toBeCloseTo(-30, 9);
  });
});

describe('applyCameraView', () => {
  it('sends degrees back as radians and keeps roll level', () => {
    const fake = fakeCamera();

    applyCameraView(asCamera(fake.camera), { ...LONDON, headingDeg: 45, pitchDeg: -30 });

    expect(fake.views).toHaveLength(1);
    expect(fake.views[0]?.destination).toEqual({ x: -0.12, y: 51.5, z: 2_400_000 });
    expect(fake.views[0]?.orientation.heading).toBeCloseTo(Math.PI / 4, 12);
    expect(fake.views[0]?.orientation.pitch).toBeCloseTo(-Math.PI / 6, 12);
    expect(fake.views[0]?.orientation.roll).toBe(0);
  });

  it('round-trips a camera through a hash', () => {
    const fake = fakeCamera({ ...LONDON, headingDeg: 45, pitchDeg: -30 });
    const camera = asCamera(fake.camera);
    const parsed = parseViewHash(formatViewHash(cameraView(camera)));
    expect(parsed.camera).not.toBeNull();

    applyCameraView(camera, parsed.camera!);

    // This is acceptance criterion 6 in miniature: what the URL carried is what the camera
    // is pointed at. The pasted-link half of it needs a real browser.
    expect(fake.views[0]?.destination).toEqual({ x: -0.12, y: 51.5, z: 2_400_000 });
    expect(fake.views[0]?.orientation.heading).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe('trackViewInUrl', () => {
  it('writes the camera and the hidden layers when the user stops moving', () => {
    const fake = fakeCamera();
    const written: string[] = [];
    trackViewInUrl({
      camera: asCamera(fake.camera),
      hidden: () => ['military'],
      write: (hash) => {
        written.push(hash);
      },
    });

    for (const listener of fake.listeners) {
      listener();
    }

    expect(written).toStrictEqual(['#lon=-0.12&lat=51.5&alt=2400000&off=military']);
  });

  it('stays quiet while follow mode is driving the camera', () => {
    const fake = fakeCamera();
    const written: string[] = [];
    trackViewInUrl({
      camera: asCamera(fake.camera),
      hidden: () => [],
      suspended: () => true,
      write: (hash) => {
        written.push(hash);
      },
    });

    for (const listener of fake.listeners) {
      listener();
    }

    // A followed aircraft moves the camera continuously. Recording that would overwrite the
    // view the user chose and hammer an API browsers throttle.
    expect(written).toStrictEqual([]);
  });

  it('records on demand, for a change the camera did not make', () => {
    const fake = fakeCamera();
    const written: string[] = [];
    const state = trackViewInUrl({
      camera: asCamera(fake.camera),
      hidden: () => ['vessels'],
      write: (hash) => {
        written.push(hash);
      },
    });

    // Switching a layer off does not move the camera, so the toggle has to say so itself.
    state.record();

    expect(written).toStrictEqual(['#lon=-0.12&lat=51.5&alt=2400000&off=vessels']);
  });

  it('writes into the address bar without adding a history entry', () => {
    const fake = fakeCamera();
    const calls: unknown[][] = [];
    vi.stubGlobal('window', {
      history: {
        replaceState: (...args: unknown[]) => {
          calls.push(args);
        },
      },
    });

    trackViewInUrl({ camera: asCamera(fake.camera), hidden: () => [] }).record();

    // `replaceState`, not `pushState`: panning the globe must not fill the back button with
    // camera positions.
    expect(calls).toStrictEqual([[null, '', '#lon=-0.12&lat=51.5&alt=2400000']]);
    vi.unstubAllGlobals();
  });

  it('stops listening', () => {
    const fake = fakeCamera();
    const written: string[] = [];
    const state = trackViewInUrl({
      camera: asCamera(fake.camera),
      hidden: () => [],
      write: (hash) => {
        written.push(hash);
      },
    });

    state.stop();
    for (const listener of fake.listeners) {
      listener();
    }

    expect(fake.listeners.size).toBe(0);
    expect(written).toStrictEqual([]);
  });
});
