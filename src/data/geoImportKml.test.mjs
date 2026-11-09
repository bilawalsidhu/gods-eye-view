// The KML reader against Cesium's KmlDataSource, the reference it replaces:
// the same sanitized documents read by both give the same pins, lines,
// polygons and overlays with the same styles. Cesium stays a test
// dependency here only.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  deduplicateKmlStyles,
  loadGeoFile,
  parseXml,
  sanitizeKmlDocument,
} from './geoFileImport.js';
import { kmlColor, readKmlRecords } from './geoImportKml.js';

// happy-dom's getElementsByTagNameNS('*', name) finds nothing in a parsed
// XML document; KmlDataSource queries every element through it.
function byNamespace(namespace, localName) {
  return [...this.getElementsByTagName('*')].filter(
    (el) =>
      (localName === '*' || el.localName === localName) &&
      (namespace === '*' || el.namespaceURI === namespace),
  );
}
const probe = new DOMParser().parseFromString('<a><b/></a>', 'application/xml');
for (const node of [probe, probe.documentElement])
  for (let p = Object.getPrototypeOf(node); p; p = Object.getPrototypeOf(p))
    if (Object.hasOwn(p, 'getElementsByTagNameNS')) {
      p.getElementsByTagNameNS = byNamespace;
      break;
    }

