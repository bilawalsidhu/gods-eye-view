export const ERROR_LOG_LIMIT = 30;

export const ERROR_STORAGE_KEY = 'gev-realtime-errors';

export const DEBUG_LOG_URL = '/api/realtime/debug-log';

export function createDebugSessionId() {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `gev-${Date.now().toString(36)}-${randomPart}`;
}

export function postDebugLog(record) {
  try {
    const body = JSON.stringify(record);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(DEBUG_LOG_URL, blob)) return;
    }
    fetch(DEBUG_LOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length < 60000,
    }).catch(() => {});
  } catch {
    // Debug logging must never affect voice control.
  }
}

export function sanitizeDebugValue(value, depth = 0) {
  if (depth > 10) return '[MaxDepth]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (typeof value === 'string') return sanitizeDebugString(value);
  if (Array.isArray(value))
    return value.map((item) => sanitizeDebugValue(item, depth + 1));
  if (typeof value !== 'object') return String(value);

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretLikeKey(key)) {
      output[key] = '[Redacted]';
      continue;
    }
    output[key] = sanitizeDebugValue(item, depth + 1);
  }
  return output;
}

export function sanitizeDebugString(value) {
  if (value.startsWith('data:image/')) {
    return `[Redacted image data URL, ${value.length} chars]`;
  }
  const redacted = value
    .replace(/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[Redacted OpenAI API key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [Redacted]')
    .replace(/"client_secret"\s*:\s*"[^"]+"/gi, '"client_secret":"[Redacted]"')
    .replace(
      /"value"\s*:\s*"ek_[^"]+"/gi,
      '"value":"[Redacted ephemeral key]"',
    );
  const maxLength = 50000;
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}...[Truncated ${redacted.length - maxLength} chars]`
    : redacted;
}

export function isSecretLikeKey(key) {
  return /(?:api[_-]?key|authorization|bearer|client[_-]?secret|token|secret|password)/i.test(
    key,
  );
}

export function createErrorRecord(source, error, extra = {}) {
  const rtcError = error?.error || error;
  return {
    timestamp: new Date().toISOString(),
    source,
    name: rtcError?.name || null,
    message:
      rtcError?.message ||
      extra.errorText ||
      String(error?.message || '').trim() ||
      'No browser error message supplied',
    errorDetail: rtcError?.errorDetail || null,
    sctpCauseCode: rtcError?.sctpCauseCode ?? null,
    receivedAlert: rtcError?.receivedAlert ?? null,
    sentAlert: rtcError?.sentAlert ?? null,
    ...removeEmptyValues(extra),
  };
}

export function formatErrorForDisplay(record) {
  const primary = [record.source, record.message].filter(Boolean).join(': ');
  const state = [
    record.errorDetail && `detail=${record.errorDetail}`,
    record.code && `code=${record.code}`,
    record.sctpCauseCode != null && `sctp=${record.sctpCauseCode}`,
    record.connectionState && `pc=${record.connectionState}`,
    record.iceConnectionState && `ice=${record.iceConnectionState}`,
    record.dataChannelState && `dc=${record.dataChannelState}`,
  ]
    .filter(Boolean)
    .join(' | ');
  return state ? `${primary}\n${state}` : primary;
}

export function removeEmptyValues(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(
      ([, item]) => item !== null && item !== undefined && item !== '',
    ),
  );
}

export function compactText(value, maxLength) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export function loadStoredErrors() {
  try {
    const value = JSON.parse(localStorage.getItem(ERROR_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, ERROR_LOG_LIMIT) : [];
  } catch {
    return [];
  }
}

export function storeErrors(errors) {
  try {
    localStorage.setItem(
      ERROR_STORAGE_KEY,
      JSON.stringify(errors.slice(0, ERROR_LOG_LIMIT)),
    );
  } catch {
    // Diagnostics still remain available in memory and the console.
  }
}

/** Own bounded error history and sanitized optional diagnostics. */
export class RealtimeDiagnostics {
  constructor({
    readStatus,
    readChannel,
    readPeer,
    readCostTracker,
    debugSink,
    operations,
  }) {
    Object.assign(
      this,
      { readStatus, readChannel, readPeer, readCostTracker },
      operations,
    );
    this.debugSink = debugSink;
    this.errors = loadStoredErrors();
    this.sessionId = createDebugSessionId();
  }
  get status() {
    return this.readStatus();
  }
  get dc() {
    return this.readChannel();
  }
  get pc() {
    return this.readPeer();
  }
  get costTracker() {
    return this.readCostTracker();
  }

  reportError(source, error = null, extra = {}) {
    const record = createErrorRecord(source, error, extra);
    this.errors.unshift(record);
    this.errors.length = Math.min(this.errors.length, ERROR_LOG_LIMIT);
    storeErrors(this.errors);
    console.error('[GEV Realtime]', record);
    this.debugLog('error', record);
    this.setStatus('error', formatErrorForDisplay(record));
    return record;
  }

  connectionDiagnostics(dataChannel = this.dc) {
    return {
      dataChannelState: dataChannel?.readyState || null,
      connectionState: this.pc?.connectionState || null,
      iceConnectionState: this.pc?.iceConnectionState || null,
      iceGatheringState: this.pc?.iceGatheringState || null,
      signalingState: this.pc?.signalingState || null,
      sctpState: this.pc?.sctp?.transport?.state || null,
    };
  }

  getDiagnostics() {
    return {
      status: this.status,
      connection: this.connectionDiagnostics(),
      recentErrors: this.errors.slice(),
      debugLog: this.debugSink
        ? {
            endpoint: DEBUG_LOG_URL,
            file: '.gev-logs/realtime-conversations.jsonl',
            sessionId: this.sessionId,
          }
        : null,
      cost: this.costTracker.state(),
    };
  }

  debugLog(event, payload = {}) {
    try {
      this.debugSink?.({
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        event,
        status: this.status,
        payload: sanitizeDebugValue(payload),
      });
    } catch {
      /* Diagnostics cannot interrupt voice. */
    }
  }
}
