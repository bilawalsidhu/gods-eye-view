import * as Cesium from 'cesium';

/** Native ground geometry is expensive even when its Entity.show is false. */
export function cableViewportPass(viewer) {
  const camera = viewer?.camera;
  if (
    !camera?.frustum?.computeCullingVolume ||
    !camera.positionWC ||
    !camera.directionWC ||
    !camera.upWC ||
    (viewer.scene?.mode != null &&
      viewer.scene.mode !== Cesium.SceneMode.SCENE3D)
  )
    return null;
  const volume = camera.frustum.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  );
  const globe = new Cesium.Occluder(
    new Cesium.BoundingSphere(
      Cesium.Cartesian3.ZERO,
      Cesium.Ellipsoid.WGS84.minimumRadius,
    ),
    camera.positionWC,
  );
  const scratch = new Cesium.BoundingSphere();
  const pixelScale =
    (2 * Math.tan((camera.frustum.fov || Math.PI / 3) / 2)) /
    Math.max(1, viewer.scene.canvas?.clientHeight || 1080);
  return {
    visible(record, resident) {
      const entity = record.entity;
      let bound = record.viewportSphere;
      const line = Boolean(
        record.segmentOptions || (entity?.polyline && !record.tip),
      );
      if (!bound) {
        const positions =
          record.positions ||
          (line
            ? entity.polyline.positions?.getValue(Cesium.JulianDate.now())
            : entity?.polygon?.hierarchy?.getValue(Cesium.JulianDate.now())
                ?.positions);
        bound = record.viewportSphere = positions?.length
          ? Cesium.BoundingSphere.fromPoints(positions)
          : new Cesium.BoundingSphere(record.base, 0);
        // A rhumb arc bows outside the chord through its supplied vertices.
        // Keep a conservative guard so coarse/dateline segments aren't culled.
        if (positions?.length) {
          let longest = 0;
          for (let i = 1; i < positions.length; i++)
            longest = Math.max(
              longest,
              Cesium.Cartesian3.distance(positions[i - 1], positions[i]),
            );
          bound.radius += longest;
        }
      }
      if (record.tip) {
        Cesium.Cartesian3.midpoint(record.base, record.tip, bound.center);
        bound.radius = Cesium.Cartesian3.distance(record.base, record.tip) / 2;
      }
      if (!globe.isBoundingSphereVisible(bound)) return false;
      Cesium.BoundingSphere.clone(bound, scratch);
      // Wider keep margin prevents rebuilding ground batches at the edge.
      scratch.radius +=
        Cesium.Cartesian3.distance(camera.positionWC, bound.center) *
        pixelScale *
        (line ? (resident ? 64 : 16) : resident ? 256 : 128);
      return volume.computeVisibility(scratch) !== Cesium.Intersect.OUTSIDE;
    },
  };
}

/** Keep identity/properties/picking globally; attach only the visible render entities. */
export function syncCableResidency(source, entity, visible, viewer) {
  if (!source?.entities?.contains) {
    entity.show = visible;
    return;
  }
  const resident = source.entities.contains(entity);
  if (visible || viewer.selectedEntity === entity) {
    entity.show = visible;
    if (!resident) source.entities.add(entity);
  } else if (resident) {
    // Cesium's static ground batches don't clear queued show changes on
    // remove(). Hiding and removing together leaves updateShows with a stale
    // geometry ID. Collection removal alone releases the offscreen visual.
    source.entities.remove(entity);
  }
}

/** Split along the same rhumb arc; preserve every supplied vertex. */
export function splitCablePositions(positions, maxDistance = 500_000) {
  if (!positions?.length) return [];
  const chunks = [],
    rhumb = new Cesium.EllipsoidRhumbLine();
  let chunk = [positions[0]],
    distance = 0;
  for (let i = 1; i < positions.length; i++) {
    rhumb.setEndPoints(
      Cesium.Cartographic.fromCartesian(positions[i - 1]),
      Cesium.Cartographic.fromCartesian(positions[i]),
    );
    const length = rhumb.surfaceDistance;
    const steps = Math.max(1, Math.ceil(length / maxDistance));
    for (let step = 1; step <= steps; step++) {
      const point =
        step === steps
          ? positions[i]
          : Cesium.Ellipsoid.WGS84.cartographicToCartesian(
              rhumb.interpolateUsingFraction(step / steps),
            );
      if (chunk.length > 1 && distance + length / steps > maxDistance + 0.001) {
        chunks.push(chunk);
        chunk = [chunk.at(-1)];
        distance = 0;
      }
      chunk.push(point);
      distance += length / steps;
      if (distance >= maxDistance) {
        chunks.push(chunk);
        chunk = [point];
        distance = 0;
      }
    }
  }
  if (chunk.length > 1) chunks.push(chunk);
  return chunks;
}

/** Global route descriptors stay cheap; only visible segments get native ground buffers. */
export function cableSegmentRecords(
  entity,
  feature,
  source,
  info,
  classificationType,
) {
  const time = Cesium.JulianDate.now(),
    line = entity.polyline;
  const options = {
    material: Cesium.Color.clone(line.material.getValue(time).color),
    width: line.width.getValue(time),
    arcType: line.arcType?.getValue(time),
    clampToGround: true,
    classificationType,
  };
  return splitCablePositions(line.positions.getValue(time)).map(
    (positions, index) => ({
      id: index === 0 ? entity.id : `${entity.id}__view_${index}`,
      source,
      entity: null,
      positions,
      segmentOptions: options,
      properties: feature.properties,
      info,
      base: positions[0],
      viewportSphere: rhumbPositionBounds(positions),
    }),
  );
}

/** Every curve point is within one <=50 km arc step of a sampled point. */
export function rhumbPositionBounds(positions) {
  const sampled = [positions[0]],
    rhumb = new Cesium.EllipsoidRhumbLine();
  let longestStep = 0;
  for (let i = 1; i < positions.length; i++) {
    rhumb.setEndPoints(
      Cesium.Cartographic.fromCartesian(positions[i - 1]),
      Cesium.Cartographic.fromCartesian(positions[i]),
    );
    const steps = Math.max(1, Math.ceil(rhumb.surfaceDistance / 50000));
    longestStep = Math.max(longestStep, rhumb.surfaceDistance / steps);
    for (let step = 1; step < steps; step++)
      sampled.push(
        Cesium.Ellipsoid.WGS84.cartographicToCartesian(
          rhumb.interpolateUsingFraction(step / steps),
        ),
      );
    sampled.push(positions[i]);
  }
  const sphere = Cesium.BoundingSphere.fromPoints(sampled);
  // Triangle inequality bounds unsampled arcs. Also cover terrain relief.
  sphere.radius += longestStep + 12000;
  return sphere;
}

/** Materialize visible route segments and release offscreen native entities without discarding route data. */
export function syncCableSegment(record, visible, viewer) {
  if (visible && !record.entity) {
    record.entity = new Cesium.Entity({
      id: record.id,
      name: record.info.label,
      properties: record.properties,
      polyline: { ...record.segmentOptions, positions: record.positions },
    });
    record.entity.__gevTeleGeography = record.info;
  }
  if (!record.entity) return;
  syncCableResidency(record.source, record.entity, visible, viewer);
  if (!visible && viewer.selectedEntity !== record.entity) record.entity = null;
}