const TRAP = 'gev-qa-trap.invalid';
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const kml = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>${body}</Document></kml>`;

// scripts/qa-geo-import.mjs's KML, with a packed icon and overlay as in its KMZ.
const QA = kml(`
  <Style id="s"><IconStyle><Icon><href>${PNG}</href></Icon></IconStyle></Style>
  <Style id="palette"><IconStyle><Icon><href>root://icons/palette-4.png</href><gx:x>32</gx:x><gx:y>64</gx:y></Icon></IconStyle></Style>
  <NetworkLink><Link><href>https://${TRAP}/link.kml</href></Link></NetworkLink>
  <Placemark><name>QA KML pin</name><styleUrl>#s</styleUrl>
    <description>&lt;img src="https://${TRAP}/balloon.png"&gt;</description>
    <TimeSpan><begin>2019-01-01T00:00:00Z</begin><end>2019-01-02T00:00:00Z</end></TimeSpan>
    <Point><coordinates>-122.47,37.77,0</coordinates></Point></Placemark>
  <Placemark><name>QA palette pin</name><styleUrl>#palette</styleUrl>
    <Point><coordinates>-122.48,37.771,0</coordinates></Point></Placemark>
  <Placemark><name>QA moving</name>
    <gx:Track><when>2019-01-01T00:00:00Z</when><when>2019-01-01T01:00:00Z</when>
      <gx:coord>-122.49 37.767 0</gx:coord><gx:coord>-122.475 37.772 0</gx:coord></gx:Track></Placemark>
  <Placemark><name>QA split tracks</name><gx:MultiTrack>
    <gx:Track><gx:coord>-122.50 37.767 0</gx:coord><gx:coord>-122.49 37.768 0</gx:coord></gx:Track>
    <gx:Track><gx:coord>-122.47 37.771 0</gx:coord><gx:coord>-122.46 37.772 0</gx:coord></gx:Track>
  </gx:MultiTrack></Placemark>
  <Placemark><name>QA remote style</name><styleUrl>https://${TRAP}/styles.kml#x</styleUrl>
    <LineString><coordinates>-122.50,37.766 -122.46,37.772</coordinates></LineString></Placemark>
  <GroundOverlay><Icon><href>${PNG}</href></Icon>
    <LatLonBox><north>37.77</north><south>37.76</south><east>-122.46</east><west>-122.47</west></LatLonBox></GroundOverlay>`);

// Styles and geometries the import keeps, each the way KML allows.
const STYLED = kml(`
  <Style id="red"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle>
    <PolyStyle><color>7f00ff00</color></PolyStyle></Style>
  <Style id="pin"><IconStyle><scale>1.5</scale><color>ff00ffff</color><heading>30</heading>
    <Icon><href>${PNG}</href><gx:x>0</gx:x><gx:y>0</gx:y><gx:w>1</gx:w><gx:h>1</gx:h></Icon>
    <hotSpot x="20" y="2" xunits="pixels" yunits="pixels"/></IconStyle></Style>
  <Style id="frac"><IconStyle><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle></Style>
  <Style id="inset"><IconStyle><scale>2</scale><hotSpot x="4" y="6" xunits="insetPixels" yunits="insetPixels"/></IconStyle></Style>
  <Style id="none"><IconStyle><Icon></Icon></IconStyle></Style>
  <Style id="hollow"><PolyStyle><fill>0</fill><outline>1</outline></PolyStyle><LineStyle><color>ffff0000</color><width>3</width></LineStyle></Style>
  <StyleMap id="map"><Pair><key>normal</key><styleUrl>#red</styleUrl></Pair>
    <Pair><key>highlight</key><styleUrl>#pin</styleUrl></Pair></StyleMap>
  <StyleMap id="inlineMap"><Pair><key>normal</key><Style><LineStyle><color>ff00ff00</color></LineStyle></Style></Pair></StyleMap>
  <Placemark><name>default pin</name><Point><coordinates>1,1</coordinates></Point></Placemark>
  <Placemark><name>styled pin</name><styleUrl>#pin</styleUrl><Point><coordinates>1,2,50</coordinates></Point></Placemark>
  <Placemark><name>fraction</name><styleUrl>#frac</styleUrl><Point><altitudeMode>absolute</altitudeMode><coordinates>1,3,500</coordinates></Point></Placemark>
  <Placemark><name>inset</name><styleUrl>#inset</styleUrl><Point><altitudeMode>relativeToGround</altitudeMode><extrude>1</extrude><coordinates>1,4,80</coordinates></Point></Placemark>
  <Placemark><name>hidden icon</name><styleUrl>#none</styleUrl><Point><coordinates>1,5</coordinates></Point></Placemark>
  <Placemark><name>mapped line</name><styleUrl>#map</styleUrl><LineString><coordinates>0,0 1,1 2,1</coordinates></LineString></Placemark>
  <Placemark><name>inline map line</name><styleUrl>#inlineMap</styleUrl><LineString><coordinates>0,0 1,0</coordinates></LineString></Placemark>
  <Placemark><name>override</name><styleUrl>#red</styleUrl><Style><LineStyle><width>9</width></LineStyle></Style>
    <LineString><coordinates>0,1 1,2</coordinates></LineString></Placemark>
  <Placemark><name>air line</name><styleUrl>#red</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>0,2,100 1,3,200</coordinates></LineString></Placemark>
  <Placemark><name>relative line</name><LineString><tessellate>0</tessellate><altitudeMode>relativeToGround</altitudeMode><coordinates>0,3,10 1,4,20</coordinates></LineString></Placemark>
  <Placemark><name>wall</name><styleUrl>#red</styleUrl><LineString><extrude>1</extrude><altitudeMode>absolute</altitudeMode><coordinates>0,4,100 1,5,100</coordinates></LineString></Placemark>
  <Placemark><name>ring</name><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></Placemark>
  <Placemark><name>filled</name><styleUrl>#red</styleUrl><Polygon>
    <outerBoundaryIs><LinearRing><coordinates>0,0 2,0 2,2 0,2 0,0</coordinates></LinearRing></outerBoundaryIs>
    <innerBoundaryIs><LinearRing><coordinates>0.5,0.5 1,0.5 1,1 0.5,0.5</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
  <Placemark><name>hollow raised</name><styleUrl>#hollow</styleUrl><Polygon><altitudeMode>absolute</altitudeMode>
    <outerBoundaryIs><LinearRing><coordinates>3,0,10 4,0,10 4,1,10 3,0,10</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>plain</name><Polygon><outerBoundaryIs><LinearRing><coordinates>5,0 6,0 6,1 5,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Placemark><name>multi</name><styleUrl>#red</styleUrl><MultiGeometry>
    <Point><coordinates>7,7</coordinates></Point>
    <LineString><coordinates>7,7 8,8</coordinates></LineString>
    <MultiGeometry><Polygon><outerBoundaryIs><LinearRing><coordinates>7,0 8,0 8,1 7,0</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry>
  </MultiGeometry></Placemark>
  <Folder><Placemark><name>in folder</name><styleUrl>#red</styleUrl><Point><coordinates>9,9</coordinates></Point></Placemark></Folder>
  <GroundOverlay><color>80ffffff</color><Icon><href>${PNG}</href></Icon>
    <LatLonBox><north>11</north><south>10</south><east>-179</east><west>179</west><rotation>15</rotation></LatLonBox></GroundOverlay>
  <GroundOverlay><color>ff0000ff</color><LatLonBox><north>13</north><south>12</south><east>13</east><west>12</west></LatLonBox></GroundOverlay>
  <Style id="a"><LineStyle><color>ff123456</color></LineStyle></Style>
  <Style id="b"><LineStyle><color>ff123456</color></LineStyle></Style>
  <Placemark><name>deduplicated a</name><styleUrl>#a</styleUrl><LineString><coordinates>3,3 4,4</coordinates></LineString></Placemark>
  <Placemark><name>deduplicated b</name><styleUrl>#b</styleUrl><LineString><coordinates>4,4 5,5</coordinates></LineString></Placemark>`);

