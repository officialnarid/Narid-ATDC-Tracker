// ============================================================================
// QR Scanner UI Input Masking & Sanitization Helpers
// ============================================================================
// Security invariants:
// - Keeps raw QR payloads and security tokens strictly in internal memory/refs.
// - Never exposes raw QR payloads, employee IDs, or tokens inside visible
//   Punch In / Punch Out scanner input fields or browser console/UI errors.
// ============================================================================

export const QR_DETECTED_STATUS = 'QR Code Detected ✓';
export const QR_VERIFYING_STATUS = 'Verifying QR...';

export function getMaskedQrInputValue(hasDetectedPayload: boolean, isProcessing: boolean): string {
  if (isProcessing) return QR_VERIFYING_STATUS;
  if (hasDetectedPayload) return QR_DETECTED_STATUS;
  return '';
}

export function applyQrInputChange(
  currentRawPayload: string,
  nextInputValue: string,
  currentMaskValue: string
): { nextRawPayload: string; hasDetectedPayload: boolean } {
  if (!nextInputValue) {
    return { nextRawPayload: '', hasDetectedPayload: false };
  }

  if (currentMaskValue && nextInputValue.startsWith(currentMaskValue)) {
    const appended = nextInputValue.slice(currentMaskValue.length);
    const nextRaw = appended ? `${currentRawPayload}${appended}` : currentRawPayload;
    return {
      nextRawPayload: nextRaw,
      hasDetectedPayload: nextRaw.length > 0,
    };
  }

  if (currentMaskValue && nextInputValue.length < currentMaskValue.length) {
    return { nextRawPayload: '', hasDetectedPayload: false };
  }

  return {
    nextRawPayload: nextInputValue,
    hasDetectedPayload: nextInputValue.length > 0,
  };
}

export function sanitizeQrErrorMessage(rawMessage: string, rawPayload?: string): string {
  let msg = String(rawMessage || 'Invalid QR payload.').trim();
  if (!msg) return 'Invalid QR payload.';

  // Redact explicit QR_<ID>_<TOKEN> or token substrings if ever echoed
  msg = msg.replace(/\bQR_[A-Za-z0-9_-]{3,}\b/gi, '[QR_TOKEN_REDACTED]');

  // Redact JSON QR objects if ever echoed
  msg = msg.replace(/\{[^}]*"(?:employeeId|id|token|qrToken)"[^}]*\}/gi, '[QR_PAYLOAD_REDACTED]');

  // Redact exact structured raw payload if echoed verbatim
  const cleanPayload = String(rawPayload || '').trim();
  if (
    cleanPayload.length >= 6 &&
    (cleanPayload.startsWith('{') || cleanPayload.toUpperCase().startsWith('QR_') || cleanPayload.includes('token'))
  ) {
    if (msg.includes(cleanPayload)) {
      msg = msg.split(cleanPayload).join('[QR_PAYLOAD_REDACTED]');
    }
  }

  return msg;
}
