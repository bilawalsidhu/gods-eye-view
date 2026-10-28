import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { rgbaFromCss } from '../../../shared/color.js';
import { createRendering } from './rendering.js';

test('Cesium installation outlines use a valid material and retain ground clamping', () => {
  const id = 'osm:way:980001';
  const footprint = [
    [-122.438, 37.758],
    [-122.402, 37.758],
    [-122.402, 37.782],
    [-122.438, 37.782],
  ];
  const record = {
    id,
    kind: 'installation',
    class: 'airfield',
    name: 'QA Airfield',
    latitude: 37.77,
    longitude: -122.42,
    footprint,
  };
  const state = {
    enabled: true,
    selectedId: null,
    records: [record],
    recordById: new Map([[id, record]]),
    renderedKeys: new Map(),
    dataSource: new Cesium.CustomDataSource('military-installations'),
    viewer: { scene: { globe: { show: false } } },
  };
  const services = {
    ground: { floorAltitudeM: () => 125, cachedGroundFloor: () => ({}) },
    anchors: { warmFireAnchorFloors: async () => false },
    render: { governorRequestRender() {} },
    context: {
      getSelectedEntityContext: () => null,
      registerEntityContext() {},
      removeEntityContextsForLayer() {},
      selectEntityContext() {},
    },
  };
  const parts = {
    model: {
      colorFor: () => rgbaFromCss('#ff8000'),
      installationSourceLabel: () => 'OpenStreetMap',
    },
  };
  Object.assign(
    parts,
    createRendering({ state, services, parts, source: {} }),
  );

  parts.renderRecords();

  const time = Cesium.JulianDate.now();
  const marker = state.dataSource.entities.getById(id);
  const outline = state.dataSource.entities.getById(`${id}:outline:0`);
  assert.equal(
    marker.point.heightReference.getValue(time),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.ok(outline.polyline.material instanceof Cesium.ColorMaterialProperty);
  assert.equal(outline.polyline.clampToGround.getValue(time), true);
  for (const position of outline.polyline.positions.getValue(time))
    assert.ok(
      Math.abs(
        Cesium.Cartographic.fromCartesian(position).height,
      ) < 0.01,
    );
});