// scripts/qa-geo-import-large.mjs's style check: one shared style with
// point, line and polygon parts, each placemark overriding one part inline,
// and named styles and an inline StyleMap pair that are alike.
const SHARED = kml(`
  <Style id="base"><IconStyle><heading>25</heading><scale>1.2</scale></IconStyle>
    <LineStyle><color>ffdd6600</color><width>7</width></LineStyle>
    <PolyStyle><color>6600ddff</color><fill>1</fill><outline>0</outline></PolyStyle></Style>
  <Placemark><name>shared point</name><styleUrl>#base</styleUrl>
    <Style><IconStyle><scale>0.6</scale><color>ff00dd66</color></IconStyle></Style>
    <Point><coordinates>-122.49,37.77,0</coordinates></Point></Placemark>
  <Placemark><name>shared line</name><styleUrl>#base</styleUrl>
    <Style><LineStyle><width>3</width></LineStyle></Style>
    <LineString><coordinates>-122.50,37.77,0 -122.49,37.77,0</coordinates></LineString></Placemark>
  <Placemark><name>shared polygon</name><styleUrl>#base</styleUrl>
    <Style><PolyStyle><outline>1</outline></PolyStyle></Style>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>-122.50,37.77,0 -122.49,37.77,0 -122.49,37.78,0 -122.50,37.77,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
  <Style id="named-a"><IconStyle><scale>0.8</scale></IconStyle></Style>
  <Style id="named-b"><IconStyle><scale>0.8</scale></IconStyle></Style>
  <StyleMap id="paired"><Pair><key>normal</key><Style><IconStyle><scale>0.8</scale></IconStyle></Style></Pair></StyleMap>
  <Placemark><name>named-a</name><styleUrl>#named-a</styleUrl><Point><coordinates>-122.49,37.77,0</coordinates></Point></Placemark>
  <Placemark><name>named-b</name><styleUrl>#named-b</styleUrl><Point><coordinates>-122.49,37.77,0</coordinates></Point></Placemark>
  <Placemark><name>paired</name><styleUrl>#paired</styleUrl><Point><coordinates>-122.49,37.77,0</coordinates></Point></Placemark>`);

/** A document as the import prepares it for reading. */
function prepared(text) {
  const doc = parseXml(text, 'KML');
  sanitizeKmlDocument(doc);
  deduplicateKmlStyles(doc);
  return doc;
}

// To 1e-6, and -0 as 0.
const round = (v) =>
  v === undefined ? undefined : Math.round(v * 1e6) / 1e6 + 0;
