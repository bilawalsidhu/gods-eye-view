/** Map an integer tuner slot directly to one available directory station. */
export function radioTunerSlot(value, stationCount) {
  const count = Math.max(0, Math.floor(Number(stationCount) || 0));
  if (!count)
    return {
      slot: 0,
      max: 0,
      locked: false,
      stationIndex: -1,
      leftIndex: -1,
      rightIndex: -1,
    };
  const max = Math.max(0, count - 1);
  const slot = Math.min(max, Math.max(0, Math.round(Number(value) || 0)));
  return {
    slot,
    max,
    locked: true,
    stationIndex: slot,
    leftIndex: slot,
    rightIndex: slot,
  };
}

/** Snap a tuner release to the nearest available directory station. */
export function radioTunerCommitSlot(value, stationCount) {
  return radioTunerSlot(value, stationCount);
}

/** Map one pointer coordinate to continuous absolute directory progress. */
export function radioTunerPointerPosition(
  clientX,
  left,
  width,
  stationCount,
  insetPx = 7,
) {
  const count = Math.max(0, Math.floor(Number(stationCount) || 0));
  if (!count) return { ratio: 0, coordinate: 0, stationIndex: -1 };
  if (count === 1) return { ratio: 0.5, coordinate: 0, stationIndex: 0 };
  const inset = Math.max(0, Number(insetPx) || 0);
  const usableWidth = Math.max(1, (Number(width) || 0) - inset * 2);
  const ratio = Math.min(
    1,
    Math.max(
      0,
      ((Number(clientX) || 0) - (Number(left) || 0) - inset) / usableWidth,
    ),
  );
  const coordinate = ratio * (count - 1);
  return {
    ratio,
    coordinate,
    stationIndex: Math.min(
      count - 1,
      Math.max(0, Math.floor(coordinate + 0.5)),
    ),
  };
}

/** Build a bounded virtual tuner tape around one continuous directory coordinate. */
export function buildRadioTunerTicks(
  coordinate,
  stationCount,
  width,
  {
    insetPx = 7,
    minPitchPx = 14,
    speedFactor = 5,
    overscan = 2,
    labelStep = 6,
  } = {},
) {
  const count = Math.max(0, Math.floor(Number(stationCount) || 0));
  const dialWidth = Math.max(0, Number(width) || 0);
  const inset = Math.max(0, Number(insetPx) || 0);
  const usableWidth = Math.max(0, dialWidth - inset * 2);
  if (!count) return { ticks: [], needleX: inset, pitchPx: 0, ratio: 0 };
  const value = Math.min(count - 1, Math.max(0, Number(coordinate) || 0));
  if (count === 1) {
    return {
      ticks: [
        {
          stationIndex: 0,
          channel: 1,
          xPx: inset + usableWidth / 2,
          current: true,
          label: '01',
        },
      ],
      needleX: inset + usableWidth / 2,
      pitchPx: Math.max(1, Number(minPitchPx) || 14),
      ratio: 0.5,
    };
  }
  const directoryStep = usableWidth / (count - 1);
  const pitchPx = Math.max(
    Math.max(1, Number(minPitchPx) || 14),
    directoryStep * Math.max(1, Number(speedFactor) || 5),
  );
  const needleX = inset + directoryStep * value;
  const overscanPx = pitchPx * Math.max(0, Number(overscan) || 0);
  const first = Math.max(
    0,
    Math.ceil(value + (-overscanPx - needleX) / pitchPx),
  );
  const last = Math.min(
    count - 1,
    Math.floor(value + (dialWidth + overscanPx - needleX) / pitchPx),
  );
  const currentIndex = Math.min(
    count - 1,
    Math.max(0, Math.floor(value + 0.5)),
  );
  const majorEvery = Math.max(1, Math.floor(Number(labelStep) || 6));
  const labelWidth = Math.max(2, String(count).length);
  const ticks = [];
  for (let stationIndex = first; stationIndex <= last; stationIndex += 1) {
    const channel = stationIndex + 1;
    const current = stationIndex === currentIndex;
    const labelled =
      current ||
      stationIndex === 0 ||
      stationIndex === count - 1 ||
      channel % majorEvery === 0;
    ticks.push({
      stationIndex,
      channel,
      xPx: needleX + pitchPx * (stationIndex - value),
      current,
      label: labelled ? String(channel).padStart(labelWidth, '0') : '',
    });
  }
  return { ticks, needleX, pitchPx, ratio: value / (count - 1) };
}
