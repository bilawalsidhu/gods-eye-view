import * as THREE from 'three';
import { loadBundledJson } from '../data/bundledJson.js';
import { decodeRing } from '../data/adminBoundaries.js';
import {
  geoPosition,
  markerRadius,
  GLOBE_RADIUS,
  focusQuaternion,
} from './geo.js';
import { LAYERS } from './data.js';

/** Rasterize the repository's public-domain map pack; no map key or external tiles. */
async function earthTexture(signal) {
  const pack = await loadBundledJson(
    new URL('../data/local_data/natural_earth/countries.json', import.meta.url),
    { signal },
  );
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#091e30';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#244e59';
  ctx.strokeStyle = '#49828a';
  ctx.lineWidth = 0.7;
  for (const feature of pack.features)
    for (const polygon of feature.polygons) {
      for (const shift of [-2048, 0, 2048]) {
        ctx.beginPath();
        for (const encoded of polygon) {
          const ring = decodeRing(encoded, pack.meta.decimals);
          let previous = null,
            offset = 0;
          ring.forEach(([lon, lat], index) => {
            if (previous !== null) {
              if (lon - previous > 180) offset -= 360;
              if (lon - previous < -180) offset += 360;
            }
            previous = lon;
            const x = ((lon + offset + 180) / 360) * 2048 + shift,
              y = ((90 - lat) / 180) * 1024;
            if (index) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.closePath();
        }
        ctx.fill('evenodd');
        ctx.stroke();
      }
    }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function createGlobe({ scene, signal, onSelect, onStatus }) {
  const workspace = new THREE.Group();
  workspace.position.set(0, 1.3, -1.8);
  scene.add(workspace);
  const globe = new THREE.Group();
  workspace.add(globe);
  globe.quaternion.copy(focusQuaternion(20, -85));
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_RADIUS, 64, 40),
    new THREE.MeshStandardMaterial({
      color: '#87b6bc',
      roughness: 0.9,
      metalness: 0.1,
    }),
  );
  globe.add(sphere);
  earthTexture(signal)
    .then((texture) => {
      if (signal.aborted) {
        texture.dispose();
        return;
      }
      sphere.material.map = texture;
      sphere.material.color.set('#ffffff');
      sphere.material.needsUpdate = true;
    })
    .catch((error) => {
      if (!signal.aborted) onStatus(`Map unavailable: ${error.message}`);
    });
  const positions = [];
  const segment = (a, b) => positions.push(...a.toArray(), ...b.toArray());
  for (let lat = -60; lat <= 60; lat += 30)
    for (let lon = -180; lon < 180; lon += 3)
      segment(geoPosition(lat, lon, 0.602), geoPosition(lat, lon + 3, 0.602));
  for (let lon = -180; lon < 180; lon += 30)
    for (let lat = -90; lat < 90; lat += 3)
      segment(geoPosition(lat, lon, 0.602), geoPosition(lat + 3, lon, 0.602));
  const grid = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    ),
    new THREE.LineBasicMaterial({
      color: '#6199a5',
      transparent: true,
      opacity: 0.18,
    }),
  );
  globe.add(grid);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.618, 48, 32),
    new THREE.MeshBasicMaterial({
      color: '#60cdbf',
      transparent: true,
      opacity: 0.09,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  globe.add(halo);
  const selection = new THREE.Mesh(
    new THREE.RingGeometry(0.018, 0.023, 24),
    new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide }),
  );
  selection.visible = false;
  globe.add(selection);
  const layers = new Map(),
    targets = [sphere];
  const dummy = new THREE.Object3D();
  for (const layer of LAYERS) {
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({ color: layer.color }),
      1500,
    );
    mesh.count = 0;
    mesh.frustumCulled = false;
    globe.add(mesh);
    targets.push(mesh);
    mesh.userData.action = (input) => {
      const ray = input.ray?.hand ? input.ray : null;
      const raycaster = new THREE.Raycaster();
      raycaster.set(
        ray?.origin || input.controller.getWorldPosition(new THREE.Vector3()),
        ray?.direction ||
          input.controller.getWorldDirection(new THREE.Vector3()).negate(),
      );
      const hit = raycaster.intersectObjects([sphere, ...targets], false)[0];
      if (hit?.object === mesh) selectHit(hit);
    };
    layers.set(layer.id, { mesh, records: null });
  }
  function selectHit(hit) {
    const record = layers.get(hit?.object?.userData.layer)?.records?.[
      hit.instanceId
    ];
    if (!record) return false;
    const point = geoPosition(record.lat, record.lon, markerRadius(record));
    selection.position.copy(point);
    selection.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      point.clone().normalize(),
    );
    selection.visible = true;
    onSelect(record);
    return true;
  }
  return {
    workspace,
    globe,
    sphere,
    targets,
    selectHit,
    sync(states) {
      for (const [id, layer] of layers) {
        const state = states[id];
        layer.mesh.visible = state.enabled;
        layer.mesh.userData.layer = id;
        // Three's raycaster also tests invisible meshes. Zero instances makes
        // a disabled layer neither selectable nor an occluder for other feeds.
        layer.mesh.count = state.enabled ? state.records.length : 0;
        if (layer.records === state.records) continue;
        layer.records = state.records;
        state.records.forEach((record, index) => {
          dummy.position.copy(
            geoPosition(record.lat, record.lon, markerRadius(record)),
          );
          dummy.scale.setScalar(
            record.layer === 'earthquakes'
              ? 0.009
              : record.layer === 'satellites'
                ? 0.012
                : 0.006,
          );
          dummy.updateMatrix();
          layer.mesh.setMatrixAt(index, dummy.matrix);
        });
        layer.mesh.instanceMatrix.needsUpdate = true;
        // InstancedMesh caches its aggregate picking bounds. Rebuild them when
        // snapshots change, including a feed's first response after zero rows.
        layer.mesh.computeBoundingSphere();
      }
    },
    focus(lat, lon) {
      globe.quaternion.copy(focusQuaternion(lat, lon));
      selection.visible = false;
    },
    rotate(radians) {
      globe.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), radians);
    },
    scale(amount) {
      workspace.scale.setScalar(
        THREE.MathUtils.clamp(workspace.scale.x + amount, 0.5, 1.6),
      );
    },
    clearSelection() {
      selection.visible = false;
    },
    dispose() {
      workspace.traverse((object) => {
        object.geometry?.dispose();
        if (object.material) {
          object.material.map?.dispose();
          object.material.dispose();
        }
      });
      workspace.removeFromParent();
    },
  };
}