const rgba = (c) => c && [c.red, c.green, c.blue, c.alpha].map(round);
const lonLatH = (cartesian) => {
  const c = Cesium.Cartographic.fromCartesian(cartesian);
  return [
    Cesium.Math.toDegrees(c.longitude),
    Cesium.Math.toDegrees(c.latitude),
    c.height,
  ].map((v) => Math.round(v * 1e4) / 1e4 + 0);
};
const roundPosition = (p) => p.map((v) => Math.round(v * 1e4) / 1e4 + 0);
const HEIGHT_MODE = {
  [Cesium.HeightReference.CLAMP_TO_GROUND]: 'ground',
  [Cesium.HeightReference.RELATIVE_TO_GROUND]: 'relative',
  [Cesium.HeightReference.NONE]: 'absolute',
};

/** What Cesium's KmlDataSource draws of a document, as comparable data. */
async function cesiumReading(text) {
  const previous = Cesium.PinBuilder.prototype.fromColor;
  Cesium.PinBuilder.prototype.fromColor = (color, size) => ({
    pin: rgba(color),
    pinSize: size,
  });
  try {
    const ds = await Cesium.KmlDataSource.load(prepared(text), {
      clampToGround: true,
    });
    const now = Cesium.JulianDate.now();
    const value = (property) => property?.getValue?.(now);
    const out = { points: [], lines: [], polygons: [], overlays: [], walls: 0 };
    for (const entity of ds.entities.values) {
      const billboard = entity.billboard;
      const image = value(billboard?.image);
      if (billboard && entity.position && image) {
        const offset = value(billboard.pixelOffset);
        const rotation = value(billboard.rotation);
        const region = value(billboard.imageSubRegion);
        out.points.push({
          name: entity.name,
          position: lonLatH(value(entity.position)),
          altitude: HEIGHT_MODE[value(billboard.heightReference)],
          image: image.pin ? image : { url: image.url ?? String(image) },
          scale: round(value(billboard.scale) ?? 1),
          color: rgba(value(billboard.color)) ?? [1, 1, 1, 1],
          offset: offset ? [offset.x, offset.y].map(round) : [0, 0],
          rotation: round(rotation ?? 0),
          subRegion: region
            ? [region.x, region.y, region.width, region.height]
            : undefined,
          size: [value(billboard.width), value(billboard.height)],
        });
      }
      if (entity.polyline) {
        const ground = value(entity.polyline.clampToGround) === true;
        out.lines.push({
          name: entity.name,
          positions: value(entity.polyline.positions).map((p) => {
            const [lon, lat, h] = lonLatH(p);
            return ground ? [lon, lat] : [lon, lat, h];
          }),
          ground,
          color: rgba(value(entity.polyline.material)?.color) ??
            rgba(entity.polyline.material?.color?.getValue(now)) ?? [
              1, 1, 1, 1,
            ],
          width: value(entity.polyline.width) ?? 1,
        });
      }
      if (entity.wall) out.walls += 1;
      if (entity.polygon) {
        const polygon = entity.polygon;
        const hierarchy = value(polygon.hierarchy);
        const raised = value(polygon.perPositionHeight) === true;
        const ring = (positions) =>
          positions.map((p) => {
            const [lon, lat, h] = lonLatH(p);
            return raised ? [lon, lat, h] : [lon, lat];
          });
        const fill = value(polygon.fill) ?? true;
        const outline = value(polygon.outline) ?? false;
        out.polygons.push({
          name: entity.name,
          rings: [
            ring(hierarchy.positions),
            ...hierarchy.holes.map((h) => ring(h.positions)),
          ],
          raised,
          fill: fill
            ? (rgba(polygon.material?.color?.getValue(now)) ?? [1, 1, 1, 1])
            : null,
          outline: outline
            ? {
                color: rgba(value(polygon.outlineColor)) ?? [1, 1, 1, 1],
                widthPx: value(polygon.outlineWidth) ?? 1,
              }
            : null,
        });
      }
      if (entity.rectangle) {
        const r = value(entity.rectangle.coordinates);
        const material = entity.rectangle.material;
        const url = material?.image?.getValue(now);
        out.overlays.push({
          rectangle: [r.west, r.south, r.east, r.north].map((v) =>
            round(Cesium.Math.toDegrees(v)),
          ),
          url: url ? (url.url ?? String(url)) : null,
          color: rgba(material?.color?.getValue(now)) ??
            rgba(material?.getValue?.(now)?.color) ?? [1, 1, 1, 1],
          rotation: round(
            Cesium.Math.toDegrees(value(entity.rectangle.rotation) ?? 0),
          ),
        });
      }
    }
    return out;
  } finally {
    Cesium.PinBuilder.prototype.fromColor = previous;
  }
}

