import { cartesian3, show, ensure } from './helpers.mjs';

export function meshChecks(
  engine,
  { settle, until, nadirView, readRegion, makeCanvas },
) {
  // Above any terrain under (20°E, 10°N), which stands about 400 m high.
  const positions = [
    [19.98, 10.02, 3000],
    [20.02, 10.02, 3000],
    [19.98, 9.98, 3000],
    [20.02, 9.98, 3000],
  ].flatMap((p) => {
    const at = cartesian3.fromDegrees(...p);
    return [at.x, at.y, at.z];
  });
  const options = {
    positions,
    indices: [0, 2, 1, 2, 3, 1],
    uv: [0, 1, 1, 1, 0, 0, 1, 0],
  };
  const centre = () => {
    const { width, height } = engine.host.size();
    return { x: width / 2, y: height / 2 };
  };
  const checks = [
    [
      'meshes.createMesh: copied triangles, visibility, updates and lifetime',
      async () => {
        const id = 'contract-mesh';
        const source = [...positions];
        const mesh = engine.meshes.createMesh({
          ...options,
          positions: source,
          id,
          show: false,
        });
        try {
          source.fill(0);
          ensure(engine.meshes.list().includes(id), 'mesh is not listed');
          ensure(mesh.show() === false, 'mesh starts hidden');
          mesh.show(true);
          ensure(mesh.show(), 'mesh did not show');
          mesh.update({ color: [0, 1, 1, 0.35], depthTest: 'always' });
          mesh.update({
            positions,
            indices: options.indices,
            depthTest: 'normal',
          });
          await settle();
          let rejected = false;
          try {
            mesh.update({ indices: [0, 1, 99] });
          } catch {
            rejected = true;
          }
          ensure(rejected, 'invalid indices were accepted');
          ensure(mesh.show(), 'invalid update changed visibility');
        } finally {
          mesh.destroy();
          mesh.destroy();
        }
        ensure(!engine.meshes.list().includes(id), 'destroyed mesh is listed');
        ensure(!mesh.show(), 'destroyed mesh is shown');
      },
    ],
    [
      'meshes.createMesh: picks use the live id and ignore hidden or unpickable triangles',
      async () => {
        await nadirView(10000);
        const id = 'contract-mesh-pick';
        const mesh = engine.meshes.createMesh({
          ...options,
          id,
          pickId: 'first',
        });
        try {
          await until(
            () => engine.picker.pick(centre())?.id === 'first',
            'mesh pick',
          );
          ensure(engine.picker.pick(centre()).owner === id, 'mesh owner');
          mesh.update({ pickId: 'second' });
          await until(
            () => engine.picker.pick(centre())?.id === 'second',
            'updated mesh pick',
          );
          mesh.show(false);
          await settle();
          ensure(
            engine.picker.pick(centre())?.owner !== id,
            'hidden mesh picked',
          );
          mesh.update({ show: true, pickId: null });
          await settle();
          ensure(
            engine.picker.pick(centre())?.owner !== id,
            'unpickable mesh picked',
          );
        } finally {
          mesh.destroy();
        }
      },
    ],
  ];
  if (readRegion && makeCanvas)
    checks.push([
      'meshes.createMesh: image pixels update on the same canvas',
      async () => {
        await nadirView(10000);
        const canvas = makeCanvas(8, 8);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 8, 8);
        const mesh = engine.meshes.createMesh({
          ...options,
          id: 'contract-mesh-image',
          image: canvas,
        });
        const pixel = () => {
          const { x, y } = centre();
          return readRegion(Math.floor(x), Math.floor(y), 1, 1);
        };
        try {
          await until(() => {
            const p = pixel();
            return p[0] > p[1] + 50;
          }, 'red mesh image');
          ctx.fillStyle = '#00ff00';
          ctx.fillRect(0, 0, 8, 8);
          mesh.update({ image: canvas });
          await until(() => {
            const p = pixel();
            return p[1] > p[0] + 50;
          }, 'updated green mesh image');
        } finally {
          mesh.destroy();
        }
      },
    ]);
  checks.push([
    'meshes.createMesh: a single colour draws as asked within 10 per channel',
    async () => {
      await nadirView(10000);
      const colour = [0, 1, 0, 1];
      const mesh = engine.meshes.createMesh({
        ...options,
        id: 'contract-mesh-colour',
        color: colour,
      });
      try {
        ensure(mesh.id === 'contract-mesh-colour', 'mesh id');
        if (!readRegion) return;
        await until(() => {
          const { x, y } = centre();
          const pixel = readRegion(Math.round(x), Math.round(y), 1, 1);
          return colour
            .slice(0, 3)
            .every((value, i) => Math.abs(pixel[i] - value * 255) <= 10);
        }, 'mesh colour within 10 per channel');
      } finally {
        mesh.destroy();
      }
    },
  ]);
  return checks;
}
