/**
 * @file Brand colour of major airlines, as a solid `#RRGGBB`.
 *
 * A solid colour is a fact about a livery, not the logo or the livery artwork,
 * and no image is bundled. These are curated approximations of each carrier's
 * principal brand colour, used to tint a card, and every other airline stays
 * null. Keys are ICAO airline designators. The builder fails when a key is not
 * in the airline catalog.
 */

/** @type {Record<string, string>} */
export const TAIL_COLORS = {
  AAL: '#0078D2',
  ACA: '#F01428',
  AFR: '#002157',
  ANA: '#13448F',
  BAW: '#075AAA',
  CPA: '#006564',
  DAL: '#C01933',
  DLH: '#05164D',
  EZY: '#FF6600',
  FDX: '#4D148C',
  FIN: '#0B1560',
  IBE: '#D7192D',
  JAL: '#E60012',
  JBU: '#003876',
  KAL: '#00256C',
  KLM: '#00A1DE',
  QFA: '#E40000',
  QTR: '#5C0632',
  RYR: '#073590',
  SIA: '#00266B',
  SWA: '#304CB2',
  SWR: '#E30613',
  THY: '#C70A0C',
  UAE: '#D71921',
  UAL: '#0033A0',
  UPS: '#351C15',
  VIR: '#DA1F3D',
  WZZ: '#C6007E',
};