/** The reader's records of a document, in the same comparable form. */
function ourReading(text) {
  const records = readKmlRecords(prepared(text));
  return {
    points: records.points.map(({ name, position, altitude, icon }) => ({
      name,
      position: roundPosition(position),
      altitude,
      image: icon.image.pin
        ? { pin: icon.image.pin.map(round), pinSize: icon.image.pinSize }
        : icon.image,
      scale: round(icon.scale ?? 1),
      color: (icon.color ?? [1, 1, 1, 1]).map(round),
      offset: (icon.offsetPx ?? [0, 0]).map(round),
      rotation: round(icon.rotation ?? 0),
      subRegion: icon.subRegion,
      size: [icon.widthPx, icon.heightPx],
    })),
    lines: records.lines.map(({ name, positions, ground, color, widthPx }) => ({
      name,
      positions: positions.map((p) =>
        ground ? roundPosition(p).slice(0, 2) : roundPosition(p),
      ),
      ground,
      color: color.map(round),
      width: widthPx,
    })),
    polygons: records.polygons.map(
      ({ name, rings, raised, fill, outline }) => ({
        name,
        rings: rings.map((ring) =>
          ring.map((p) =>
            raised ? roundPosition(p) : roundPosition(p).slice(0, 2),
          ),
        ),
        raised,
        fill: fill && fill.map(round),
        outline: outline && {
          color: outline.color.map(round),
          widthPx: outline.widthPx,
        },
      }),
    ),
    overlays: records.overlays.map(
      ({ rectangle: r, url, color, rotation }) => ({
        rectangle: [r.west, r.south, r.east, r.north].map(round),
        url,
        // Cesium's transparent image material caps the alpha at 0.99, as the
        // display's imagery alpha does.
        color: (url
          ? [...color.slice(0, 3), Math.min(0.99, color[3])]
          : color
        ).map(round),
        rotation: round(rotation),
      }),
    ),
    walls: records.undrawn.wall ?? 0,
  };
}

for (const [name, text] of [
  ['the QA file', QA],
  ['styles, altitudes, multigeometries and overlays', STYLED],
  ['shared styles with inline overrides, named and paired', SHARED],
]) {
  test(`KML records match Cesium's reading: ${name}`, async () => {
    const cesium = await cesiumReading(text);
    const ours = ourReading(text);
    assert.deepEqual(ours.points, cesium.points);
    // Cesium draws a wall's outline where the reader draws its top edge as
    // a line; every other line is the same.
    assert.deepEqual(
      ours.lines.filter((line) => line.name !== 'wall'),
      cesium.lines,
    );
    assert.equal(ours.walls, cesium.walls);
    assert.deepEqual(ours.polygons, cesium.polygons);
    assert.deepEqual(ours.overlays, cesium.overlays);
  });
}

test('the QA file reads to pins, ground lines and a packed overlay, with nothing remote', () => {
  const records = readKmlRecords(prepared(QA));
  assert.deepEqual(
    records.points.map(({ name, icon }) => [name, Boolean(icon.image.pin)]),
    [
      ['QA KML pin', false],
      // A blocked palette icon falls back to Cesium's yellow pin.
      ['QA palette pin', true],
    ],
  );
  assert.deepEqual(
    records.lines.map(({ name, ground, positions }) => [
      name,
      ground,
      positions.length,
    ]),
    [
      ['QA moving', true, 2],
      ['QA split tracks', true, 2],
      ['QA split tracks', true, 2],
      ['QA remote style', true, 2],
    ],
  );
  assert.equal(records.overlays.length, 1);
  assert.ok(!JSON.stringify(records).includes(TRAP));
  // No time survives: a dated placemark draws for all time.
  assert.ok(!/2019/.test(JSON.stringify(records)));
});

