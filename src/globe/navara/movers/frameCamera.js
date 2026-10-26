// One camera snapshot per Navara frame, shared by its mover sets. A camera
// command or resize within the frame invalidates it too. Nonstandard parented
// or manually managed cameras retain the uncached path.
const EARTH_RADIUS_M = 6_371_000;

export function createMoverFrameCamera(view) {
  const frame = {
    cameraPosition: { x: 0, y: 0, z: 0 },
    cameraDirection: { x: 0, y: 0, z: -1 },
    cameraHeight: 0,
    fovDeg: 60,
    viewportHeightPx: 0,
    pixelRatio: 1,
  };
  const previous = {};
  return (ctx, time) => {
    const raw = view.camera.raw;
    const renderer = ctx?.getRenderer();
    const height = renderer?.domElement.clientHeight;
    if (!raw || !(height > 0)) return null;
    const p = raw.position,
      q = raw.quaternion,
      scale = raw.scale;
    const dpr = renderer.getPixelRatio?.() ?? 1;
    const cacheable =
      Number.isFinite(time) &&
      !raw.parent &&
      raw.matrixAutoUpdate !== false &&
      raw.matrixWorldAutoUpdate !== false &&
      scale.x === 1 &&
      scale.y === 1 &&
      scale.z === 1;
    if (
      cacheable &&
      previous.time === time &&
      previous.raw === raw &&
      previous.renderer === renderer &&
      previous.x === p.x &&
      previous.y === p.y &&
      previous.z === p.z &&
      previous.qx === q.x &&
      previous.qy === q.y &&
      previous.qz === q.z &&
      previous.qw === q.w &&
      frame.fovDeg === raw.fov &&
      frame.viewportHeightPx === height &&
      frame.pixelRatio === dpr
    )
      return frame;
    raw.updateMatrixWorld();
    const e = raw.matrixWorld.elements;
    const position = frame.cameraPosition;
    position.x = e[12];
    position.y = e[13];
    position.z = e[14];
    const direction = frame.cameraDirection;
    const length = Math.hypot(e[8], e[9], e[10]) || 1;
    direction.x = -e[8] / length;
    direction.y = -e[9] / length;
    direction.z = -e[10] / length;
    frame.cameraHeight =
      Math.hypot(position.x, position.y, position.z) - EARTH_RADIUS_M;
    frame.fovDeg = raw.fov;
    frame.viewportHeightPx = height;
    frame.pixelRatio = dpr;
    previous.time = cacheable ? time : undefined;
    previous.raw = raw;
    previous.renderer = renderer;
    previous.x = p.x;
    previous.y = p.y;
    previous.z = p.z;
    previous.qx = q.x;
    previous.qy = q.y;
    previous.qz = q.z;
    previous.qw = q.w;
    return frame;
  };
}
