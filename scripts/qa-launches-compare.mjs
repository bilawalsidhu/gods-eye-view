#!/usr/bin/env node
import fs from 'node:fs';
const [left, right] = process.argv
  .slice(2)
  .map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
if (!left || !right) throw new Error('Supply Cesium and Navara launch reports');
const errors = [];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
let positionMaxM = 0,
  cameraMaxM = 0,
  cameraMaxDegrees = 0,
  pointMaxPx = 0,
  anchorMaxM = 0;
for (const stage of ['all', 'pad']) {
  const a = left.snapshots[stage].drawn,
    b = right.snapshots[stage].drawn;
  for (const p of a.points) {
    const q = b.points.find((q) => q.id === p.id);
    if (!q) {
      errors.push(`Missing ${p.id}`);
      continue;
    }
    positionMaxM = Math.max(positionMaxM, distance(p.position, q.position));
  }
  for (const key of ['paths', 'rings'])
    for (const p of a[key]) {
      const q = b[key].find((q) => q.id === p.id);
      if (!q) {
        errors.push(`Missing ${p.id}`);
        continue;
      }
      for (let i = 0; i < p.anchors.length; i++)
        anchorMaxM = Math.max(anchorMaxM, distance(p.anchors[i], q.anchors[i]));
    }
}
const compareCamera = (a, b) => {
  cameraMaxM = Math.max(cameraMaxM, distance(a.position, b.position));
  for (const key of ['heading', 'pitch', 'roll'])
    cameraMaxDegrees = Math.max(
      cameraMaxDegrees,
      (Math.abs(
        Math.atan2(Math.sin(a[key] - b[key]), Math.cos(a[key] - b[key])),
      ) *
        180) /
        Math.PI,
    );
};
compareCamera(left.snapshots.pad.camera, right.snapshots.pad.camera);
for (let i = 2; i < 12; i++) {
  const a = left.timeline.checkpoints[i],
    b = right.timeline.checkpoints[i];
  if (a.elapsed !== b.elapsed) errors.push(`Different replay epoch ${i}`);
  compareCamera(a.camera, b.camera);
}
const visible = {};
for (const stage of ['global', 'city', 'orbit']) {
  const a = left.views[stage],
    b = right.views[stage];
  visible[stage] = [
    a.points.filter((p) => p.show).length,
    b.points.filter((p) => p.show).length,
  ];
  if (visible[stage][0] !== visible[stage][1])
    errors.push(`Visible counts differ at ${stage}`);
  for (const p of a.points) {
    const q = b.points.find((q) => q.id === p.id);
    if (!q) {
      errors.push(`Missing ${p.id}`);
      continue;
    }
    if (p.screen && q.screen)
      pointMaxPx = Math.max(
        pointMaxPx,
        Math.hypot(p.screen.x - q.screen.x, p.screen.y - q.screen.y),
      );
    else if (Boolean(p.screen) !== Boolean(q.screen))
      errors.push(`Projection presence differs ${p.id}`);
    if (
      p.size !== q.size ||
      JSON.stringify(p.color) !== JSON.stringify(q.color)
    )
      errors.push(`Marker style differs ${p.id}`);
  }
}
if (cameraMaxM > 1 || cameraMaxDegrees > 0.1)
  errors.push('Replay/focus camera exceeds 1m/0.1deg');
if (positionMaxM > 0.001 || anchorMaxM > 0.001)
  errors.push('Frozen geometry differs by more than 1mm');
if (pointMaxPx > 2)
  errors.push('Projected known points differ by more than 2px');
if (JSON.stringify(left.voice.records) !== JSON.stringify(right.voice.records))
  errors.push('Analyst records differ');
for (const report of [left, right])
  if (report.checks.some((c) => !c.ok))
    errors.push(`${report.engine} has failed checks`);
console.log(
  JSON.stringify(
    {
      ok: !errors.length,
      errors,
      positionMaxM,
      anchorMaxM,
      cameraMaxM,
      cameraMaxDegrees,
      pointMaxPx,
      visible,
    },
    null,
    2,
  ),
);
if (errors.length) process.exitCode = 1;
