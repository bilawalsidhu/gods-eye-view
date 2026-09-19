import { decodeDestination } from './ais-locode.js';

/**
 * What a ship is carrying — as far as the evidence honestly goes.
 *
 * AIS has no manifest field. Nothing in this module can tell you a hold holds
 * 170,000 tonnes of coking coal. Three weaker signals exist, and they are kept
 * strictly separate so a caller always knows which one it has:
 *
 *   BROADCAST — the ship itself declares an IMO dangerous-goods category in
 *               its AIS type code. This is stated by the vessel, not inferred.
 *   LIKELY    — a laden hull working a single-commodity terminal. Port Hedland
 *               ships iron ore and very little else, so a bulk carrier loading
 *               there is carrying iron ore with high confidence — but it is
 *               still an inference from geography, not a document.
 *   CLASS     — only the broad category the hull is built for: liquid bulk in
 *               a tanker, dry or general cargo in a freighter.
 *
 * Anything weaker than that returns nothing at all.
 */

/**
 * IMO hazard/pollutant categories carried in the second digit of an AIS cargo
 * or tanker type code (71-74, 81-84). Category A is the most hazardous tier.
 */
const HAZARD_CATEGORIES = Object.freeze({
  1: { category: 'A', note: 'most hazardous tier' },
  2: { category: 'B', note: '' },
  3: { category: 'C', note: '' },
  4: { category: 'D', note: 'least hazardous tier' },
});

/**
 * Single-commodity terminals.
 *
 * Deliberately restricted to ports whose throughput is overwhelmingly one
 * trade. Rotterdam and Singapore handle everything, so they are absent: an
 * inference there would be worthless and misleading. `modes` lists the AIS
 * families the inference applies to — a tanker at an iron-ore berth is not
 * loading iron ore.
 */
const PORT_COMMODITY = Object.freeze({
  // Australian bulk export terminals
  AUNTL: { commodity: 'coal', modes: ['cargo'], role: 'export' },
  AUHAY: { commodity: 'coal', modes: ['cargo'], role: 'export' },
  AUABP: { commodity: 'coal', modes: ['cargo'], role: 'export' },
  AUPKL: { commodity: 'coal', modes: ['cargo'], role: 'export' },
  AUPHE: { commodity: 'iron ore', modes: ['cargo'], role: 'export' },
  AUDPO: { commodity: 'iron ore', modes: ['cargo'], role: 'export' },
  AUWAL: { commodity: 'iron ore', modes: ['cargo'], role: 'export' },
  // Brazilian ore and grain
  BRTUB: { commodity: 'iron ore', modes: ['cargo'], role: 'export' },
  BRPNG: { commodity: 'grain and soy', modes: ['cargo'], role: 'export' },
  // Gulf crude and gas
  SARTA: { commodity: 'crude oil', modes: ['tanker'], role: 'export' },
  SAJUB: { commodity: 'crude oil', modes: ['tanker'], role: 'export' },
  SAYNB: { commodity: 'crude oil', modes: ['tanker'], role: 'export' },
  QARLF: { commodity: 'LNG', modes: ['tanker'], role: 'export' },
  AEDAS: { commodity: 'crude oil', modes: ['tanker'], role: 'export' },
  KWMIB: { commodity: 'crude oil', modes: ['tanker'], role: 'export' },
  IQBSR: { commodity: 'crude oil', modes: ['tanker'], role: 'export' },
  // Refining and petrochemical import complexes
  TWMLI: {
    commodity: 'crude oil and petrochemical feedstock',
    modes: ['tanker'],
    role: 'import',
  },
  // Chinese ore import
  CNQIN: { commodity: 'iron ore', modes: ['cargo'], role: 'import' },
  CNRZH: { commodity: 'iron ore', modes: ['cargo'], role: 'import' },
  // US grain
  USNOL: { commodity: 'grain', modes: ['cargo'], role: 'export' },
});

/** Broad AIS family for a type code: 'cargo', 'tanker', or ''. */
export function cargoFamily(typeCode) {
  const code = Number(typeCode);
  if (!Number.isFinite(code)) return '';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 80 && code <= 89) return 'tanker';
  return '';
}

/**
 * IMO dangerous-goods declaration carried in the AIS type code.
 * @returns {{category:string, label:string, note:string}|null}
 */
