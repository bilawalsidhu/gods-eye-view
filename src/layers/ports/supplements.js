// Small factual supplements, not copies of articles or commercial datasets.
// Match the stable WPI number, never a fuzzy port name. Each fact states its
// scope, source and reporting period. These are dated references, not live status.
const reviewed = '2026-11-17';
const fact = (value, source, period, scope, published = null) => ({
  value,
  source,
  period,
  scope,
  reviewed,
  published,
});
const DP =
  'https://www.dpworld.com/en/news/releases/uae/dp-world-records-highest-cargo-volumes-at-jebel-ali-port-since-2015';
const MPA =
  'https://www.mpa.gov.sg/port-marine-ops/operations/port-infrastructure/terminals';
const TUAS =
  'https://www.mpa.gov.sg/media-centre/details/opening-remarks-by-mr-ang-wee-keong-chief-executive-maritime-and-port-authority-of-singapore-at-the-tuas-port-phase-2-finger-3-northern-berths-completion-celebration-on-10-november-2026';

/** Optional, field-level primary-source facts. Unlisted facts remain unavailable. */
export const PORT_SUPPLEMENTS = Object.freeze({
  48276: {
    operator: fact(
      'DP World',
      DP,
      'Reported 2025-02-19',
      'Jebel Ali port',
      '2025-02-19',
    ),
    throughput: fact(
      '15,500,000 TEU',
      DP,
      '2024',
      'Jebel Ali port',
      '2025-02-19',
    ),
    capacity: fact(
      '19,400,000 TEU/year',
      DP,
      'Reported 2025-02-19',
      'Jebel Ali port; reported annual capacity across four terminals',
      '2025-02-19',
    ),
  },
  16080: {
    operator: fact(
      'Los Angeles Harbor Department; individual terminals have separate operators',
      'https://portoflosangeles.org/about',
      'Reviewed 2026-11-17',
      'Port authority / landlord',
    ),
    ownership: fact(
      'City of Los Angeles Harbor Department (municipal landlord port)',
      'https://portoflosangeles.org/about',
      'Reviewed 2026-11-17',
      'Port authority; not ownership of every terminal business',
    ),
    throughput: fact(
      '10,239,318 TEU',
      'https://portoflosangeles.org/business/statistics/container-statistics',
      '2025',
      'Port of Los Angeles',
    ),
  },
  50000: {
    operator: fact(
      'PSA Corporation Limited',
      MPA,
      'Reviewed 2026-11-17',
      'Keppel terminal',
    ),
    expansion: fact(
      'Tuas: northern-berth reclamation completed; full four-phase development targets 65,000,000 TEU/year in the 2040s',
      TUAS,
      '2026-11-10',
      'Related Singapore port consolidation project, not Keppel capacity',
      '2026-11-10',
    ),
  },
});
