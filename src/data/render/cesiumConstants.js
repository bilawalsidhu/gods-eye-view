// Native constants shared by the W1 adapters; keep the SDK import here.
// Read on call: the production build's Cesium global loads with the first
// Cesium globe, after this module has loaded on a Navara start.
import { Axis, ScreenSpaceEventType } from 'cesium';

export const modelAxis = () => Axis;
export const trackingEventTypes = () => ScreenSpaceEventType;
