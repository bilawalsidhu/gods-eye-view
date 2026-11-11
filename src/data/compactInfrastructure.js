import * as Cesium from 'cesium';

class MirroredProperty {
  constructor(value, changed) {
    this.value = value;
    this.changed = changed;
  }
  getValue(_time, result) {
    return this.value?.clone ? this.value.clone(result) : this.value;
  }
  setValue(value) {
    this.value = value?.clone ? value.clone(this.value) : value;
    this.changed?.(this.value);
  }
}

/** Lightweight query/LOD record; only a winning visible record gets a Cesium Entity. */
class CompactFeature {
  constructor(source, viewer, id, properties, position, geometry) {
    this.id = id;
    this.properties = properties;
    this.source = source;
    this.viewer = viewer;
    this.geometry = source.detailed ? geometry : null;
    this.native = null;
    this.visible = false;
    this._position = new MirroredProperty(position, (value) =>
      this.native?.position.setValue(value),
    );
  }
  get position() {
    return this._position;
  }
  set position(value) {
    this._position.setValue(value);
  }
  get polyline() {
    return this._polyline;
  }
  set polyline(value) {
    this._polyline = {
      ...value,
      positions: new MirroredProperty(value.positions, (positions) =>
        this.native?.polyline.positions.setValue(positions),
      ),
    };
  }
  get show() {
    return this.visible;
  }
  syncTags() {
    if (!this.native) return;
    for (const key of [
      '__localLayerId',
      '__localBaseCarto',
      '__localBaseCartesian',
      '__gevContextId',
    ])
      this.native[key] = this[key];
  }
  set show(value) {
    this.visible = value;
    if (value && !this.native) {
      this.native = this.source.entities.add(
        new Cesium.Entity({
          id: this.id,
          name:
            this.properties?.title ||
            this.properties?.name ||
            this.properties?.tags?.name,
          properties: this.properties,
          position: this.position.getValue(),
          point: this.point,
          polyline: this.polyline
            ? {
                positions: this.polyline.positions.getValue(),
                width: this.polyline.width,
                material: this.polyline.material,
              }
            : undefined,
          ...this.source.geometryOptions(this.geometry, this.properties),
        }),
      );
      this.syncTags();
    }
    if (!this.native) return;
    this.native.show = value;
    if (!value && this.viewer.selectedEntity !== this.native) {
      // EntityCollection.remove does not disconnect subscriptions to shared
      // graphics/materials. Break those before dropping an offscreen entity.
      this.native.point = undefined;
      if (this.native.polyline) {
        this.native.polyline.material = undefined;
        this.native.polyline.width = undefined;
      }
      this.native.polyline = undefined;
      this.native.polygon = undefined;
      this.native.billboard = undefined;
      this.source.entities.remove(this.native);
      this.native = null;
    }
  }
}

