import KDBush from 'kdbush';

const HALF_BOX = 13 / 2 + 42;
const MINIMUM = 3;

/** Preserve the native point pool's FIFO reuse after visibility changes. */
export function createRadioPointOrder() {
  const slots = [];
  const indices = new Map();
  const free = [];
  const remove = (record) => {
    const id = record.station.id;
    const index = indices.get(id);
    if (index === undefined) return;
    slots[index] = null;
    indices.delete(id);
    free.push(index);
  };
  return {
    update(records, visible = true) {
      for (const record of records) {
        if (!visible || !record.visible) {
          remove(record);
          continue;
        }
        const id = record.station.id;
        let index = indices.get(id);
        if (index === undefined) {
          index = free.length ? free.shift() : slots.length;
          indices.set(id, index);
        }
        slots[index] = record;
      }
      return slots.filter(Boolean);
    },
    clear(records) {
      // PointVisualizer releases a removed entity collection in reverse order.
      for (const record of [...records].reverse()) remove(record);
    },
    reset() {
      slots.length = 0;
      indices.clear();
      free.length = 0;
    },
  };
}

/**
 * Radio's point-only EntityCluster semantics, independent of a scene SDK.
 * The native oracle test covers seed order, inclusive range edges and the
 * retained-cluster zoom-in rule. Bounding boxes use the unscaled 13px point,
 * as Cesium does; outlines and distance scaling do not expand this box.
 */
export function clusterRadioPoints({
  records,
  project,
  horizonVisible,
  height,
  previousHeight,
  previousClusters = [],
}) {
  const points = [];
  for (const record of records) {
    if (!record.visible || !horizonVisible(record.position)) continue;
    const screen = project(record.position);
    if (screen) points.push({ record, screen, used: false });
  }
  const clusters = [];
  const singletons = [];
  if (!points.length) return { clusters, singletons };
  // Match the native index's traversal order as well as its range membership:
  // the first member of a retained cluster is the direct-click station.
  const index = new KDBush(points.length, 64, Float64Array);
  for (const { screen } of points) index.add(screen.x, screen.y);
  index.finish();
  const membersIn = (left, top, right, bottom) =>
    index
      .range(left, top, right, bottom)
      .map((i) => points[i])
      .filter((point) => !point.used);
  const consume = (members) => {
    for (const point of members) point.used = true;
    return members.map(({ record }) => record.station.id);
  };

  if (height < previousHeight) {
    const factor = 1 - height / previousHeight;
    for (const previous of previousClusters) {
      if (!horizonVisible(previous.position)) continue;
      const center = project(previous.position);
      if (!center) continue;
      const width = previous.width * factor;
      const boxWidth = Math.max(width, previous.minimumWidth);
      const boxHeight = Math.max(
        previous.height * factor,
        previous.minimumHeight,
      );
      // Native retained clusters use asymmetric right/bottom bounds.
      const members = membersIn(
        center.x - boxWidth / 2,
        center.y - boxHeight / 2,
        center.x + boxWidth,
        center.y + boxHeight,
      );
      if (members.length < MINIMUM) continue;
      clusters.push({
        ...previous,
        width,
        height: previous.height * factor,
        stationIds: consume(members),
      });
    }
  }

  for (const seed of points) {
    if (seed.used) continue;
    seed.used = true;
    const { x, y } = seed.screen;
    const seedLeft = x - 13 / 2 - 42;
    const seedTop = y - 13 / 2 - 42;
    const members = [
      seed,
      ...membersIn(
        seedLeft,
        seedTop,
        seedLeft + HALF_BOX * 2,
        seedTop + HALF_BOX * 2,
      ),
    ];
    if (members.length < MINIMUM) {
      singletons.push(seed.record.station.id);
      continue;
    }
    const sum = { ...seed.record.position };
    let left = seedLeft,
      top = seedTop;
    let width = HALF_BOX * 2,
      boxHeight = HALF_BOX * 2;
    for (const point of members.slice(1)) {
      const { position } = point.record;
      sum.x += position.x;
      sum.y += position.y;
      sum.z += position.z;
      const nextLeft = point.screen.x - 13 / 2 - 42;
      const nextTop = point.screen.y - 13 / 2 - 42;
      const right = Math.max(left + width, nextLeft + HALF_BOX * 2);
      const bottom = Math.max(top + boxHeight, nextTop + HALF_BOX * 2);
      left = Math.min(left, nextLeft);
      top = Math.min(top, nextTop);
      width = right - left;
      boxHeight = bottom - top;
    }
    const inverseCount = 1 / members.length;
    clusters.push({
      position: {
        x: sum.x * inverseCount,
        y: sum.y * inverseCount,
        z: sum.z * inverseCount,
      },
      stationIds: consume(members),
      width,
      height: boxHeight,
      minimumWidth: HALF_BOX * 2,
      minimumHeight: HALF_BOX * 2,
    });
  }
  return { clusters, singletons };
}
