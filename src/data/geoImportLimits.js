// Import resource ceilings and placement thresholds shared by readers and drawing.
// Values without a timing measurement are the existing import policy budgets.

// Bound the file read and XML/JSON parse; the picker policy allows 50 MiB.
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
// Stop zip bombs before allocation; the KMZ policy allows 120 MiB inflated.
export const MAX_KMZ_INFLATED_BYTES = 120 * 1024 * 1024;
// Bound retained files and drawing sets; the session UI policy allows twelve.
export const MAX_IMPORTED_FILES = 12;
// Bound drawing objects per file; the import policy allows 20,000 entities.
export const MAX_IMPORT_ENTITIES = 20_000;
// Bound total coordinate work; the import policy allows 250,000 positions.
export const MAX_IMPORT_POSITIONS = 250_000;
// Bound style/link normalization and image lookup; policy allows 2,000 links.
export const MAX_KML_LINKS = 2_000;
// Reject implausible coordinates; the reader policy accepts heights to 1,000 km.
export const MAX_IMPORT_HEIGHT_M = 1_000_000;
// Bound pending reads; the existing reader deadline is one minute.
export const IMPORT_TIMEOUT_MS = 60_000;
// Bound feature labels retained in records; the existing label policy is 120 chars.
export const MAX_IMPORT_NAME_LENGTH = 120;
// Bound file names in the import list; the existing row policy is 60 chars.
export const MAX_IMPORT_DISPLAY_NAME_LENGTH = 60;
// Bound decoded local images to 64 MiB RGBA per file, from the image memory budget.
export const MAX_IMPORT_IMAGE_PIXELS = 16 * 1024 * 1024;
// Reject oversized raster axes before decoding; the existing image ceiling is 8K.
export const MAX_IMPORT_IMAGE_SIDE = 8192;
// Bound sprite canvases to 64 MiB RGBA per file, from the icon memory budget.
export const ICON_PIXEL_BUDGET = 16 * 1024 * 1024;
// Bound transformed overlay canvases to 64 MiB RGBA, from the overlay memory budget.
export const OVERLAY_PIXEL_BUDGET = 16 * 1024 * 1024;
// Bound each transformed overlay texture; the existing canvas ceiling is 4K.
export const MAX_OVERLAY_SIDE = 4096;
// Bound each icon canvas; the existing sprite ceiling is 512 pixels.
export const MAX_ICON_SIDE = 512;
// Bound high-DPI sprite memory; the existing raster scale ceiling is 2x.
export const MAX_ICON_PIXEL_RATIO = 2;
// Bound triangulation: measured 32,768 vertices in 58 ms, versus 198 ms at 65,536.
export const MAX_RAISED_VERTICES = 32_768;
// Bound holes and outlines: 128 rings took 37 ms; 1,000 holes took 110 ms.
export const MAX_RAISED_RINGS = 128;
// Yield between polygons after half a 60 Hz frame, preserving the 8 ms work slice.
export const POLYGON_YIELD_MS = 8;
// Keep below-ellipsoid ground visible at the horizon, matching GhostMaps' 2 km lift.
export const HORIZON_LIFT_M = 2000;

// Cesium draws ground lines over fills and ground rectangles over layer rasters.
export const POLYGON_ORDER = 0;
export const LINE_ORDER = 1;
export const OVERLAY_ORDER = 30;
