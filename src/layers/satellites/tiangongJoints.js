/**
 * Tiangong's joint and dock-marker nodes, as the model file carries them in
 * each node's glTF `extras` (the model build's joints.json, copied here; the
 * app reads this table, never the file's extras). Root frame, meters: glTF +X
 * port, +Y zenith, +Z forward. Every driven joint is a node with an identity
 * rest transform whose moving mesh hangs beneath it, so a turn of `angle` about
 * `axis` through `pivot` is `issAxisMatrix(pivot, axis, angle)`, as for the ISS.
 * `kind`: alpha (a wing's drive about its boom), beta (a lab wing's turn about
 * its own axis, under its alpha), arm (the two robotic arms, seven joints
 * each, base to tip), antenna (the high-gain dish, rest boresight +Y), dock (a
 * docking port's outer face, not driven: `axis` is a docked vehicle's
 * direction, `rangeDeg` null). `approximate` marks the model author's
 * estimates against published dimensions.
 * @type {ReadonlyArray<Readonly<{node: string, pivot: number[], axis: number[],
 *   kind: 'alpha'|'beta'|'arm'|'antenna'|'dock', rangeDeg: number[]|null,
 *   approximate: boolean, parent: string}>>}
 */
export const TIANGONG_JOINTS = Object.freeze(
  [
    [
      'TIANHE_ARRAY_PORT_ALPHA',
      [1.4, 0, -6.7],
      [1, 0, 0],
      'alpha',
      [-180, 180],
      false,
      'tiangong',
    ],
    [
      'TIANHE_ARRAY_STBD_ALPHA',
      [-1.4, 0, -6.7],
      [-1, 0, 0],
      'alpha',
      [-180, 180],
      false,
      'tiangong',
    ],
    [
      'TIANHE_HGA',
      [0, 2.4, -6],
      [0, 1, 0],
      'antenna',
      [-90, 90],
      true,
      'tiangong',
    ],
    ['DOCK_FORWARD', [0, 0, 8.3], [0, 0, 1], 'dock', null, false, 'tiangong'],
    ['DOCK_AFT', [0, 0, -8.3], [0, 0, -1], 'dock', null, false, 'tiangong'],
    ['DOCK_NADIR', [0, -2, 6.4], [0, -1, 0], 'dock', null, true, 'tiangong'],
    ['DOCK_ZENITH', [0, 2, 6.4], [0, 1, 0], 'dock', null, true, 'tiangong'],
    ['BERTH_PORT', [2.1, 0, 6.4], [1, 0, 0], 'dock', null, true, 'tiangong'],
    ['BERTH_STBD', [-2.1, 0, 6.4], [-1, 0, 0], 'dock', null, true, 'tiangong'],
    [
      'WENTIAN_ARRAY_FWD_ALPHA',
      [-18.9, 0, 6.9],
      [-1, 0, 0],
      'alpha',
      [-180, 180],
      false,
      'tiangong',
    ],
    [
      'WENTIAN_ARRAY_FWD_BETA',
      [-18.9, 0, 7.7],
      [0, 0, 1],
      'beta',
      [-180, 180],
      false,
      'WENTIAN_ARRAY_FWD_ALPHA',
    ],
    [
      'WENTIAN_ARRAY_AFT_ALPHA',
      [-18.9, 0, 5.9],
      [-1, 0, 0],
      'alpha',
      [-180, 180],
      false,
      'tiangong',
    ],
    [
      'WENTIAN_ARRAY_AFT_BETA',
      [-18.9, 0, 5.1],
      [0, 0, -1],
      'beta',
      [-180, 180],
      false,
      'WENTIAN_ARRAY_AFT_ALPHA',
    ],
    [
      'MENGTIAN_ARRAY_FWD_ALPHA',
      [18.9, 0, 6.9],
      [1, 0, 0],
      'alpha',
      [-180, 180],
      false,
      'tiangong',
    ],
    [
      'MENGTIAN_ARRAY_FWD_BETA',
      [18.9, 0, 7.7],
      [0, 0, 1],
      'beta',
      [-180, 180],
      false,
      'MENGTIAN_ARRAY_FWD_ALPHA',
    ],
    [
      'MENGTIAN_ARRAY_AFT_ALPHA',
      [18.9, 0, 5.9],
      [1, 0, 0],
      'alpha',
      [-180, 180],
      false,
      'tiangong',
    ],
    [
      'MENGTIAN_ARRAY_AFT_BETA',
      [18.9, 0, 5.1],
      [0, 0, -1],
      'beta',
      [-180, 180],
      false,
      'MENGTIAN_ARRAY_AFT_ALPHA',
    ],
    [
      'CMM_SHR',
      [0.5, 1.9, 3.6],
      [0, 1, 0],
      'arm',
      [-270, 270],
      true,
      'tiangong',
    ],
    [
      'CMM_SHY',
      [0.5, 2.3, 3.6],
      [0, 0, 1],
      'arm',
      [-270, 270],
      true,
      'CMM_SHR',
    ],
    [
      'CMM_SHP',
      [0.5, 2.7, 3.6],
      [1, 0, 0],
      'arm',
      [-270, 270],
      true,
      'CMM_SHY',
    ],
    [
      'CMM_EP',
      [0.5, 2.7, -0.9],
      [1, 0, 0],
      'arm',
      [-270, 270],
      true,
      'CMM_SHP',
    ],
    ['CMM_WP', [0.5, 3.3, 3.6], [1, 0, 0], 'arm', [-270, 270], true, 'CMM_EP'],
    ['CMM_WY', [0.5, 3.3, 4.1], [0, 1, 0], 'arm', [-270, 270], true, 'CMM_WP'],
    ['CMM_WR', [0.5, 3.3, 4.6], [0, 0, 1], 'arm', [-270, 270], true, 'CMM_WY'],
    [
      'EMM_SHR',
      [-6, 2.3, 6.4],
      [0, 1, 0],
      'arm',
      [-270, 270],
      true,
      'tiangong',
    ],
    [
      'EMM_SHY',
      [-6, 2.55, 6.4],
      [1, 0, 0],
      'arm',
      [-270, 270],
      true,
      'EMM_SHR',
    ],
    [
      'EMM_SHP',
      [-6, 2.85, 6.4],
      [0, 0, 1],
      'arm',
      [-270, 270],
      true,
      'EMM_SHY',
    ],
    ['EMM_EP', [-8, 2.85, 6.4], [0, 0, 1], 'arm', [-270, 270], true, 'EMM_SHP'],
    ['EMM_WP', [-6, 3.2, 6.4], [0, 0, 1], 'arm', [-270, 270], true, 'EMM_EP'],
    ['EMM_WY', [-5.7, 3.2, 6.4], [0, 1, 0], 'arm', [-270, 270], true, 'EMM_WP'],
    ['EMM_WR', [-5.4, 3.2, 6.4], [1, 0, 0], 'arm', [-270, 270], true, 'EMM_WY'],
    [
      'SHENZHOU_FORWARD_ARRAY_PORT_ALPHA',
      [1.4, 0, 15.1],
      [1, 0, 0],
      'alpha',
      [-180, 180],
      true,
      'SHENZHOU_FORWARD',
    ],
    [
      'SHENZHOU_FORWARD_ARRAY_STBD_ALPHA',
      [-1.4, 0, 15.1],
      [-1, -0, -0],
      'alpha',
      [-180, 180],
      true,
      'SHENZHOU_FORWARD',
    ],
    [
      'SHENZHOU_NADIR_ARRAY_PORT_ALPHA',
      [1.4, -8.8, 6.4],
      [1, 0, 0],
      'alpha',
      [-180, 180],
      true,
      'SHENZHOU_NADIR',
    ],
    [
      'SHENZHOU_NADIR_ARRAY_STBD_ALPHA',
      [-1.4, -8.8, 6.4],
      [-1, -0, -0],
      'alpha',
      [-180, 180],
      true,
      'SHENZHOU_NADIR',
    ],
    [
      'TIANZHOU_AFT_ARRAY_PORT_ALPHA',
      [1.4, 0, -16.6],
      [1, 0, 0],
      'alpha',
      [-180, 180],
      true,
      'TIANZHOU_AFT',
    ],
    [
      'TIANZHOU_AFT_ARRAY_STBD_ALPHA',
      [-1.4, 0, -16.6],
      [-1, -0, -0],
      'alpha',
      [-180, 180],
      true,
      'TIANZHOU_AFT',
    ],
  ].map(([node, pivot, axis, kind, rangeDeg, approximate, parent]) =>
    Object.freeze({
      node,
      pivot: Object.freeze(pivot),
      axis: Object.freeze(axis),
      kind,
      rangeDeg: rangeDeg && Object.freeze(rangeDeg),
      approximate,
      parent,
    }),
  ),
);

const BY_NODE = new Map(TIANGONG_JOINTS.map((joint) => [joint.node, joint]));

/**
 * One joint by node name.
 * @param {string} node
 * @returns {(typeof TIANGONG_JOINTS)[number]}
 */
export function tiangongJoint(node) {
  const joint = BY_NODE.get(node);
  if (!joint) throw new Error(`Tiangong has no joint ${node}`);
  return joint;
}

/** The visiting vehicles' mesh nodes; hiding one hides its arrays with it. */
export const TIANGONG_VEHICLE_NODES = Object.freeze([
  'SHENZHOU_FORWARD',
  'SHENZHOU_NADIR',
  'TIANZHOU_AFT',
]);
