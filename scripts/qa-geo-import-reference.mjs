#!/usr/bin/env node
// Record offline: node scripts/qa-geo-import-reference.mjs --record
// Compare offline: node scripts/qa-geo-import-reference.mjs
// Positions: 1 cm height and 1e-7 degrees; colours: one 8-bit channel.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planImport } from '../src/data/geoImportPlan.js';
import * as geo from '../src/geo/index.js';
import { iconBox } from '../src/data/geoImportPins.js';

const directory = fileURLToPath(
  new URL('./fixtures/geo-import/', import.meta.url),
);
const referencePath = path.join(directory, 'reference.json');
const files = (await fs.readdir(directory))
  .filter((name) => /\.(kml|kmz|geojson)$/.test(name))
  .sort();
const tolerances = { degrees: 1e-7, metres: 0.01, color: 1 / 255 };
const openRing = (ring) => {
  const last = ring.at(-1);
  return ring.length > 1 &&
    Math.abs(ring[0][0] - last[0]) < 1e-7 &&
    Math.abs(ring[0][1] - last[1]) < 1e-7
    ? ring.slice(0, -1)
    : ring;
};
const worldPosition = (p) => {
  const c = geo.cartographic.fromCartesian(p);
  return [
    geo.math.toDegrees(c.longitude),
    geo.math.toDegrees(c.latitude),
    c.height,
  ];
};
function meshPositions(mesh) {
  const result = [];
  for (let i = 0; i < mesh.positions.length; i += 3)
    result.push(
      worldPosition({
        x: mesh.positions[i],
        y: mesh.positions[i + 1],
        z: mesh.positions[i + 2],
      }),
    );
  return result;
}
function area(positions, indices) {
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = Array.from(indices.slice(i, i + 3), (n) =>
      positions.slice(n * 3, n * 3 + 3),
    );
    const u = b.map((v, j) => v - a[j]),
      v = c.map((v, j) => v - a[j]);
    total +=
      Math.hypot(
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ) / 2;
  }
  return total;
}

