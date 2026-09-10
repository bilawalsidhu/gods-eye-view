/**
 * Chrome launch args that give Cesium a working WebGL context on every
 * dev machine.
 *
 * `--use-angle=metal` is macOS-only: on Linux it leaves the GL context
 * uninitialized, Cesium never finishes booting, and every qa-* script
 * times out waiting for `window.__godsEyeView`. Linux headless falls back
 * to ANGLE/SwiftShader; `--enable-unsafe-swiftshader` is required from
 * Chrome 137 on before software WebGL will initialize (harmless earlier).
 */
export function webglLaunchArgs() {
  return process.platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
}
