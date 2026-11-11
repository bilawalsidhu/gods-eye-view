import { ensure } from './helpers.mjs';

export function renderChecks(engine, { settle }) {
  return [
    [
      'render.setContinuous: continuous mode toggles',
      async () => {
        const previous = engine.render.isContinuous();
        try {
          engine.render.setContinuous(true);
          ensure(
            engine.render.isContinuous() === true,
            'continuous not enabled',
          );
          engine.render.setContinuous(false);
          ensure(
            engine.render.isContinuous() === false,
            'continuous not disabled',
          );
        } finally {
          engine.render.setContinuous(previous);
        }
      },
    ],
    [
      'render.setSharpen: merges partial updates, rejects bad values, draws',
      async () => {
        const previous = engine.render.sharpen();
        const same = (expected, label) => {
          const actual = engine.render.sharpen();
          ensure(
            actual.enabled === expected.enabled &&
              actual.amount === expected.amount,
            `${label}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`,
          );
        };
        ensure(
          typeof previous.enabled === 'boolean' &&
            Number.isFinite(previous.amount),
          `sharpen() ${JSON.stringify(previous)} is not { enabled, amount }`,
        );
        try {
          engine.render.setSharpen({ enabled: true, amount: 1.7 });
          same({ enabled: true, amount: 1.7 }, 'after enabling');
          engine.render.sharpen().amount = 0;
          same({ enabled: true, amount: 1.7 }, 'sharpen() is a copy');
          // A frame with the sharpening on draws without errors.
          await settle(2);
          engine.render.setSharpen({ amount: 0.5 });
          same({ enabled: true, amount: 0.5 }, 'after an amount alone');
          engine.render.setSharpen({ enabled: false });
          same({ enabled: false, amount: 0.5 }, 'after disabling');
          for (const bad of [
            { enabled: 'yes' },
            { amount: -0.1 },
            { amount: Number.NaN },
            { amount: '1' },
          ]) {
            let error = null;
            try {
              engine.render.setSharpen(bad);
            } catch (caught) {
              error = caught;
            }
            ensure(
              error instanceof TypeError,
              `setSharpen(${JSON.stringify(bad)}) did not throw a TypeError`,
            );
          }
          same({ enabled: false, amount: 0.5 }, 'after rejected values');
          await settle(1);
        } finally {
          engine.render.setSharpen(previous);
          await settle(1);
        }
      },
    ],
  ];
}

export function contactSonarChecks(render, settle) {
  return [
    [
      'render.setContactSonar: (contactSonar) merges, copies, rejects bad values, draws',
      async () => {
        const previous = render.contactSonar();
        ensure(
          previous.enabled === false,
          `the sonar starts ${JSON.stringify(previous)}`,
        );
        try {
          render.setContactSonar({
            enabled: true,
            active: true,
            angleDeg: 90,
            range: 100,
            opacity: 40,
            sector: 30,
          });
          await settle(2);
          render.setContactSonar({ angleDeg: 180 });
          const state = render.contactSonar();
          ensure(
            state.enabled && state.active && state.angleDeg === 180,
            `after an angle alone: ${JSON.stringify(state)}`,
          );
          state.angleDeg = 0;
          ensure(
            render.contactSonar().angleDeg === 180,
            'contactSonar() is a copy',
          );
          for (const bad of [
            { enabled: 'yes' },
            { active: 1 },
            { angleDeg: Number.NaN },
            { range: 0 },
            { opacity: 101 },
            { sector: 0 },
            { sector: 400 },
          ]) {
            let error = null;
            try {
              render.setContactSonar(bad);
            } catch (caught) {
              error = caught;
            }
            ensure(
              error instanceof TypeError,
              `setContactSonar(${JSON.stringify(bad)}) did not throw a TypeError`,
            );
          }
          ensure(
            render.contactSonar().opacity === 40,
            'a rejected call changed the sonar',
          );
        } finally {
          render.setContactSonar(previous);
          await settle(1);
        }
      },
    ],
  ];
}

// The optional cloudCover capability (render.setCloudCover).

export function cloudCoverChecks(render, settle) {
  return [
    [
      'render.setCloudCover: (cloudCover) sets, copies, gives back, rejects bad values',
      async () => {
        const previous = render.cloudCover();
        try {
          render.setCloudCover({ coverage: 0.7 });
          ensure(render.cloudCover().coverage === 0.7, 'coverage not set');
          render.cloudCover().coverage = 0;
          ensure(
            render.cloudCover().coverage === 0.7,
            'cloudCover() is a copy',
          );
          await settle(2);
          render.setCloudCover({});
          ensure(render.cloudCover().coverage === 0.7, 'omitted keeps it');
          render.setCloudCover({ coverage: null });
          ensure(render.cloudCover().coverage === null, 'null: the engine own');
          for (const bad of [-0.1, 1.2, Number.NaN, '0.5']) {
            let error = null;
            try {
              render.setCloudCover({ coverage: bad });
            } catch (caught) {
              error = caught;
            }
            ensure(
              error instanceof TypeError,
              `setCloudCover(${bad}) did not throw a TypeError`,
            );
          }
          ensure(
            render.cloudCover().coverage === null,
            'after rejected values',
          );
        } finally {
          render.setCloudCover(previous);
          await settle(1);
        }
      },
    ],
  ];
}

