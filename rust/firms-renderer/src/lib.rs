//! firms-renderer — WASM heatmap renderer for FIRMS 100k fire detections.
//!
//! Renders Gaussian splats onto an OffscreenCanvas via pixel-bucket accumulation,
//! replacing the JS fillRect loop in `firmsHeatmap.js`. Target: 32 → 50+ FPS.
//!
//! ## Architecture
//!
//! - `render_heatmap(data, width, height) -> ImageData` — main entry point
//! - All rendering happens on the WASM side; JS only handles the Cesium imagery
//!   layer upload and the OffscreenCanvas transfer

use wasm_bindgen::prelude::*;

/// Main entry point: renders all fire detections onto an RGBA pixel buffer.
///
/// # Arguments
/// * `lons` — flat array of longitude values (f64)
/// * `lats` — flat array of latitude values (f64)
/// * `brights` — flat array of brightness values (i32, -1 = no detection)
/// * `width` — canvas width in pixels
/// * `height` — canvas height in pixels
/// * `min_lon`, `max_lon`, `min_lat`, `max_lat` — geographic bounding box
///
/// # Returns
/// A `js_sys::Uint8ClampedArray` RGBA pixel buffer of size `width * height * 4`.
/// The alpha channel encodes the heatmap intensity (0 = no fire, 255 = max).
#[wasm_bindgen]
pub fn render_heatmap(
    lons: &[f64],
    lats: &[f64],
    brights: &[i32],
    width: u32,
    height: u32,
    min_lon: f64,
    max_lon: f64,
    min_lat: f64,
    max_lat: f64,
) -> js_sys::Uint8ClampedArray {
    let size = (width * height * 4) as usize;
    let mut pixels = vec![0u8; size];

    let lon_scale = (width as f64) / (max_lon - min_lon).max(1e-9);
    let lat_scale = (height as f64) / (max_lat - min_lat).max(1e-9);

    for i in 0..lons.len().min(lats.len()).min(brights.len()) {
        let lon = lons[i];
        let lat = lats[i];
        let brightness = brights[i];

        if brightness < 0 {
            continue; // no detection
        }

        // Normalize to pixel coordinates
        let px = ((lon - min_lon) * lon_scale) as u32;
        let py = ((max_lat - lat) * lat_scale) as u32; // flip Y for screen

        if px >= width || py >= height {
            continue;
        }

        // Normalize brightness: typical range 300–500 Kelvin
        // Map to 0–255 intensity
        let intensity = ((brightness as f64 - 300.0) / 200.0 * 255.0) as u8;
        let intensity = intensity.clamp(0, 255);

        // Accumulate into 3x3 pixel neighborhood for Gaussian splat
        let cx = px as i32;
        let cy = py as i32;
        let sigma = 1.5; // Gaussian spread

        for dy in -2..=2 {
            for dx in -2..=2 {
                let nx = cx + dx;
                let ny = cy + dy;
                if nx < 0 || ny < 0 || nx >= width as i32 || ny >= height as i32 {
                    continue;
                }
                let dist_sq = (dx * dx + dy * dy) as f64;
                let weight = (-dist_sq / (2.0 * sigma * sigma)).exp();
                let add = (intensity as f64 * weight) as u8;

                let idx = ((ny as u32) * width + (nx as u32)) as usize * 4;
                // Add RGBA: R = intensity, G = intensity*0.6 (orange), B = 0, A = heat
                pixels[idx] = pixels[idx].saturating_add(add);        // R
                pixels[idx + 1] = pixels[idx + 1].saturating_add((add as f64 * 0.6) as u8); // G
                pixels[idx + 2] = 0;                                // B
                pixels[idx + 3] = pixels[idx + 3].saturating_add(add); // A (heat)
            }
        }
    }

    // Clamp alpha values to max
    for i in (0..size).step_by(4) {
        pixels[i + 3] = pixels[i + 3].min(255);
    }

    let arr = js_sys::Uint8ClampedArray::new_with_length(size as u32);
    arr.copy_from(&pixels);
    arr
}

/// Version info exported for debugging.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