async function record() {
  const { Window } = await import('happy-dom');
  const dom = new Window({ url: 'http://localhost/' });
  globalThis.document = dom.document;
  globalThis.DOMParser = dom.DOMParser;
  globalThis.XMLSerializer = dom.XMLSerializer;
  // happy-dom's XML namespace query misses KML elements Cesium reads.
  function byNamespace(namespace, localName) {
    return [...this.getElementsByTagName('*')].filter(
      (el) =>
        (localName === '*' || el.localName === localName) &&
        (namespace === '*' || el.namespaceURI === namespace),
    );
  }
  const probe = new DOMParser().parseFromString(
    '<a><b/></a>',
    'application/xml',
  );
  for (const node of [probe, probe.documentElement])
    for (let p = Object.getPrototypeOf(node); p; p = Object.getPrototypeOf(p))
      if (Object.hasOwn(p, 'getElementsByTagNameNS')) {
        p.getElementsByTagNameNS = byNamespace;
        break;
      }

  // Cesium captures the document and XML parser when its modules load.
  const C = await import('cesium');
  const reader = await import('../src/data/geoFileImport.js');
  const fromColor = C.PinBuilder.prototype.fromColor;
  // Only entity properties are recorded; no pin pixels are rendered.
  C.PinBuilder.prototype.fromColor = (_color, size) => ({
    width: size,
    height: size,
  });
  const result = {
    version: 1,
    recorder: `Cesium ${C.VERSION} DataSources in Node; canvas pins stubbed, KMZ images resolved locally. Re-record with node scripts/qa-geo-import-reference.mjs --record.`,
    tolerances,
    cesiumVersion: C.VERSION,
    files: {},
  };
  console.log(result.recorder);
  const now = C.JulianDate.fromIso8601('2020-01-01T12:00:00Z');
  const v = (property) => property?.getValue?.(now);
  const rgba = (color) =>
    color ? [color.red, color.green, color.blue, color.alpha] : [1, 1, 1, 1];
  const position = (p) => {
    const c = C.Cartographic.fromCartesian(p);
    return [
      C.Math.toDegrees(c.longitude),
      C.Math.toDegrees(c.latitude),
      c.height,
    ];
  };
  const ring = (positions, raised) => {
    const out = positions
      .map(position)
      .map(([x, y, z]) => [x, y, raised ? z : 0]);
    if (
      out.length > 1 &&
      C.Cartesian3.equalsEpsilon(positions[0], positions.at(-1), 1e-12, 1e-7)
    )
      out.pop();
    return out;
  };
  try {
    for (const file of files) {
      const bytes = await fs.readFile(path.join(directory, file));
      const urls = [];
      try {
        let ds;
        if (file.endsWith('.geojson')) {
          const json = JSON.parse(bytes.toString('utf8'));
          // The import's GeoJSON policy keeps names and grounds every coordinate.
          const stack = [json];
          while (stack.length) {
            const node = stack.pop();
            if (node.type === 'FeatureCollection') stack.push(...node.features);
            else if (node.type === 'Feature') {
              node.properties = { name: node.properties?.name };
              stack.push(node.geometry);
            } else if (node.type === 'GeometryCollection')
              stack.push(...node.geometries);
            else {
              const coords = [node.coordinates];
              while (coords.length) {
                const c = coords.pop();
                if (typeof c[0] === 'number') c.length = 2;
                else coords.push(...c);
              }
            }
          }
          const color = C.Color.fromCssColorString('#39d0ff');
          ds = await C.GeoJsonDataSource.load(json, {
            clampToGround: true,
            markerColor: color,
            markerSize: 48,
            stroke: color,
            strokeWidth: 3,
            fill: color.withAlpha(0.25),
          });
        } else {
          let text = reader.decodeXml(bytes),
            resolveLocal = () => null;
          if (file.endsWith('.kmz')) {
            const entries = await reader.readZipEntries(bytes);
            const main = reader.kmzMainDocument(entries);
            text = reader.decodeXml(entries.get(main));
            resolveLocal = reader.kmzImageResolver(entries, main, (url) =>
              urls.push(url),
            );
          }
          const doc = reader.parseXml(text, 'KML');
          // Keep the import's sanitization and tessellation policy.
          reader.sanitizeKmlDocument(doc, resolveLocal);
          reader.deduplicateKmlStyles(doc);
          ds = await C.KmlDataSource.load(doc, {
            clampToGround: true,
          });
        }
        const entities = [];
        for (const entity of ds.entities.values) {
          const name = entity.name;
          if (entity.billboard && entity.position) {
            const b = entity.billboard;
            const offset = v(b.pixelOffset),
              distance = v(b.scaleByDistance);
            const heightReference =
              v(b.heightReference) ?? C.HeightReference.NONE;
            const pos = position(v(entity.position));
            if (heightReference === C.HeightReference.CLAMP_TO_GROUND)
              pos[2] = 0;
            entities.push({
              kind: 'pin',
              name,
              positions: [pos],
              altitude:
                heightReference === C.HeightReference.RELATIVE_TO_GROUND
                  ? 'relative'
                  : heightReference === C.HeightReference.CLAMP_TO_GROUND
                    ? 'ground'
                    : 'absolute',
              color: rgba(v(b.color)),
              width: v(b.width) ?? 48,
              height: v(b.height) ?? 48,
              scale: v(b.scale) ?? 1,
              rotation: v(b.rotation) ?? 0,
              origin:
                v(b.verticalOrigin) === C.VerticalOrigin.BOTTOM
                  ? 'bottom'
                  : 'center',
              offset: offset ? [offset.x, offset.y] : [0, 0],
              distance: distance
                ? [
                    distance.near,
                    distance.nearValue,
                    distance.far,
                    distance.farValue,
                  ]
                : null,
            });
          }
          if (entity.polyline) {
            const line = entity.polyline;
            const ground = v(line.clampToGround) === true;
            entities.push({
              kind: 'line',
              name,
              ground,
              positions: v(line.positions)
                .map(position)
                .map(([x, y, z]) => [x, y, ground ? 0 : z]),
              color: rgba(v(line.material)?.color),
              width: v(line.width) ?? 1,
            });
          }
          if (entity.polygon) {
            const p = entity.polygon,
              hierarchy = v(p.hierarchy);
            const raised = v(p.perPositionHeight) === true;
            const rings = [
              hierarchy.positions,
              ...hierarchy.holes.map((h) => h.positions),
            ]
              .map((r) => ring(r, raised))
              .filter((r) => r.length >= 3);
            const fill = v(p.fill) !== false;
            entities.push({
              kind: 'polygon',
              name,
              raised,
              rings,
              color: fill ? rgba(v(p.material)?.color) : null,
              outline: raised && v(p.outline) ? rgba(v(p.outlineColor)) : null,
            });
          }
          if (entity.rectangle) {
            const r = entity.rectangle,
              rectangle = v(r.coordinates),
              rotation = v(r.rotation) ?? 0;
            let bounds,
              drawable = true;
            try {
              const b = C.RectangleGeometry.computeRectangle({
                rectangle,
                rotation,
              });
              bounds = [b.west, b.south, b.east, b.north].map(C.Math.toDegrees);
            } catch {
              drawable = false;
              bounds = null;
            }
            entities.push({
              kind: 'overlay',
              name,
              drawable,
              bounds,
              height: v(r.height) ?? 0,
              rotation: C.Math.toDegrees(rotation),
              drawOrder: v(r.zIndex) ?? 0,
              image: Boolean(r.material?.image),
              color: rgba(v(r.material)?.color),
            });
          }
        }
        result.files[file] = entities;
        console.log(`Recorded ${file}: ${entities.length} entities`);
      } finally {
        urls.forEach((url) => URL.revokeObjectURL(url));
      }
    }
    await fs.writeFile(referencePath, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    C.PinBuilder.prototype.fromColor = fromColor;
    await dom.happyDOM.close();
  }
}

async function planned(file) {
  // Only the file reader needs XML; the planner remains independent of the DOM.
  const { Window } = await import('happy-dom');
  const dom = new Window();
  globalThis.DOMParser ??= dom.DOMParser;
  globalThis.XMLSerializer ??= dom.XMLSerializer;
  const { loadGeoFile } = await import('../src/data/geoFileImport.js');
  const { importImageSize } = await import('../src/data/geoImportImages.js');
  const bytes = await fs.readFile(path.join(directory, file));
  const loaded = await loadGeoFile(new File([bytes], file));
  try {
    const metadata = new Map();
    const pending = planImport(loaded.records);
    for (const url of pending.images) {
      const size = importImageSize(
        new Uint8Array(await (await fetch(url)).arrayBuffer()),
      );
      metadata.set(url, size ? { width: size[0], height: size[1] } : null);
    }
    const plan = planImport(loaded.records, undefined, { images: metadata });
    const entities = [];
    for (const look of plan.pins)
      for (const pin of look.draw ? look.pins : []) {
        const icon = look.icon,
          box = iconBox(icon, metadata.get(icon.image?.url));
        entities.push({
          kind: 'pin',
          name: pin.record.name,
          positions: [[pin.lon, pin.lat, pin.height ?? pin.offset]],
          altitude:
            pin.height !== null
              ? 'absolute'
              : pin.offset
                ? 'relative'
                : pin.record.altitude,
          color: pin.color,
          width: box.width / (icon.scale ?? 1),
          height: box.height / (icon.scale ?? 1),
          scale: icon.scale ?? 1,
          rotation: pin.rotation,
          origin: icon.origin ?? 'center',
          offset: icon.offsetPx ?? [0, 0],
          distance: icon.scaleByDistance ?? null,
        });
      }
    for (const line of loaded.records.lines) {
      const ground = plan.ground.find((entry) => entry.record === line);
      const raised = plan.lines.find((entry) => entry.record === line);
      if (!ground && !raised) continue;
      entities.push({
        kind: 'line',
        name: line.name,
        ground: Boolean(ground),
        positions: ground
          ? ground.item.positions.map(([x, y]) => [x, y, 0])
          : raised.positions.map(worldPosition),
        color: (ground?.item ?? raised).color,
        width: (ground?.item ?? raised).widthPx,
      });
    }
    for (const polygon of loaded.records.polygons) {
      const ground = plan.ground.find((entry) => entry.record === polygon);
      const mesh = plan.meshes.find((entry) => entry.record === polygon);
      const outline = plan.lines.find((entry) => entry.record === polygon);
      let rings = [];
      if (ground)
        rings = ground.item.rings.map((r) =>
          openRing(r).map(([x, y]) => [x, y, 0]),
        );
      if (mesh) {
        const positions = meshPositions(mesh);
        let start = 0;
        rings = polygon.rings
          .map(openRing)
          .filter((r) => r.length >= 3)
          .map((r) => {
            const result = positions.slice(start, start + r.length);
            start += r.length;
            return result;
          });
        if (!(area(mesh.positions, mesh.indices) > 0))
          throw new Error(`${file}: empty raised fill`);
      }
      if (ground || mesh || outline)
        entities.push({
          kind: 'polygon',
          name: polygon.name,
          raised: Boolean(mesh || outline),
          rings,
          color: ground?.item.fill ?? mesh?.color ?? null,
          outline: outline?.color ?? null,
        });
    }
    for (const overlay of loaded.records.overlays) {
      const entry = [...plan.overlays, ...plan.meshes, ...plan.ground].find(
        (e) => e.record === overlay,
      );
      let bounds = null;
      if (entry?.rectangle) {
        const r = entry.rectangle;
        bounds = [r.west, r.south, r.east, r.north];
      } else if (entry?.item) {
        const points = entry.item.rings[0];
        bounds = [
          Math.min(...points.map((p) => p[0])),
          Math.min(...points.map((p) => p[1])),
          Math.max(...points.map((p) => p[0])),
          Math.max(...points.map((p) => p[1])),
        ];
      }
      if (!bounds && entry?.positions) {
        const points = meshPositions(entry);
        bounds = [
          Math.min(...points.map((p) => p[0])),
          Math.min(...points.map((p) => p[1])),
          Math.max(...points.map((p) => p[0])),
          Math.max(...points.map((p) => p[1])),
        ];
      }
      entities.push({
        kind: 'overlay',
        name: overlay.name,
        drawable: Boolean(entry),
        bounds,
        height: entry?.positions ? meshPositions(entry)[0][2] : 0,
        rotation: entry?.canvas
          ? (entry.canvas.angle * 180) / Math.PI
          : overlay.rotation,
        drawOrder: entry?.positions ? 0 : overlay.drawOrder,
        image: Boolean(entry?.url),
        color:
          entry?.item?.fill ??
          (!entry?.url && entry?.color
            ? entry.color
            : entry
              ? [...(entry.canvas?.tint ?? [1, 1, 1]), entry.alpha]
              : overlay.color),
      });
    }
    const actualOrder = [
      ...plan.overlays,
      ...plan.meshes.filter((entry) => entry.url),
    ]
      .filter((entry) => !entry.positions)
      .map((entry) => entry.record.name);
    return { entities, actualOrder, report: plan.report };
  } finally {
    loaded.revoke();
  }
}

function differences(actual, expected, location, output) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const tolerance = /color|outline/.test(location)
      ? tolerances.color
      : /positions.*\[2\]$|rings.*\[2\]$|\.height$/.test(location)
        ? tolerances.metres
        : tolerances.degrees;
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance)
      output.push(
        `${location}: expected ${expected}, got ${actual} (tolerance ${tolerance})`,
      );
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      output.push(
        `${location}: expected ${expected.length} entries, got ${actual?.length ?? 'none'}`,
      );
      return;
    }
    expected.forEach((value, i) =>
      differences(actual[i], value, `${location}[${i}]`, output),
    );
  } else if (expected && typeof expected === 'object') {
    for (const key of Object.keys(expected))
      differences(actual?.[key], expected[key], `${location}.${key}`, output);
  } else if (actual !== expected)
    output.push(
      `${location}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

if (process.argv.includes('--record')) await record();
else {
  const reference = JSON.parse(await fs.readFile(referencePath, 'utf8'));
  console.log(reference.recorder);
  const output = [];
  differences(files, Object.keys(reference.files).sort(), 'corpus', output);
  for (const file of files) {
    const { entities, actualOrder } = await planned(file);
    const expected = reference.files[file];
    // A rectangle rejected at the pole has no drawable style or height.
    const visible = (e) =>
      e.kind === 'overlay' && !e.drawable
        ? { kind: e.kind, name: e.name, drawable: false, bounds: null }
        : e;
    const sort = (a, b) =>
      `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`);
    differences(
      entities.map(visible).sort(sort),
      expected.map(visible).sort(sort),
      file,
      output,
    );
    const expectedOrder = expected
      .filter((e) => e.kind === 'overlay' && e.image && e.drawable && !e.height)
      .sort((a, b) => a.drawOrder - b.drawOrder)
      .map((e) => e.name);
    differences(actualOrder, expectedOrder, `${file}.drawOrder`, output);
  }
  output.forEach((line) => console.error(line));
  console.log(`${files.length} files: ${output.length} differences`);
  process.exitCode = output.length ? 1 : 0;
}
