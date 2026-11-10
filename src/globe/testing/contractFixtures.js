// Deterministic inputs for the same checks used by the browser runner.
export function fakeContractOptions(engine) {
  const { fake } = engine;
  let consumed = -1;
  return {
    waitFrames: async (count) => {
      for (let i = 0; i < count; i++) {
        if (!engine.render.isContinuous() && consumed === fake.renderRequests)
          throw new Error('No frame requested');
        consumed = fake.renderRequests;
        fake.frame();
      }
    },
    pointer: {
      click: async (x, y) => fake.input('click', { position: { x, y } }),
      move: async (x, y) =>
        fake.input('move', {
          startPosition: { x: x - 1, y },
          endPosition: { x, y },
        }),
      drag: async (x, y, endX, endY) => {
        fake.input('down', { position: { x, y } });
        fake.input('move', {
          startPosition: { x, y },
          endPosition: { x: endX, y: endY },
        });
        fake.input('up', { position: { x: endX, y: endY } });
      },
    },
    resize: async (width, height) => fake.setSize(width, height),
    mapSources: {
      imagery: [{ kind: 'osm' }, { kind: 'esri-imagery' }],
      photoreal: { kind: 'photoreal' },
    },
    fixtures: {
      terrain: {
        surface: engine.surface,
        sample: (read) =>
          read
            ? fake.script('sampleTerrainMostDetailed', async (places) =>
                places.map(read),
              )
            : fake.unscript('sampleTerrainMostDetailed'),
      },
      failModel: (id, enabled) =>
        enabled
          ? fake.script(
              'moverFailed',
              (setId, index) =>
                setId === id &&
                (engine.kind === 'navara' ||
                  index === undefined ||
                  index === 0),
            )
          : fake.unscript('moverFailed'),
      tiles: true,
    },
  };
}
