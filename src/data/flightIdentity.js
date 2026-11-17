// Explicit aliases only: unknown airline codes are never guessed.
const AIRLINES = Object.freeze({
  UA: 'UAL',
  AA: 'AAL',
  DL: 'DAL',
  WN: 'SWA',
  BA: 'BAW',
  AF: 'AFR',
  LH: 'DLH',
  EK: 'UAE',
  QR: 'QTR',
  SQ: 'SIA',
});

/** Normalize a flight number identically for typed and spoken aircraft search. */
export function normalizeFlightIdentity(value) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase();
  const match = /^([A-Z]{2,3})[ -]*(\d{1,4}[A-Z]?)$/.exec(text);
  if (!match) return text;
  return `${AIRLINES[match[1]] || match[1]}${match[2].replace(/^0+(?=\d)/, '')}`;
}
