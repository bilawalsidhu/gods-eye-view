import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { INFRA_LOD_ACTIVE_MAX } from '../../../data/localGeojsonLod.js';

const KEY = 'gevInfrastructureStems';
const views = new WeakSet();
/** All visible stems use one draw and one fixed buffer; tips are a point bank. */
export function createStemBatch({ view, MeshDesc }, color) {
  if (!views.has(view)) {
    view.registerMesh(
      KEY,
      class extends MeshDesc {
        constructor(host, ctx, config) {
          super(host, ctx, config);
          this.batch = config[KEY];
        }
        getPassKey() {
          return 'transparent';
        }
        createMesh() {
          return this.batch.line;
        }
        onDestroy() {
          this.batch.dispose();
          super.onDestroy();
        }
      },
    );
    views.add(view);
  }
  const xyz = new Float32Array(6 * INFRA_LOD_ACTIVE_MAX);
  const geometry = new LineSegmentsGeometry().setPositions(xyz);
  geometry.instanceCount = 0;
  const material = new LineMaterial({
    color,
    linewidth: 3.5,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });
  const line = new LineSegments2(geometry, material);
  line.frustumCulled = false;
  const holder = view.addMesh({
    [KEY]: {
      line,
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    },
  });
  return {
    set(records, origin) {
      let at = 0;
      for (const { base, tip } of records)
        for (const p of [base, tip]) {
          xyz[at++] = p.x - origin.x;
          xyz[at++] = p.y - origin.y;
          xyz[at++] = p.z - origin.z;
        }
      line.position.set(origin.x, origin.y, origin.z);
      line.updateMatrix();
      line.matrixWorldNeedsUpdate = true;
      geometry.instanceCount = records.length;
      geometry.attributes.instanceStart.data.needsUpdate = true;
    },
    destroy: () => holder.delete(),
  };
}
