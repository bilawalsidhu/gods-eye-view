import { drainWildlifeWork, WILDLIFE_WORK_UNIT } from './performance.js';
import { wildlifeIconicGroup } from './model.js';

/** Incremental billboard reconciliation, independent of Cesium and the DOM.
 * A refresh changes only added/removed contacts and properties that differ.
 * Position sampling and appearance construction run only for changed rows. */
export function createWildlifeBillboardModel({
  collection,
  pointById,
  positions,
  positionForRow,
  appearanceForGroup,
}) {
  const previous = new Map();

  function update(rows, options = {}) {
    return drainWildlifeWork(updateWork(rows, options));
  }

  function* updateWork(rows, { onOperations = null } = {}) {
    const nextIds = new Set();
    const result = { created: 0, removed: 0, updated: 0, writes: 0 };
    let visits = 0;
    for (const row of rows) {
      if (visits++ % WILDLIFE_WORK_UNIT === 0) yield 'billboard-update';
      const id = row.stableId;
      if (nextIds.has(id)) continue;
      nextIds.add(id);
      const group = wildlifeIconicGroup(row.iconic);
      const old = previous.get(id);
      const point = pointById.get(id);
      if (
        old &&
        point &&
        old.lat === row.lat &&
        old.lon === row.lon &&
        old.group === group
      )
        continue;
      const appearance =
        old && old.group === group ? old.appearance : appearanceForGroup(group);
      const positionChanged =
        !old || old.lat !== row.lat || old.lon !== row.lon;
      const position = positionChanged
        ? positionForRow(row)
        : positions.get(id);
      if (!point) {
        const options = { id: `wildlife:${id}`, position, ...appearance };
        pointById.set(id, collection.add(options));
        positions.set(id, position);
        result.created += 1;
        result.writes += Object.keys(options).length;
      } else {
        let writes = 0;
        if (positionChanged) {
          point.position = position;
          positions.set(id, position);
          writes += 1;
        }
        for (const key of Object.keys(appearance)) {
          // Cesium clones Color and NearFarScalar values on assignment. Our
          // last descriptor, rather than getter reference identity, records
          // whether the appearance has actually changed.
          if (old?.appearance?.[key] === appearance[key]) continue;
          point[key] = appearance[key];
          writes += 1;
        }
        result.writes += writes;
        if (writes) result.updated += 1;
      }
      previous.set(id, {
        lat: row.lat,
        lon: row.lon,
        group,
        appearance,
      });
    }
    for (const [id, point] of pointById) {
      if (visits++ % WILDLIFE_WORK_UNIT === 0) yield 'billboard-update';
      if (nextIds.has(id)) continue;
      collection.remove(point);
      pointById.delete(id);
      positions.delete(id);
      previous.delete(id);
      result.removed += 1;
    }
    onOperations?.({ billboardVisits: visits, billboardWrites: result.writes });
    return result;
  }

  function clear() {
    collection.removeAll();
    pointById.clear();
    positions.clear();
    previous.clear();
  }

  // Font readiness replaces just the cached texture. Never resample anchors,
  // clear the collection or allocate replacement billboards for this swap.
  function refreshImages(imageForGroup) {
    let writes = 0;
    for (const [id, old] of previous) {
      const point = pointById.get(id);
      const image = imageForGroup(old.group);
      if (!point || old.appearance.image === image) continue;
      point.image = image;
      old.appearance = { ...old.appearance, image };
      writes += 1;
    }
    return writes;
  }

  return { update, updateWork, clear, refreshImages };
}
