- Add Paraguay INFONA daily estimated fire areas to the existing Fire Perimeters layer, with hectares, source dates, distinct styling and independent bounded source caching.
  (radianx, #1150).

- Refresh fire perimeter geometry even when its report date and area are unchanged. Add a browser gate for INFONA/WFIGS polygon selection and painted cards using the native GPU in headful mode.
  (radianx, #1150).

- Localize the INFONA presentation, identify WFIGS rows explicitly, and preserve WFIGS last-good snapshots and its 16 MiB response cap while keeping INFONA bounded. (radianx, #1150).

Includes Simplified Chinese UI copy and locale regressions, preserving source attribution, interpolation and locale-specific number/date formatting.
