import { cartesian3, ensure } from './helpers.mjs';
import { INPUT_TYPES, MODIFIERS } from '../../contract.js';

export function pickInputChecks(
  engine,
  { settle, until, nadirView, makeCanvas, pointer },
) {
  const { camera } = engine;
  return [
    [
      'input.on: picks on click and move payloads, drill, lines',
      async () => {
        await nadirView(1e6);
        const at = (lon, lat, height = 20_000) =>
          cartesian3.fromDegrees(lon, lat, height);
        const atlasCanvas = makeCanvas
          ? makeCanvas(16, 16)
          : { width: 16, height: 16 };
        if (makeCanvas) {
          const context = atlasCanvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, 16, 16);
        }
        const set = engine.movers.createSet({
          id: 'contract-picks',
          kind: 'sprite',
          capacity: 3,
          order: 100,
          depthTest: 'always',
          pickable: true,
          sprite: {
            atlas: { canvas: atlasCanvas, cells: { box: [0, 0, 1, 1] } },
            sizePx: 24,
          },
        });
        const quiet = engine.movers.createSet({
          id: 'contract-quiet',
          kind: 'sprite',
          capacity: 1,
          order: 100,
          depthTest: 'always',
          sprite: {
            atlas: { canvas: atlasCanvas, cells: { box: [0, 0, 1, 1] } },
            sizePx: 24,
          },
        });
        const line = engine.lines.createLine({
          id: 'contract-pick-line',
          widthPx: 8,
          color: [1, 1, 0, 1],
          pickId: 'line-1',
        });
        const clicks = [];
        const moves = [];
        const removers = [
          engine.input.on('click', (event) => clicks.push(event), {
            pick: true,
            drill: 8,
            pickWindow: { width: 9, height: 9 },
          }),
          engine.input.on('move', (event) => moves.push(event), {
            pick: true,
          }),
        ];
        try {
          const a = at(20, 10);
          const b = at(21, 10.5);
          set.set(0, { position: a, pickId: 'a', color: [1, 0, 1, 1] });
          set.set(1, { position: b, pickId: 'b', color: [1, 0, 1, 1] });
          set.set(2, { position: b, pickId: 'c', color: [1, 0, 1, 1] });
          set.setCount(3);
          set.commit();
          line.setPositions([at(19, 9), at(21, 9)]);
          const unpickable = at(19.5, 11);
          quiet.set(0, { position: unpickable, pickId: 'quiet' });
          quiet.setCount(1);
          quiet.commit();
          await settle(4);
          if (!pointer) return;
          const screen = (position) => engine.projector.worldToWindow(position);
          const clickAt = async (position) => {
            const before = clicks.length;
            const { x, y } = screen(position);
            await pointer.click(x, y);
            await until(() => clicks.length > before, 'a click payload');
            return clicks[clicks.length - 1];
          };
          const onA = await clickAt(a);
          ensure(
            onA.picked?.id === 'a' && onA.picked?.owner === 'contract-picks',
            `a click on sprite a picked ${JSON.stringify(onA.picked?.id)} of ${onA.picked?.owner}`,
          );
          ensure(onA.picked.instance === 0, `instance ${onA.picked.instance}`);
          const empty = await clickAt(at(18, 12));
          ensure(
            empty.picked === undefined || empty.picked.id === undefined,
            `a click on the map picked ${JSON.stringify(empty.picked?.id)}`,
          );
          const onB = await clickAt(b);
          const drilled = (onB.drilled ?? []).map(({ id }) => id);
          ensure(
            drilled.includes('b') && drilled.includes('c'),
            `two sprites in one place drilled ${JSON.stringify(drilled)}`,
          );
          const onQuiet = await clickAt(unpickable);
          ensure(
            onQuiet.picked?.owner !== 'contract-quiet' &&
              !(onQuiet.drilled ?? []).some(
                ({ owner }) => owner === 'contract-quiet',
              ),
            `a pickable: false sprite was picked (${JSON.stringify(onQuiet.picked?.id)})`,
          );
          const linePosition = at(20, 9);
          const lineCameraBefore = cartesian3.clone(
            engine.camera.pose().position,
          );
          const onLine = await clickAt(linePosition);
          ensure(
            onLine.picked?.id === 'line-1',
            `a click on the line picked ${JSON.stringify(onLine.picked?.id)}; ${
              onLine.picked?.id === 'line-1'
                ? ''
                : JSON.stringify({
                    event: onLine.position,
                    projectedNow: screen(linePosition),
                    directNow: engine.picker.pick(onLine.position)?.id,
                    drilled: (onLine.drilled ?? []).map(({ id }) => id),
                    cameraMovedM: cartesian3.distance(
                      lineCameraBefore,
                      engine.camera.pose().position,
                    ),
                  })
            }`,
          );
          const target = screen(a);
          const movesBefore = moves.length;
          await pointer.move(target.x + 1, target.y);
          await until(
            () => moves.length > movesBefore && moves.at(-1).picked?.id === 'a',
            'a hover payload over sprite a',
          );
        } finally {
          for (const remove of removers) remove();
          set.destroy();
          quiet.destroy();
          line.destroy();
        }
      },
    ],
  ];
}

