#!/usr/bin/env node
import fs from 'node:fs';
const [left, right] = process.argv
  .slice(2)
  .map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
if (!left || !right) throw new Error('Supply the Cesium and Navara reports');
const errors = [];
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ringMaxPx = Math.max(
  ...left.parity.ring.map((p, i) => near(p, right.parity.ring[i])),
);
const pointMaxPx = Math.max(
  ...left.parity.points.map((p) =>
    near(
      p.screen,
      right.parity.points.find((q) => q.id === p.id)?.screen ?? {
        x: Infinity,
        y: Infinity,
      },
    ),
  ),
);
if (ringMaxPx > 2) errors.push('Orbit anchors differ by >2px');
if (pointMaxPx > 2) errors.push('Known satellite points differ by >2px');
if (left.parity.shown !== right.parity.shown)
  errors.push('Different horizon-visible counts');
for (const view of ['city', 'orbit'])
  if (left.views[view].points !== right.views[view].points)
    errors.push(`${view} visible counts differ`);
let positionMaxM = 0;
for (const stage of ['core', 'dense', 'tracked', '40000', '45000']) {
  const byId = new Map(right.snapshots[stage].objects.map((o) => [o.id, o]));
  for (const a of left.snapshots[stage].objects) {
    const b = byId.get(a.id);
    if (!b) {
      errors.push(`Missing ${a.id}`);
      continue;
    }
    positionMaxM = Math.max(
      positionMaxM,
      Math.hypot(
        a.position.x - b.position.x,
        a.position.y - b.position.y,
        a.position.z - b.position.z,
      ),
    );
  }
}
let cameraMaxM = 0;
let cameraMaxDegrees = 0;
for (const stage of ['tracked', '40000', '45000']) {
  const a = left.snapshots[stage].camera,
    b = right.snapshots[stage].camera;
  for (const angle of ['heading', 'pitch', 'roll'])
    cameraMaxDegrees = Math.max(
      cameraMaxDegrees,
      (Math.abs(
        Math.atan2(
          Math.sin(a[angle] - b[angle]),
          Math.cos(a[angle] - b[angle]),
        ),
      ) *
        180) /
        Math.PI,
    );
  cameraMaxM = Math.max(
    cameraMaxM,
    Math.hypot(
      a.position.x - b.position.x,
      a.position.y - b.position.y,
      a.position.z - b.position.z,
    ),
  );
}
if (cameraMaxM > 1 || cameraMaxDegrees > 0.1)
  errors.push('Follow camera poses differ by >1m/0.1deg');
if (positionMaxM > 0.001) errors.push('Fixed-epoch positions differ');
for (const report of [left, right])
  if (report.checks.some((c) => !c.ok))
    errors.push(`${report.engine} has failed checks`);
console.log(
  JSON.stringify(
    {
      ok: !errors.length,
      errors,
      ringMaxPx,
      pointMaxPx,
      positionMaxM,
      cameraMaxM,
      cameraMaxDegrees,
      visible: left.parity.shown,
      denseP95: {
        cesium: left.densePerformance,
        navara: right.densePerformance,
      },
    },
    null,
    2,
  ),
);
if (errors.length) process.exitCode = 1;
