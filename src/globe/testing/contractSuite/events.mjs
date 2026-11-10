import { ensure } from './helpers.mjs';
import { assertGlobeEngine } from '../../contract.js';

export function shapeChecks(engine) {
  return [
    [
      'kind: the engine has every contract capability',
      async () => {
        assertGlobeEngine(engine);
      },
    ],
    [
      'host.size: a positive CSS size',
      async () => {
        const { width, height } = engine.host.size();
        ensure(
          width > 0 && height > 0,
          `size ${width}x${height} is not positive`,
        );
      },
    ],
  ];
}

export function eventChecks(engine, { settle, until, nadirView }) {
  const { camera } = engine;
  return [
    [
      'frames.postRender: removed listeners are not called',
      async () => {
        await nadirView();
        let viaHandle = 0;
        let viaRemove = 0;
        const remove = camera.moveStart.addEventListener(() => viaHandle++);
        const listener = () => viaRemove++;
        engine.frames.postRender.addEventListener(listener);
        remove();
        ensure(
          engine.frames.postRender.removeEventListener(listener) === true,
          'removeEventListener did not report removal',
        );
        await nadirView(3e6);
        await settle(3);
        ensure(
          viaHandle === 0 && viaRemove === 0,
          'a removed listener was called',
        );
      },
    ],
    [
      'frames.preUpdate: preUpdate, preRender and postRender fire in order with timestamps',
      async () => {
        const order = [];
        const removers = ['preUpdate', 'preRender', 'postRender'].map((name) =>
          engine.frames[name].addEventListener((time) =>
            order.push([name, time]),
          ),
        );
        try {
          await until(
            () => order.some(([name]) => name === 'postRender'),
            'postRender',
          );
        } finally {
          for (const remove of removers) remove();
        }
        const firstPost = order.findIndex(([name]) => name === 'postRender');
        const frame = order.slice(0, firstPost + 1);
        const index = (name) => frame.map(([entry]) => entry).lastIndexOf(name);
        ensure(index('preRender') >= 0, 'preRender did not precede postRender');
        ensure(index('preUpdate') >= 0, 'preUpdate did not precede postRender');
        ensure(
          index('preUpdate') < index('preRender'),
          'preUpdate ran after preRender',
        );
        for (const [name, time] of order)
          ensure(
            Number.isFinite(time),
            `${name} timestamp ${time} is not a number`,
          );
      },
    ],
  ];
}

export function creditChecks(engine) {
  return [
    [
      'credits.addStatic: returns an idempotent remover',
      async () => {
        const remove = engine.credits.addStatic('Contract check', {
          onScreen: false,
        });
        ensure(typeof remove === 'function', 'addStatic returned no remover');
        remove();
        remove();
      },
    ],
  ];
}

export function listenerChecks(engine, { settle, until }) {
  return [
    [
      'frames.postRender: adding a listener twice registers it once',
      async () => {
        let once = 0;
        let twice = 0;
        const reference = () => once++;
        const listener = () => twice++;
        const removers = [
          engine.frames.postRender.addEventListener(reference),
          engine.frames.postRender.addEventListener(listener),
          engine.frames.postRender.addEventListener(listener),
        ];
        try {
          await until(() => once >= 2, 'postRender');
        } finally {
          for (const remove of removers) remove();
        }
        ensure(
          twice === once,
          `a listener added twice fired ${twice} times in ${once} frames`,
        );
        removers[1]();
        removers[2]();
        await settle(2);
        ensure(twice === once, 'a removed listener still fired');
      },
    ],
    [
      'frames.postRender: removal during dispatch skips the listener; re-adding keeps it',
      async () => {
        const event = engine.frames.postRender;
        const seen = [];
        const victim = () => seen.push('victim');
        const survivor = () => seen.push('survivor');
        let dispatches = 0;
        const remover = () => {
          dispatches++;
          if (dispatches !== 1) return;
          event.removeEventListener(victim);
          event.removeEventListener(survivor);
          event.addEventListener(survivor);
        };
        event.addEventListener(remover);
        event.addEventListener(victim);
        event.addEventListener(survivor);
        try {
          await until(() => dispatches >= 3, 'three postRender dispatches');
        } finally {
          for (const listener of [remover, victim, survivor])
            event.removeEventListener(listener);
        }
        ensure(
          !seen.includes('victim'),
          'a listener removed during dispatch ran',
        );
        ensure(
          seen.includes('survivor'),
          'a listener removed and re-added during dispatch was lost',
        );
      },
    ],
  ];
}

export function lifetimeChecks(engine) {
  return [
    [
      'isDestroyed: false while the engine lives',
      async () => {
        ensure(engine.isDestroyed() === false, 'a live engine is destroyed');
      },
    ],
  ];
}
