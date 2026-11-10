/**
 * Keep a native Scope checkbox and feather availability in step with the
 * mask. The Display view renders both from VisualSettings now; this stays
 * exported from `./ui/display` for hosts that imported it.
 * @deprecated
 */
export function syncScopeControls(toggle, featherSlider, enabled) {
  if (toggle) toggle.checked = enabled;
  if (featherSlider) featherSlider.disabled = !enabled;
}