// The optional bloom capability (render.setBloom).

export function bloomChecks(render, settle) {
  return [
    [
      'render.setBloom: (bloom) merges, copies, rejects bad values, draws',
      async () => {
        const previous = render.bloom();
        ensure(
          typeof previous.enabled === 'boolean' &&
            Number.isFinite(previous.strength),
          `bloom() ${JSON.stringify(previous)} is not { enabled, strength }`,
        );
        const same = (expected, label) => {
          const actual = render.bloom();
          ensure(
            actual.enabled === expected.enabled &&
              actual.strength === expected.strength,
            `${label}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`,
          );
        };
        try {
          render.setBloom({ enabled: true, strength: 0.8 });
          same({ enabled: true, strength: 0.8 }, 'after enabling');
          render.bloom().strength = 0;
          same({ enabled: true, strength: 0.8 }, 'bloom() is a copy');
          // A frame with the bloom on draws without errors.
          await settle(2);
          render.setBloom({ strength: 0.05 });
          same({ enabled: true, strength: 0.05 }, 'in the dead zone');
          render.setBloom({ enabled: false });
          same({ enabled: false, strength: 0.05 }, 'after disabling');
          for (const bad of [
            { enabled: 1 },
            { strength: -0.1 },
            { strength: 1.5 },
            { strength: Number.NaN },
          ]) {
            let error = null;
            try {
              render.setBloom(bad);
            } catch (caught) {
              error = caught;
            }
            ensure(
              error instanceof TypeError,
              `setBloom(${JSON.stringify(bad)}) did not throw a TypeError`,
            );
          }
          same({ enabled: false, strength: 0.05 }, 'after rejected values');
        } finally {
          render.setBloom(previous);
          await settle(1);
        }
      },
    ],
  ];
}

// The optional visualStyles capability (render.setStyle).

export function styleChecks(render, settle) {
  return [
    [
      'render.setStyle: (visualStyles) merges, copies, rejects bad values, draws',
      async () => {
        const names = render.visualStyles;
        ensure(
          names.length > 0 && new Set(names).size === names.length,
          `visualStyles ${JSON.stringify(names)} is not a list of names`,
        );
        const [name] = names;
        const previous = render.style(name);
        ensure(
          previous.intensity === 0,
          `${name} starts at intensity ${previous.intensity}`,
        );
        const [uniform] = Object.keys(previous.uniforms);
        try {
          render.setStyle(name, { intensity: 1 });
          ensure(render.style(name).intensity === 1, 'intensity not set');
          // A frame with the style on draws without errors.
          await settle(2);
          if (uniform) {
            render.setStyle(name, { uniforms: { [uniform]: 0.25 } });
            const state = render.style(name);
            ensure(
              state.intensity === 1 && state.uniforms[uniform] === 0.25,
              `after a uniform alone: ${JSON.stringify(state)}`,
            );
            state.uniforms[uniform] = 9;
            ensure(
              render.style(name).uniforms[uniform] === 0.25,
              'style() is a copy',
            );
          }
          render.setStyle(name, { intensity: 0.5 });
          ensure(render.style(name).intensity === 0.5, 'crossfade step');
          for (const [label, call] of [
            ['unknown style', () => render.setStyle('no-such-style', {})],
            ['intensity 2', () => render.setStyle(name, { intensity: 2 })],
            [
              'intensity -0.1',
              () => render.setStyle(name, { intensity: -0.1 }),
            ],
            [
              'unknown uniform',
              () => render.setStyle(name, { uniforms: { noSuchUniform: 1 } }),
            ],
            ...(uniform
              ? [
                  [
                    'NaN uniform',
                    () =>
                      render.setStyle(name, {
                        uniforms: { [uniform]: Number.NaN },
                      }),
                  ],
                ]
              : []),
          ]) {
            let error = null;
            try {
              call();
            } catch (caught) {
              error = caught;
            }
            ensure(
              error instanceof TypeError,
              `setStyle with ${label} did not throw a TypeError`,
            );
          }
          ensure(
            render.style(name).intensity === 0.5,
            'a rejected call changed the style',
          );
        } finally {
          render.setStyle(name, previous);
          await settle(1);
        }
      },
    ],
  ];
}

export function renderBehaviourChecks(engine, { waitFrames }) {
  return [
    [
      'render.maxTextureSize: a positive power of two',
      async () => {
        const size = engine.render.maxTextureSize();
        ensure(
          Number.isInteger(size) &&
            size > 0 &&
            Number.isInteger(Math.log2(size)),
          `texture limit ${size}`,
        );
      },
    ],
    [
      'render.request: a request inside preRender draws the next frame',
      async () => {
        const previous = engine.render.isContinuous();
        let drawn = 0;
        let requested = false;
        const removePre = engine.frames.preRender.addEventListener(() => {
          if (requested) return;
          requested = true;
          engine.render.request('contract-next-frame');
        });
        const removePost = engine.frames.postRender.addEventListener(
          () => drawn++,
        );
        try {
          engine.render.setContinuous(false);
          engine.render.request('contract-first-frame');
          await waitFrames(2);
          ensure(drawn >= 2, 'the request inside the frame was lost');
        } finally {
          removePre();
          removePost();
          engine.render.setContinuous(previous);
        }
      },
    ],
  ];
}
