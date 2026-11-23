const AIRBAND_START_KHZ = 118_000;
const AIRBAND_END_KHZ = 137_000;
const CHANNEL_BLOCK_KHZ = 25;

/**
 * Parse a published civil VHF channel designator for receive tuning.
 * @param {string} input Channel in MHz, accepting a decimal point or comma.
 * @returns {{label: string, frequencyHz: number, spacingKhz: 25|8.33}|null}
 */
export function parseAtcChannel(input) {
  if (typeof input !== 'string') return null;
  const match = /^(\d{3})(?:[.,](\d{1,3}))?$/.exec(input.trim());
  if (!match) return null;

  const [, whole, fraction = ''] = match;
  const channelKhz = Number(whole) * 1_000 + Number(fraction.padEnd(3, '0'));
  if (channelKhz < AIRBAND_START_KHZ || channelKhz >= AIRBAND_END_KHZ)
    return null;

  // EUROCONTROL's 8.33 kHz handbook, Appendix A: in each 25 kHz block,
  // designators +5, +10 and +15 refer to carriers at +0, +8⅓ and +16⅔ kHz.
  const offset = channelKhz % CHANNEL_BLOCK_KHZ;
  if (offset > 15 || offset % 5 !== 0) return null;

  const isNarrow = offset !== 0;
  const carrierOffsetHz = isNarrow
    ? Math.round((offset / 5 - 1) * (25_000 / 3))
    : 0;
  return {
    label: (channelKhz / 1_000).toFixed(3),
    frequencyHz: (channelKhz - offset) * 1_000 + carrierOffsetHz,
    spacingKhz: isNarrow ? 8.33 : 25,
  };
}
