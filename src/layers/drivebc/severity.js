export const DRIVEBC_SEVERITY_STYLES = Object.freeze([
  Object.freeze({
    key: 'CRITICAL',
    label: 'Critical',
    color: '#ff3131',
    colorName: 'red',
  }),
  Object.freeze({
    key: 'MAJOR',
    label: 'Major',
    color: '#ff5b36',
    colorName: 'orange-red',
  }),
  Object.freeze({
    key: 'MODERATE',
    label: 'Moderate',
    color: '#ffb020',
    colorName: 'amber',
  }),
  Object.freeze({
    key: 'MINOR',
    label: 'Minor',
    color: '#ffd166',
    colorName: 'yellow',
  }),
  Object.freeze({
    key: 'UNKNOWN',
    label: 'Unspecified',
    color: '#59d9ff',
    colorName: 'cyan',
  }),
]);

const BY_KEY = new Map(
  DRIVEBC_SEVERITY_STYLES.map((style) => [style.key, style]),
);

export function driveBcSeverityStyle(severity) {
  return (
    BY_KEY.get(
      String(severity || '')
        .trim()
        .toUpperCase(),
    ) || BY_KEY.get('UNKNOWN')
  );
}