/** Global metadata plus only the native entities that the existing LOD actually shows. */
export function createCompactInfrastructureSource(
  features,
  viewer,
  { detailed = false, color = Cesium.Color.CYAN, createPin } = {},
) {
  const source = new Cesium.CustomDataSource();
  source.detailed = detailed;
  source.resourceMode = detailed ? 'standard' : 'low';
  const pinBuilder = new Cesium.PinBuilder();
  const positions = (coordinates) =>
    coordinates.map((coord) => Cesium.Cartesian3.fromDegrees(...coord));
  source.geometryOptions = (geometry, properties) => {
    if (!geometry) return {};
    if (geometry.type === 'Polygon') {
      const rings = geometry.coordinates;
      const fill = properties.fill
        ? Cesium.Color.fromCssColorString(properties.fill).withAlpha(0.3)
        : color.withAlpha(0.3);
      if (properties['fill-opacity'] != null)
        fill.alpha = properties['fill-opacity'];
      const outline = properties.stroke
        ? Cesium.Color.fromCssColorString(properties.stroke)
        : Cesium.Color.clone(color);
      if (
        properties['stroke-opacity'] != null &&
        properties['stroke-opacity'] !== 1
      )
        outline.alpha = properties['stroke-opacity'];
      return {
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            positions(rings[0]),
            rings
              .slice(1)
              .map((ring) => new Cesium.PolygonHierarchy(positions(ring))),
          ),
          outline: true,
          outlineColor: outline,
          outlineWidth: properties['stroke-width'] ?? 2,
          material: fill,
          arcType: Cesium.ArcType.RHUMB,
          perPositionHeight: rings[0][0].length > 2,
        },
      };
    }
    if (geometry.type === 'Point') {
      const marker = properties['marker-color']
        ? Cesium.Color.fromCssColorString(properties['marker-color'])
        : color;
      const size =
        { small: 24, medium: 48, large: 64 }[properties['marker-size']] || 8;
      const symbol = properties['marker-symbol'];
      const image = createPin
        ? createPin(marker, size, symbol)
        : symbol?.length === 1
          ? pinBuilder.fromText(symbol.toUpperCase(), marker, size)
          : pinBuilder.fromColor(marker, size);
      return {
        billboard: {
          image,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference:
            geometry.coordinates.length === 2
              ? Cesium.HeightReference.CLAMP_TO_GROUND
              : Cesium.HeightReference.NONE,
        },
      };
    }
    if (geometry.type === 'LineString') {
      const stroke = properties.stroke
        ? Cesium.Color.fromCssColorString(properties.stroke)
        : Cesium.Color.clone(color);
      if (properties['stroke-opacity'] != null)
        stroke.alpha = properties['stroke-opacity'];
      return {
        polyline: {
          positions: positions(geometry.coordinates),
          material: stroke,
          width: properties['stroke-width'] ?? 2,
          clampToGround: true,
          arcType: Cesium.ArcType.RHUMB,
        },
      };
    }
    return {};
  };
  source.compactEntities = [];
  source.releaseUnselected = () => {
    for (const feature of source.compactEntities)
      if (
        !feature.visible &&
        feature.native &&
        viewer.selectedEntity !== feature.native
      )
        feature.show = false;
  };
  const ids = new Set();
  const append = (feature, geometry) => {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries) append(feature, child);
      return;
    }
    if (
      geometry.type === 'MultiPolygon' ||
      geometry.type === 'MultiPoint' ||
      geometry.type === 'MultiLineString'
    ) {
      const type = {
        MultiPolygon: 'Polygon',
        MultiPoint: 'Point',
        MultiLineString: 'LineString',
      }[geometry.type];
      for (const coordinates of geometry.coordinates)
        append(feature, { type, coordinates });
      return;
    }
    const baseId = feature.id ?? Cesium.createGuid();
    let id = baseId,
      suffix = 2;
    while (ids.has(String(id))) id = `${baseId}_${suffix++}`;
    ids.add(String(id));
    let position;
    if (geometry.type === 'Point')
      position = Cesium.Cartesian3.fromDegrees(...geometry.coordinates);
    else if (geometry.type === 'Polygon') {
      const ring = geometry.coordinates[0];
      const positions = ring.map((coord) =>
        Cesium.Cartesian3.fromDegrees(...coord),
      );
      if (positions.length)
        position = Cesium.BoundingSphere.fromPoints(positions).center;
    } else if (geometry.type !== 'LineString')
      throw new Error(`Unsupported GeoJSON geometry: ${geometry.type}`);
    const row = new CompactFeature(
      source,
      viewer,
      id,
      feature.properties || {},
      position,
      geometry,
    );
    source.compactEntities.push(row);
    // Lines do not carry stems in the original renderer and stay visible
    // independently of its point/stem LOD. Preserve those few native lines.
    if (detailed && geometry.type === 'LineString') row.show = true;
  };
  for (const feature of features) append(feature, feature.geometry);
  return source;
}
