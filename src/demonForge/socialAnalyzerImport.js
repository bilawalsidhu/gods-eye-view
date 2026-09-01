export const MAX_REPORT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DETECTED_CANDIDATES = 500;
const textEncoder = new TextEncoder();
const ROOT_FIELDS = new Set(['detected', 'unknown', 'failed']);
const DETECTED_FIELDS = new Set(['site', 'url', 'username', 'rate', 'status']);

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

function requireKnownFields(value, allowedFields, label) {
  const unexpected = Object.keys(value).filter((field) => !allowedFields.has(field));
  if (unexpected.length > 0) {
    throw reportImportError('UNSUPPORTED_SCHEMA', `${label} contains unexpected fields: ${unexpected.join(', ')}.`);
  }
}

function defaultCandidateIdFactory() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw reportImportError('ID_GENERATION_UNAVAILABLE', 'Secure opaque ID generation is unavailable.');
  }
  return globalThis.crypto.randomUUID();
}

function normalizeCandidate(row, importedAtMs, candidateIdFactory) {
  if (!isPlainObject(row)) {
    throw reportImportError('UNSUPPORTED_SCHEMA', 'Detected entries must be objects.');
  }
  requireKnownFields(row, DETECTED_FIELDS, 'Detected entry');

  const provider = requireSite(row.site);
  const url = normalizeUrl(row.url);
  const confidence = requireConfidence(row.rate);
  if (row.username != null && typeof row.username !== 'string') {
    throw reportImportError('UNSUPPORTED_SCHEMA', 'Detected username must be a string when present.');
  }
  if (row.status != null && typeof row.status !== 'string') {
    throw reportImportError('UNSUPPORTED_SCHEMA', 'Detected status must be a string when present.');
  }
  const id = candidateIdFactory();
  if (typeof id !== 'string' || !id.trim()) {
    throw reportImportError('ID_GENERATION_UNAVAILABLE', 'Opaque candidate ID generation failed.');
  }

  return {
    id,
    sourceCategory: 'social-profile',
    provider,
    url,
    username: row.username == null ? null : row.username,
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

export function parseSocialAnalyzerReport(jsonText, { importedAtMs, candidateIdFactory = defaultCandidateIdFactory } = {}) {
  if (typeof jsonText !== 'string') {
    throw new ReportImportError('INVALID_JSON', 'Report text must be a string.');
  }

  if (textEncoder.encode(jsonText).length > MAX_REPORT_FILE_BYTES) {
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
  requireKnownFields(report, ROOT_FIELDS, 'Report root');
  if (!Number.isInteger(importedAtMs) || importedAtMs < 0) {
    throw new ReportImportError('INVALID_TIMESTAMP', 'Import timestamp must be a nonnegative integer.');
  }
  if (typeof candidateIdFactory !== 'function') {
    throw new ReportImportError('ID_GENERATION_UNAVAILABLE', 'Opaque candidate ID generation is unavailable.');
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
    candidates: detected.map((row) => normalizeCandidate(row, importedAtMs, candidateIdFactory)),
  };
}
