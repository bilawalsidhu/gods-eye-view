import {
  RADIO_LABEL_SEGMENTER,
  RADIO_GLOBE_LABEL_MAX_CHARS,
  RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
  RADIO_CATEGORY_COLORS,
} from './policy.js';

export function createLabels({ state: layerState, services, parts, source }) {
  function compactRadioLabelText(value, maxChars) {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    const graphemes = RADIO_LABEL_SEGMENTER
      ? [...RADIO_LABEL_SEGMENTER.segment(text)].map(
          (segment) => segment.segment,
        )
      : Array.from(text);
    if (graphemes.length <= maxChars) return text;
    return `${graphemes
      .slice(0, Math.max(1, maxChars - 1))
      .join('')
      .trimEnd()}…`;
  }

  function cleanRadioLabelName(value) {
    return String(value || '')
      .replace(/^[\s|:·\-–—]+|[\s|:·\-–—]+$/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+\([^()]{1,40}\)$/, '')
      .replace(/\s+FM$/i, '')
      .trim();
  }

  /** Return compact frequency-first text for a Radio globe label. */

  function radioGlobeLabel(station) {
    const fullName = String(station?.name || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!fullName) return '';

    let frequency = null;
    let labelName = '';
    const explicitMatches = [
      ...fullName.matchAll(/(\d{2,3}(?:\.\d{1,2})?)\s*FM\b/gi),
    ];
    const explicit = explicitMatches.find((match) => {
      const value = Number(match[1]);
      return value >= 64 && value <= 108;
    });
    if (explicit) {
      frequency = explicit[1];
      const before = cleanRadioLabelName(fullName.slice(0, explicit.index));
      const after = cleanRadioLabelName(
        fullName.slice(explicit.index + explicit[0].length),
      );
      labelName = before || after;
    } else {
      // Infer only a leading decimal in the conventional FM band. Integers such
      // as "80's" or "100 GREATEST" and domains such as "1.fm" stay names.
      const leading = fullName.match(
        /^(\d{2,3}\.\d{1,2})(?:\s+|\s*[-–—]\s*)(.+)$/,
      );
      const value = Number(leading?.[1]);
      if (leading && value >= 87.5 && value <= 108) {
        frequency = leading[1];
        labelName = cleanRadioLabelName(leading[2].split(/\s+[-–—]\s+/)[0]);
      }
    }

    if (!frequency)
      return compactRadioLabelText(fullName, RADIO_GLOBE_LABEL_MAX_CHARS);
    const prefix = `${frequency} FM`;
    if (!labelName) return prefix;
    const nameBudget = RADIO_GLOBE_LABEL_MAX_CHARS - prefix.length - 3;
    return `${prefix} — ${compactRadioLabelText(labelName, nameBudget)}`;
  }

  /** Build the protected selected-station text published through WorldOverlay. */

  function createRadioSelectedOverlayEntry(station, position) {
    if (!station?.id || !station?.name || !position) return null;
    return {
      id: `selected:${station.id}`,
      position,
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-label',
      priority: Number.MAX_SAFE_INTEGER,
      title: radioGlobeLabel(station),
      accent: parts.model.radioCategoryColor(
        parts.model.radioStationCategoryId(station),
      ),
      interactive: false,
      anchorRadiusPx: 20,
      minAnchorGapPx: 8,
      verticalOnly: true,
      placement: 'above',
      gapPx: 8,
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      maxDistance: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
    };
  }

  /** Build one bounded ambient cluster badge for the shared overlay host. */

  function createRadioClusterOverlayEntry({
    id,
    position,
    text,
    accent,
    stationCount,
  }) {
    if (!id || !position || !text) return null;
    return {
      id: `cluster:${id}`,
      position,
      variant: 'label',
      paintLane: 'ambient-label',
      collisionGroup: 'ambient-label',
      priority: Math.max(1, Number(stationCount) || 1),
      title: text,
      accent: accent || RADIO_CATEGORY_COLORS.other,
      interactive: false,
      anchorRadiusPx: Math.min(
        13,
        6 + Math.log2(Math.max(1, Number(stationCount) || 1)) * 0.8,
      ),
      minAnchorGapPx: 4,
      verticalOnly: true,
      placement: 'above',
      gapPx: 6,
      // Cluster membership/counts update continuously while the camera moves.
      // Paint them as hard-opacity incumbents so a replacement count never
      // cross-fades with its predecessor or dims merely for leaving the keyhole.
      // Collision, viewport rejection, and horizon culling remain host-owned.
      stateless: true,
      edgeFade: 'none',
      horizonCull: true,
      terrainOcclusion: false,
      // The camera can sit above 24,000 km in the supported full-globe view, and
      // horizon clusters are farther from it than the camera's surface altitude.
      maxDistance: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
      distanceScale: {
        near: 100_000,
        nearValue: 1.08,
        far: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
        farValue: 0.92,
      },
    };
  }

  /** Build one ambient station label while Cesium retains its point and picking. */

  function createRadioSingletonOverlayEntry({
    station,
    position,
    priority = 1,
  }) {
    if (!station?.id || !station?.name || !position) return null;
    return {
      id: `station:${station.id}`,
      position,
      variant: 'label',
      paintLane: 'ambient-label',
      collisionGroup: 'ambient-label',
      priority: Math.max(1, Number(priority) || 1),
      title: radioGlobeLabel(station),
      accent: parts.model.radioCategoryColor(
        parts.model.radioStationCategoryId(station),
      ),
      interactive: false,
      anchorRadiusPx: 9,
      minAnchorGapPx: 4,
      verticalOnly: true,
      placement: 'above',
      gapPx: 5,
      // Camera/filter changes replace this bounded cohort. Prevent the prior
      // cohort from fading over the current visible points.
      stateless: true,
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      maxDistance: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
      distanceScale: {
        near: 100_000,
        nearValue: 1,
        far: RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
        farValue: 0.86,
      },
    };
  }

  /** Build the code-native four-corner bracket used by the selected station. */

  function radioSelectionBracketSvg(color = RADIO_CATEGORY_COLORS.other) {
    const stroke = /^#[0-9a-f]{6}$/i.test(String(color))
      ? String(color)
      : RADIO_CATEGORY_COLORS.other;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><path d="M2 13V2H13 M27 2H38V13 M38 27V38H27 M13 38H2V27" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="square"/></svg>`;
  }
  return {
    compactRadioLabelText,
    cleanRadioLabelName,
    radioGlobeLabel,
    createRadioSelectedOverlayEntry,
    createRadioClusterOverlayEntry,
    createRadioSingletonOverlayEntry,
    radioSelectionBracketSvg,
  };
}
