/** Keep the native Scope checkbox and feather availability in step with the mask. */
export function syncScopeControls(toggle, featherSlider, enabled) {
  if (toggle) toggle.checked = enabled;
  if (featherSlider) featherSlider.disabled = !enabled;
}