export function hazardDeclaration(typeCode) {
  const family = cargoFamily(typeCode);
  if (!family) return null;
  const hazard = HAZARD_CATEGORIES[Number(typeCode) % 10];
  if (!hazard) return null;
  return {
    category: hazard.category,
    note: hazard.note,
    label: `dangerous goods, harmful substances or marine pollutants — IMO category ${hazard.category}`,
  };
}

/** The commodity a terminal is built for, when it is built for only one. */
export function terminalCommodity(destination, typeCode) {
  const decoded = decodeDestination(destination);
  if (!decoded.text) return null;
  const compact = decoded.text.replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const entry = PORT_COMMODITY[compact];
  if (!entry) return null;
  const family = cargoFamily(typeCode);
  // A tanker at an ore berth is not loading ore.
  if (family && !entry.modes.includes(family)) return null;
  return { ...entry, port: decoded.port || decoded.text };
}

/**
 * Best available statement about cargo.
 *
 * @param {Object} record Live vessel row.
 * @param {{trend:string, deltaM:number|null}} draughtTrend From the narrative engine.
 * @returns {{statement:string, confidence:'BROADCAST'|'LIKELY'|'CLASS'|'UNKNOWN', basis:Array<string>}}
 */
export function inferCargo(
  record,
  draughtTrend = { trend: 'UNKNOWN', deltaM: null },
) {
  const basis = [];
  const family = cargoFamily(record?.type);
  const hazard = hazardDeclaration(record?.type);
  const loadState = String(record?.load_state || '').trim();
  const terminal = terminalCommodity(record?.destination, record?.type);
  const alongside = Number(record?.nav_status) === 5;
  const laden = loadState === 'LADEN' || draughtTrend?.trend === 'LOADING';

  // Strongest: the ship declares hazardous cargo itself.
  if (hazard) {
    basis.push('IMO hazard category declared in the AIS type code');
    const carrier = family === 'tanker' ? 'tanker' : 'freighter';
    return {
      statement: `Declares ${hazard.label}. A ${carrier} carrying category ${hazard.category} cargo${hazard.note ? ` (${hazard.note})` : ''}.`,
      confidence: 'BROADCAST',
      basis,
    };
  }

  // Next: a single-commodity terminal, but only with evidence of cargo work.
  if (terminal && (alongside || laden)) {
    basis.push(
      `${terminal.port} handles almost exclusively ${terminal.commodity}`,
    );
    if (draughtTrend?.trend === 'LOADING') basis.push('draught rising');
    else if (draughtTrend?.trend === 'DISCHARGING')
      basis.push('draught falling');
    else if (laden) basis.push('riding laden');
    const verb =
      draughtTrend?.trend === 'LOADING'
        ? 'Loading'
        : draughtTrend?.trend === 'DISCHARGING'
          ? 'Discharging'
          : terminal.role === 'export'
            ? 'Most likely loading'
            : 'Most likely discharging';
    return {
      statement: `${verb} ${terminal.commodity} at ${terminal.port}. Inferred from the terminal, not from a manifest.`,
      confidence: 'LIKELY',
      basis,
    };
  }

  // Otherwise only the class the hull is built for.
  if (family === 'tanker') {
    basis.push('AIS type code is a tanker');
    const state = loadState === 'BALLAST' ? ' It is running empty.' : '';
    return {
      statement: `Liquid bulk — oil, chemicals or gas. AIS does not say which.${state}`,
      confidence: 'CLASS',
      basis,
    };
  }
  if (family === 'cargo') {
    basis.push('AIS type code is a freighter');
    const state = loadState === 'BALLAST' ? ' It is running empty.' : '';
    return {
      statement: `Dry or general cargo. AIS does not say what.${state}`,
      confidence: 'CLASS',
      basis,
    };
  }

  // An absent type is not the same claim as a non-cargo type: saying a hull
  // carries nothing because it never said what it is would be an assertion the
  // evidence does not support.
  const declared = String(record?.type ?? '').trim();
  if (!declared) {
    return {
      statement: 'No ship type broadcast, so its cargo class is unknown.',
      confidence: 'UNKNOWN',
      basis: ['no AIS ship type received'],
    };
  }
  return {
    statement: 'Not a cargo-carrying type, so nothing to carry.',
    confidence: 'UNKNOWN',
    basis: ['AIS ship type is not cargo or tanker'],
  };
}