export function pointerChecks(engine, { settle, pointer }) {
  const { camera } = engine;
  return [
    [
      'input.acquirePointer: exclusive subscriptions, release and camera gestures',
      async () => {
        const input = engine.input;
        const before = input.cameraInputsEnabled();
        const claim = input.acquirePointer();
        ensure(claim, 'no pointer claim');
        const removers = [];
        let ambient = 0,
          owned = 0;
        try {
          ensure(input.acquirePointer() === null, 'a second claim succeeded');
          ensure(
            input.cameraInputsEnabled() === before,
            'claim disabled camera gestures',
          );
          removers.push(input.on('click', () => ambient++));
          removers.push(input.on('click', () => owned++, { pointer: claim }));
          if (pointer) {
            await pointer.click(100, 100);
            await settle();
            ensure(owned === 1 && ambient === 0, 'exclusive click leaked');
          }
          claim.release();
          claim.release();
          if (pointer) {
            await pointer.click(100, 100);
            await settle();
            ensure(
              owned === 1 && ambient === 1,
              'released click stayed exclusive',
            );
          }
          const next = input.acquirePointer();
          ensure(next, 'release did not free the pointer');
          claim.release();
          ensure(
            input.acquirePointer() === null,
            'stale release freed its successor',
          );
          next.release();
        } finally {
          claim.release();
          for (const remove of removers) remove();
        }
      },
    ],
  ];
}

export function inputChecks(engine) {
  const { camera } = engine;
  return [
    [
      'input.on: every type subscribes and unsubscribes; camera inputs toggle',
      async () => {
        for (const type of INPUT_TYPES) {
          for (const modifier of [undefined, ...MODIFIERS]) {
            const off = engine.input.on(type, () => {}, { modifier });
            ensure(
              typeof off === 'function',
              `input.on('${type}', ${modifier}) returned no remover`,
            );
            off();
            off();
          }
        }
      },
    ],
    [
      'input.suspendCameraInputs: counted, the last resume restores the state before the first',
      async () => {
        const { input } = engine;
        const before = input.cameraInputsEnabled();
        ensure(
          typeof before === 'boolean',
          `cameraInputsEnabled() returned ${before}`,
        );
        const outer = input.suspendCameraInputs();
        const inner = input.suspendCameraInputs();
        try {
          ensure(
            typeof outer === 'function' && typeof inner === 'function',
            'suspendCameraInputs returned no resume',
          );
          ensure(!input.cameraInputsEnabled(), 'on under a suspension');
          inner();
          inner();
          ensure(
            !input.cameraInputsEnabled(),
            'an inner resume lifted the outer suspension',
          );
          outer();
          ensure(
            input.cameraInputsEnabled() === before,
            'last resume did not restore inputs',
          );
        } finally {
          inner();
          outer();
        }
      },
    ],
  ];
}
