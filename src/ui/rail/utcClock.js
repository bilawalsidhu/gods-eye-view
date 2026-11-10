/**
 * "HH:MM UTC" of a time, or '' when it is not one. Computed on its own rather
 * than cut from the dated readout: the localized day and month vary in length
 * ("3/9" in Spanish, "09-03" in English).
 */
export const utcClock = (tick) =>
  Number.isFinite(Date.parse(tick))
    ? `${new Date(tick).toISOString().slice(11, 16)} UTC`
    : '';
