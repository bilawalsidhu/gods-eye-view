import { ensure } from './helpers.mjs';

export function clockChecks(engine, { until }) {
  return [
    [
      'clock.frameTime: one frame time per frame, latched before preUpdate, never decreasing',
      async () => {
        const records = [];
        const read = (name) =>
          records.push({
            name,
            frame: engine.clock.frameTime(),
            now: engine.clock.now(),
          });
        const removers = ['preUpdate', 'preRender', 'postRender'].map((name) =>
          engine.frames[name].addEventListener(() => read(name)),
        );
        try {
          await until(
            () =>
              records.filter(({ name }) => name === 'postRender').length >= 3,
            'three drawn frames',
          );
        } finally {
          for (const remove of removers) remove();
        }
        ensure(
          Number.isFinite(engine.clock.now()) &&
            Number.isFinite(engine.clock.frameTime()),
          'clock.now or clock.frameTime is not a number',
        );
        // From the first preUpdate on: every frame event reads the frame time
        // its frame's preUpdate read, and that time never goes back.
        const start = records.findIndex(({ name }) => name === 'preUpdate');
        ensure(start >= 0, 'frames.preUpdate never fired');
        let frame = null;
        for (const record of records.slice(start)) {
          ensure(
            record.frame <= record.now,
            `${record.name}: frameTime ${record.frame} is after now ${record.now}`,
          );
          if (record.name === 'preUpdate') {
            ensure(
              frame === null || record.frame >= frame.frame,
              `frame time went back from ${frame?.frame} to ${record.frame}`,
            );
            frame = record;
            continue;
          }
          ensure(
            record.frame === frame.frame,
            `${record.name} read frame time ${record.frame}, its frame's is ${frame.frame}`,
          );
        }
      },
    ],
  ];
}

export function clockLatchChecks(engine, { settle }) {
  return [
    [
      'clock.frameTime: advances before the next preUpdate',
      async () => {
        await settle();
        const before = engine.clock.frameTime();
        let observed;
        const remove = engine.frames.preUpdate.addEventListener(() => {
          observed ??= engine.clock.frameTime();
        });
        try {
          await settle();
          ensure(
            observed > before,
            `preUpdate read stale frame time ${observed}, previous ${before}`,
          );
        } finally {
          remove();
        }
      },
    ],
  ];
}
