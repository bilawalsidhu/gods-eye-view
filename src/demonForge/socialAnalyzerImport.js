const MAX_REPORT_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DETECTED_CANDIDATES = 500;
const textEncoder = new TextEncoder();

function reportImportError(code, message) {
  return new ReportImportError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireArray(value, code, fieldName) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw reportImportError(code, `${fieldName} must be an array.`);
}

function requireSite(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw reportImportError('UNSUPPORTED_SCHEMA', 'Detected rows require a nonempty site.');
  }
  return value.trim();
}

function requireConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw reportImportError('UNSUPPORTED_SCHEMA', 'Detected rows require a confidence rate between 0 and 100.');
  }
  return value;
}

function normalizeUrl(value) {
  if (typeof value !== 'string') {
    throw reportImportError('UNSAFE_URL', 'Detected rows require an HTTPS URL.');
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      throw reportImportError('UNSAFE_URL', 'Detected rows require an HTTPS URL.');
    }
    return url.href;
  } catch {
    throw reportImportError('UNSAFE_URL', 'Detected rows require an HTTPS URL.');
  }
}

function normalizeCandidate(row, index, importedAtMs) {
  if (!isPlainObject(row)) {
    throw reportImportError('UNSUPPORTED_SCHEMA', 'Detected entries must be objects.');
  }

  const provider = requireSite(row.site);
  const url = normalizeUrl(row.url);
  const confidence = requireConfidence(row.rate);
  const id = row.id == null ? `${provider}:${index + 1}` : String(row.id);

  return {
    id,
    sourceCategory: 'social-profile',
    provider,
    url,
    username: row.username == null ? null : String(row.username),
    confidence,
    status: 'unverified',
    importedAtMs,
  };
}

export class ReportImportError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ReportImportError';
    this.code = code;
  }
}

export function parseSocialAnalyzerReport(jsonText, { importedAtMs } = {}) {
  if (typeof jsonText !== 'string') {
    throw new ReportImportError('INVALID_JSON', 'Report text must be a string.');
  }

  if (textEncoder.encode(jsonText).length > MAX_REPORT_TEXT_BYTES) {
    throw new ReportImportError('REPORT_TOO_LARGE', 'Report text exceeds the 2 MiB cap.');
  }

  let report;
  try {
    report = JSON.parse(jsonText);
  } catch {
    throw new ReportImportError('INVALID_JSON', 'Report text is not valid JSON.');
  }

  if (!isPlainObject(report)) {
    throw new ReportImportError('UNSUPPORTED_SCHEMA', 'Report root must be an object.');
  }

  const detected = requireArray(report.detected, 'UNSUPPORTED_SCHEMA', 'detected');
  requireArray(report.unknown, 'UNSUPPORTED_SCHEMA', 'unknown');
  requireArray(report.failed, 'UNSUPPORTED_SCHEMA', 'failed');

  if (detected.length > MAX_DETECTED_CANDIDATES) {
    throw new ReportImportError('REPORT_TOO_LARGE', 'Detected candidate cap exceeded.');
  }

  return {
    source: 'social-analyzer',
    importedAtMs,
    candidates: detected.map((row, index) => normalizeCandidate(row, index, importedAtMs)),
  };
}
