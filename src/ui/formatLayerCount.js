import { formatNumber } from '../i18n/index.js';

/** Compact layer summaries; exact record values belong in their details. */
export function formatLayerCount(count) {
  const unit =
    count >= 999950000 ? 'B' : count >= 999950 ? 'M' : count >= 1e3 ? 'K' : '';
  const scale =
    unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  return (
    formatNumber(count / scale, {
      maximumFractionDigits: unit ? 1 : 0,
      useGrouping: false,
    }) + unit
  );
}
