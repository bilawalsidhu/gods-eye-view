/**
 * Cesium ESM shim.
 *
 * Problem: the CDN Cesium.js is a UMD build — it sets window.Cesium but has no
 * named ES module exports. When code does `import * as Cesium from 'cesium'`,
 * the resulting namespace is empty and Cesium.Math/Cesium.Cartesian3/etc. are
 * all undefined.
 *
 * Solution: redirect all 'cesium' imports to this shim. The shim dynamically
 * imports the CDN URL and re-exports all named exports from window.Cesium.
 * Vite aliases 'cesium' → this file, so all source imports get the full
 * Cesium namespace at runtime.
 *
 * Workers + Assets are fetched from CESIUM_BASE_URL which points to unpkg's
 * /files/ tree at runtime.
 */
export default window.Cesium;
export const Cesium = window.Cesium;
export const Math = window.Cesium.Math;
export const Cartesian2 = window.Cesium.Cartesian2;
export const Cartesian3 = window.Cesium.Cartesian3;
export const Cartographic = window.Cesium.Cartographic;
export const Color = window.Cesium.Color;
export const Ellipsoid = window.Cesium.Ellipsoid;
export const Rectangle = window.Cesium.Rectangle;
export const JulianDate = window.Cesium.JulianDate;
export const Entity = window.Cesium.Entity;
export const DataSource = window.Cesium.DataSource;
export const GeoJsonDataSource = window.Cesium.GeoJsonDataSource;
export const CzmlDataSource = window.Cesium.CzmlDataSource;
export const KmlDataSource = window.Cesium.KmlDataSource;
export const ProviderViewModel = window.Cesium.ProviderViewModel;
export const ImageryLayer = window.Cesium.ImageryLayer;
export const Globe = window.Cesium.Globe;
export const Scene = window.Cesium.Scene;
export const Camera = window.Cesium.Camera;
export const Viewer = window.Cesium.Viewer;
export const Ion = window.Cesium.Ion;
export const Credit = window.Cesium.Credit;
export const TimeIntervalCollection = window.Cesium.TimeIntervalCollection;
export const BoundingRectangle = window.Cesium.BoundingRectangle;
export const EllipsoidGeodesic = window.Cesium.EllipsoidGeodesic;
export const PolylinePipeline = window.Cesium.PolylinePipeline;
export const PolygonPipeline = window.Cesium.PolygonPipeline;
export const WallPipeline = window.Cesium.WallPipeline;
export const ArcGisImageryProvider = window.Cesium.ArcGisImageryProvider;
export const BingMapsImageryProvider = window.Cesium.BingMapsImageryProvider;
export const OpenStreetMapImageryProvider = window.Cesium.OpenStreetMapImageryProvider;
export const UrlTemplateImageryProvider = window.Cesium.UrlTemplateImageryProvider;
export const WebMapTileServiceImageryProvider = window.Cesium.WebMapTileServiceImageryProvider;
export const WebMercatorTilingSpecification = window.Cesium.WebMercatorTilingSpecification;
export const GeographicTilingSpecification = window.Cesium.GeographicTilingSpecification;
export const CesiumWidget = window.Cesium.CesiumWidget;
export const Animation = window.Cesium.Animation;
export const BaseLayerPicker = window.Cesium.BaseLayerPicker;
export const Cesium3DTileset = window.Cesium.Cesium3DTileset;
export const Model = window.Cesium.Model;
export const ParticleSystem = window.Cesium.ParticleSystem;
export const PointPrimitiveCollection = window.Cesium.PointPrimitiveCollection;
export const PointPrimitive = window.Cesium.PointPrimitive;
export const PrimitiveCollection = window.Cesium.PrimitiveCollection;
export const BillboardCollection = window.Cesium.BillboardCollection;
export const Billboard = window.Cesium.Billboard;
export const LabelCollection = window.Cesium.LabelCollection;
export const Label = window.Cesium.Label;
export const PolylineCollection = window.Cesium.PolylineCollection;
export const Polyline = window.Cesium.Polyline;
export const PathGraphics = window.Cesium.PathGraphics;
export const PointGraphics = window.Cesium.PointGraphics;
export const Path = window.Cesium.Path;
export const BoundingSphere = window.Cesium.BoundingSphere;
