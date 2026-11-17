// The regional feed includes sightings outside the layer's Salish Sea coverage.
export const ACARTIA_GUARD_BOX = Object.freeze({
  south: 45.5,
  west: -126,
  north: 50.5,
  east: -121,
});

// Frozen, conservative cetacean species/alias list for this regional feed.
// Exact normalized names only: an unfamiliar name must never become a whale
// merely because it contains "whale", "dolphin" or a known species name.
export const ACARTIA_CETACEAN_NAMES = Object.freeze([
  'Orcinus orca',
  'Orca',
  'Killer whale',
  'Southern resident killer whale',
  'Northern resident killer whale',
  'Resident killer whale',
  "Bigg's killer whale",
  'Transient killer whale',
  'Offshore killer whale',
  'Megaptera novaeangliae',
  'Humpback whale',
  'Humpback',
  'Eschrichtius robustus',
  'Gray whale',
  'Grey whale',
  'Balaenoptera acutorostrata',
  'Common minke whale',
  'Minke whale',
  'Balaenoptera physalus',
  'Fin whale',
  'Finback whale',
  'Balaenoptera musculus',
  'Blue whale',
  'Balaenoptera borealis',
  'Sei whale',
  'Eubalaena japonica',
  'North Pacific right whale',
  'Physeter macrocephalus',
  'Sperm whale',
  'Kogia breviceps',
  'Pygmy sperm whale',
  'Kogia sima',
  'Dwarf sperm whale',
  'Berardius bairdii',
  "Baird's beaked whale",
  'Ziphius cavirostris',
  "Cuvier's beaked whale",
  'Mesoplodon carlhubbsi',
  "Hubbs' beaked whale",
  'Mesoplodon stejnegeri',
  "Stejneger's beaked whale",
  'Mesoplodon ginkgodens',
  'Ginkgo-toothed beaked whale',
  'Phocoena phocoena',
  'Harbor porpoise',
  'Harbour porpoise',
  'Phocoenoides dalli',
  "Dall's porpoise",
  'Lagenorhynchus obliquidens',
  'Pacific white-sided dolphin',
  'Lissodelphis borealis',
  'Northern right whale dolphin',
  'Grampus griseus',
  "Risso's dolphin",
  'Delphinus delphis',
  'Short-beaked common dolphin',
  'Common dolphin',
  'Delphinus capensis',
  'Long-beaked common dolphin',
  'Tursiops truncatus',
  'Common bottlenose dolphin',
  'Bottlenose dolphin',
  'Delphinapterus leucas',
  'Beluga whale',
  'Beluga',
  'Pseudorca crassidens',
  'False killer whale',
  'Globicephala macrorhynchus',
  'Short-finned pilot whale',
]);

// These names clearly identify a marine mammal but do not establish a species
// in the cetacean list. Retain them for ALL/MAMMALS, never for WHALES.
const OTHER_MARINE_MAMMAL_NAMES = Object.freeze([
  'Phoca vitulina',
  'Harbor seal',
  'Harbour seal',
  'Mirounga angustirostris',
  'Northern elephant seal',
  'Zalophus californianus',
  'California sea lion',
  'Eumetopias jubatus',
  'Steller sea lion',
  "Steller's sea lion",
  'Callorhinus ursinus',
  'Northern fur seal',
  'Enhydra lutris',
  'Sea otter',
  'Seal',
  'Unidentified seal',
  'Sea lion',
  'Unidentified sea lion',
  'Pinniped',
  'Unidentified pinniped',
  'Marine mammal',
  'Unidentified marine mammal',
  'Unknown marine mammal',
  'Cetacean',
  'Unidentified cetacean',
  'Unknown cetacean',
  'Whale',
  'Unidentified whale',
  'Unknown whale',
  'Dolphin',
  'Unidentified dolphin',
  'Unknown dolphin',
  'Porpoise',
  'Unidentified porpoise',
  'Unknown porpoise',
]);

function speciesKey(value) {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/\s+/g, ' ')
    : '';
}

const CETACEANS = new Set(ACARTIA_CETACEAN_NAMES.map(speciesKey));
const OTHER_MARINE_MAMMALS = new Set(OTHER_MARINE_MAMMAL_NAMES.map(speciesKey));

/** Classify exact normalized species names; ambiguous sightings stay noncetacean. */
export function acartiaSpeciesGroup(value) {
  const key = speciesKey(value);
  if (CETACEANS.has(key)) return 'cetacean';
  return OTHER_MARINE_MAMMALS.has(key) ? 'marine-mammal' : null;
}

/** Accept only positions inside the supported Salish Sea coverage. */
export function inAcartiaCoverage(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= ACARTIA_GUARD_BOX.south &&
    lat <= ACARTIA_GUARD_BOX.north &&
    lon >= ACARTIA_GUARD_BOX.west &&
    lon <= ACARTIA_GUARD_BOX.east
  );
}
