/** Shared Radio layer test stand-ins: a station row, fake Audio, directory fetch and viewer. */
import { radioLayer } from '../data/radio.js';

/** One accepted Radio Browser directory row. */
export function radioStationRow(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Station',
    lat: 30,
    lon: -97,
    streamUrl: 'https://radio.example.com/station.mp3',
    homepage: null,
    tags: ['news'],
    languages: ['English'],
    state: 'Texas',
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: 'MP3',
    bitrate: 128,
    ...overrides,
  };
}

/**
 * Run `body` against an enabled `radioLayer` that serves `stations`.
 * Streams listed in `failingUrls` (mutable) reject play(); `body` receives the
 * played URLs and the catalog, whose rows and generation the next update() serves.
 */
export async function withRadioLayer({ stations, failingUrls = [] }, body) {
  const originalFetch = globalThis.fetch;
  const originalAudio = globalThis.Audio;
  const playUrls = [];
  const catalog = { rows: stations, generation: 1 };
  globalThis.Audio = class FakeAudio {
    constructor() {
      this.volume = 0.8;
      this.src = '';
    }

    addEventListener() {}
    pause() {}
    play() {
      playUrls.push(this.src);
      if (failingUrls.includes(this.src)) {
        return Promise.reject(
          new DOMException('unavailable', 'NotSupportedError'),
        );
      }
      return Promise.resolve();
    }
    removeAttribute() {
      this.src = '';
    }
    load() {}
  };
  globalThis.fetch = async (url) =>
    String(url).startsWith('/api/radio/click/')
      ? { ok: true }
      : new Response(
          JSON.stringify({
            stations: catalog.rows,
            stale: false,
            degraded: false,
            acceptedGeneration: catalog.generation,
            catalogInstance: 'qa-instance-a',
            updatedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: {
      canvas: {
        disableRootEvents: true,
        onwheel: null,
        addEventListener() {},
        removeEventListener() {},
      },
    },
    dataSources: { add() {}, remove() {} },
    entities: {
      add(entity) {
        return entity;
      },
      remove() {},
    },
  };
  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    await radioLayer.update();
    await body({ playUrls, catalog });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = originalAudio;
    radioLayer.destroy();
  }
}
