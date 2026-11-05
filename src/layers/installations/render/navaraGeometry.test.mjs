import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh, MeshLambertMaterial } from 'three';
import * as geo from '../../../geo/index.js';
import {
  createInstallationDrapedMesh,
  createInstallationOutlineDrapedMesh,
  INSTALLATION_DRAPE_DEPTH_M,
} from './navaraGeometry.js';

const record = {
  id: 'osm:way:12',
  longitude: 179.9,
  latitude: 70,
};
const texture = { value: null };
class TestDrapedMesh extends Mesh {
  constructor(geometry, material) {
    super(geometry, material);
    this.drapedEnable = true;
  }
}

test('installation footprint becomes an engine DrapedMesh with hole and ground refs', () => {
  const mesh = createInstallationDrapedMesh(
    record,
    [
      [
        [179.88, 69.99],
        [179.92, 69.99],
        [179.92, 70.01],
        [179.88, 70.01],
      ],
      [
        [179.895, 69.995],
        [179.905, 69.995],
        [179.905, 70.005],
        [179.895, 70.005],
      ],
    ],
    {
      color: '#9ca6b0',
      opacity: 0.22,
      globeNormal: texture,
      globeDepth: texture,
      DrapedMesh: TestDrapedMesh,
      setupMaterialForDrape: (material, normal, depth) => {
        material.userData.drapeRefs = [normal, depth];
      },
    },
  );

  assert.ok(mesh instanceof TestDrapedMesh);
  assert.ok(mesh.material instanceof MeshLambertMaterial);
  assert.equal(mesh.userData.installationId, record.id);
  assert.equal(mesh.geometry.parameters.shapes.holes.length, 1);
  mesh.geometry.computeBoundingBox();
  assert.equal(
    mesh.geometry.boundingBox.max.z - mesh.geometry.boundingBox.min.z,
    INSTALLATION_DRAPE_DEPTH_M,
  );
  assert.deepEqual(mesh.material.userData.drapeRefs, [texture, texture]);
  assert.equal(mesh.matrixAutoUpdate, false);
  assert.deepEqual(
    [
      mesh.matrix.elements[12],
      mesh.matrix.elements[13],
      mesh.matrix.elements[14],
    ],
    Object.values(
      geo.cartesian3.fromDegrees(record.longitude, record.latitude),
    ),
  );
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test('invalid installation footprint rings do not allocate a mesh', () => {
  assert.equal(
    createInstallationDrapedMesh(
      record,
      [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      {
        color: '#9ca6b0',
        globeNormal: texture,
        globeDepth: texture,
        DrapedMesh: TestDrapedMesh,
        setupMaterialForDrape() {},
      },
    ),
    null,
  );
});

test('ordinary installation outlines are draped ribbons across the date line', () => {
  const mesh = createInstallationOutlineDrapedMesh(
    record,
    [
      [179.88, 69.99],
      [-179.92, 69.99],
      [-179.92, 70.01],
      [179.88, 70.01],
      [179.88, 69.99],
    ],
    {
      color: '#9ca6b0',
      widthM: 12,
      globeNormal: texture,
      globeDepth: texture,
      DrapedMesh: TestDrapedMesh,
      setupMaterialForDrape: (material, normal, depth) => {
        material.userData.drapeRefs = [normal, depth];
      },
    },
  );

  assert.ok(mesh instanceof TestDrapedMesh);
  assert.equal(mesh.userData.installationOutline, true);
  assert.equal(mesh.geometry.parameters.shapes.holes.length, 1);
  mesh.geometry.computeBoundingBox();
  assert.ok(
    mesh.geometry.boundingBox.max.x - mesh.geometry.boundingBox.min.x < 20_000,
  );
  assert.equal(
    mesh.geometry.boundingBox.max.z - mesh.geometry.boundingBox.min.z,
    INSTALLATION_DRAPE_DEPTH_M,
  );
  assert.deepEqual(mesh.material.userData.drapeRefs, [texture, texture]);
  mesh.geometry.dispose();
  mesh.material.dispose();
});