test('extruded polygons and quads are counted as undrawn', () => {
  const records = readKmlRecords(
    prepared(
      kml(`<Placemark><Polygon><extrude>1</extrude><altitudeMode>absolute</altitudeMode>
        <outerBoundaryIs><LinearRing><coordinates>0,0,9 1,0,9 1,1,9 0,0,9</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <GroundOverlay><Icon><href>${PNG}</href></Icon><gx:LatLonQuad><coordinates>0,0 1,0 1,1 0,1</coordinates></gx:LatLonQuad></GroundOverlay>`),
    ),
  );
  assert.deepEqual(records.undrawn, { extruded: 1, latLonQuad: 1 });
  assert.equal(records.polygons[0].raised, true);
});

test('KML colours are aabbggrr; a random colour stays within its channels', () => {
  assert.deepEqual(kmlColor('7f00ff00'), [0, 1, 0, 127 / 255]);
  assert.equal(kmlColor('  '), undefined);
  const [red, green, blue, alpha] = kmlColor('ff0000ff', true);
  assert.ok(red >= 0 && red <= 1 && green === 0 && blue === 0 && alpha === 1);
});

test('a KML file loads to records with its name, count and outside content removed', async () => {
  const loaded = await loadGeoFile(new File([QA], 'remote-bits.kml'));
  assert.equal(loaded.format, 'kml');
  assert.equal(loaded.entityCount, 7);
  assert.ok(loaded.removed > 0);
  assert.equal(loaded.records.points[0].name, 'QA KML pin');
  loaded.revoke();
});

test('GroundOverlay retains altitude and altitude mode for drawing diagnostics', () => {
  const records = readKmlRecords(
    parseXml(
      kml(
        `<GroundOverlay><altitude>1000</altitude><altitudeMode>absolute</altitudeMode><LatLonBox><west>0</west><east>1</east><south>0</south><north>1</north></LatLonBox></GroundOverlay>`,
      ),
    ),
  );
  assert.equal(records.overlays[0].altitude, 1000);
  assert.equal(records.overlays[0].altitudeMode, 'absolute');
});

test('GroundOverlay keeps drawOrder, including negatives and the default', () => {
  const records = readKmlRecords(
    prepared(
      kml(
        [10, -2, null, 10]
          .map(
            (order) => `
      <GroundOverlay>
        ${order === null ? '' : `<drawOrder>${order}</drawOrder>`}
        <LatLonBox><west>0</west><east>1</east><south>0</south><north>1</north></LatLonBox>
      </GroundOverlay>`,
          )
          .join(''),
      ),
    ),
  );
  assert.deepEqual(
    records.overlays.map((overlay) => overlay.drawOrder),
    [10, -2, 0, 10],
  );
});

test('KML polygons discard degenerate holes and retain valid ones', () => {
  const records = readKmlRecords(
    prepared(
      kml(`
    <Placemark><Polygon>
      <outerBoundaryIs><LinearRing><coordinates>0,0 2,0 2,2 0,2 0,0</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>1,1 1.1,1.1 1,1</coordinates></LinearRing></innerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>1,1 1.1,1.1 1,1 1.1,1.1</coordinates></LinearRing></innerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>0.5,0.5 0.6,0.5 0.6,0.6 0.5,0.5</coordinates></LinearRing></innerBoundaryIs>
    </Polygon></Placemark>`),
    ),
  );
  assert.equal(records.polygons[0].rings.length, 2);
  assert.deepEqual(records.polygons[0].rings[1][0], [0.5, 0.5, 0]);
});
