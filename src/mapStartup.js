/**
 * Activate the preferred startup stack. MapStackController owns the honest OSM
 * fallback when the Azure Maps BFF or its upstream service is unavailable.
 */
export async function startDefaultMapStack(controller) {
  if (!controller?.setStack) throw new TypeError('A map stack controller is required');
  return controller.setStack('azure-satellite', { silent: true });
}
