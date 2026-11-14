import express, { Request, Response } from 'express';
import crypto from 'crypto';
import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
} from 'firebase/firestore';

export interface VerifiedCaller {
  uid: string;
  email: string;
  loginId: string;
  role: 'super_admin' | 'admin' | 'user';
  profileDocId: string;
  authTime?: number;
}

export interface GeoLocationInfo {
  country: string;
  region: string;
  city: string;
  status: 'resolved' | 'unavailable';
}

export interface UserAgentMeta {
  browser: string;
  os: string;
  deviceType: 'Desktop' | 'Mobile' | 'Tablet' | 'Bot' | 'Unknown';
  raw: string;
}

// Critical security / deletion / auth-integrity actions that must NEVER be deleted via log cleanup
export const CRITICAL_PROTECTED_ACTIONS = new Set([
  'account_deleted',
  'accounts_consolidated',
  'account_cleanup_approved',
  'account_cleanup_deleted',
  'admin_password_reset',
  'unauthorized_access_attempt',
  'unauthorized_password_reset_attempt',
  'unauthorized_self_password_change',
  'login_locked_rate_limit',
  'audit_controlled_deleted',
]);

// ============================================================================
// 1. Cryptographic Firebase ID Token Verifier (Zero-Config Google x509 + Optional Admin SDK)
// ============================================================================
let cachedCerts: Record<string, string> = {};
let certsExpiresAt = 0;

async function getFirebasePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (now < certsExpiresAt && Object.keys(cachedCerts).length > 0) {
    return cachedCerts;
  }

  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
    { signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase public certificates (${res.status})`);
  }
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeSec = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;
  cachedCerts = (await res.json()) as Record<string, string>;
  certsExpiresAt = now + Math.max(60, maxAgeSec) * 1000;
  return cachedCerts;
}

function decodeBase64Url(str: string): Buffer {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

export async function verifyFirebaseJwtToken(
  token: string,
  projectId: string
): Promise<{ uid: string; email: string; authTime?: number }> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(decodeBase64Url(headerB64).toString('utf8'));
  const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf8'));

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Firebase token algorithm or missing key ID.');
  }

  const certs = await getFirebasePublicCerts();
  const certPem = certs[header.kid];
  if (!certPem) {
    // Refresh certs once in case Google rotated keys
    certsExpiresAt = 0;
    const freshCerts = await getFirebasePublicCerts();
    if (!freshCerts[header.kid]) {
      throw new Error('Firebase token signing key not recognized.');
    }
  }

  const verifiedCert = certs[header.kid] || cachedCerts[header.kid];
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const signature = decodeBase64Url(sigB64);
  if (!verifier.verify(verifiedCert, signature)) {
    throw new Error('Invalid Firebase ID token signature.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) {
    throw new Error('Firebase token audience mismatch.');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Firebase token issuer mismatch.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Firebase token has expired.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Firebase token issued-at timestamp invalid.');
  }
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
    throw new Error('Firebase token subject UID missing.');
  }

  return {
    uid: payload.sub,
    email: String(payload.email || '').toLowerCase(),
    authTime: typeof payload.auth_time === 'number' ? payload.auth_time : undefined,
  };
}

export async function verifyCallerIdentity(
  req: Request,
  db: Firestore,
  projectId: string
): Promise<VerifiedCaller | null> {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token || token.length < 20) {
    return null;
  }

  const decoded = await verifyFirebaseJwtToken(token, projectId);
  const emailLower = decoded.email.toLowerCase();

  // Owner identity protection
  if (emailLower === 'officialnarid@gmail.com') {
    return {
      uid: decoded.uid,
      email: emailLower,
      loginId: 'officialnarid',
      role: 'super_admin',
      profileDocId: 'role_superadmin',
      authTime: decoded.authTime,
    };
  }

  // Authoritative Firestore RBAC lookup (never trust client-asserted role)
  const snap = await getDocs(collection(db, 'user_roles'));
  let matchedDoc: { id: string; data: any } | null = null;

  for (const d of snap.docs) {
    const data = d.data();
    const docEmail = String(data.email || '').toLowerCase();
    const aliases: string[] = Array.isArray(data.emailAliases)
      ? data.emailAliases.map((e: any) => String(e).toLowerCase())
      : [];
    const linkedUids: string[] = Array.isArray(data.linkedAuthUids) ? data.linkedAuthUids : [];

    if (
      data.authUid === decoded.uid ||
      linkedUids.includes(decoded.uid) ||
      (emailLower && docEmail === emailLower) ||
      (emailLower && aliases.includes(emailLower))
    ) {
      matchedDoc = { id: d.id, data };
      break;
    }
  }

  // Fallback mapping by canonical/root loginId prefix if doc exists
  if (!matchedDoc && emailLower.includes('@narid.com')) {
    const prefix = emailLower.split('@')[0].replace(/_root$/, '');
    const direct = await getDoc(doc(db, 'user_roles', `role_${prefix}`));
    if (direct.exists()) {
      matchedDoc = { id: direct.id, data: direct.data() };
    }
  }

  if (!matchedDoc) {
    return null;
  }

  if (matchedDoc.data.status === 'Inactive') {
    const err: any = new Error('Account Deactivated. Access denied.');
    err.statusCode = 403;
    throw err;
  }

  // Check session revocation timestamp against token auth_time
  if (matchedDoc.data.sessionRevokedAt && decoded.authTime) {
    const revokedSec = Math.floor(new Date(matchedDoc.data.sessionRevokedAt).getTime() / 1000);
    if (decoded.authTime + 2 < revokedSec) {
      const err: any = new Error('Session has been revoked. Please sign in again.');
      err.statusCode = 401;
      throw err;
    }
  }

  const rawRole = String(matchedDoc.data.role || 'user').toLowerCase();
  const normalizedRole: 'super_admin' | 'admin' | 'user' =
    rawRole === 'super_admin' || rawRole === 'superadmin'
      ? 'super_admin'
      : rawRole === 'admin'
      ? 'admin'
      : 'user';

  return {
    uid: decoded.uid,
    email: emailLower || String(matchedDoc.data.email || ''),
    loginId: String(matchedDoc.data.loginId || matchedDoc.id.replace(/^role_/, '')).toLowerCase(),
    role: normalizedRole,
    profileDocId: matchedDoc.id,
    authTime: decoded.authTime,
  };
}

// ============================================================================
// 2. Trusted Reverse-Proxy IP, User-Agent & Safe Geo Lookup
// ============================================================================
export function extractTrustedClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  let candidate = '';
  if (typeof xff === 'string' && xff.trim()) {
    candidate = xff.split(',')[0].trim();
  } else if (Array.isArray(xff) && xff.length > 0) {
    candidate = String(xff[0]).split(',')[0].trim();
  } else if (typeof req.headers['cf-connecting-ip'] === 'string') {
    candidate = req.headers['cf-connecting-ip'].trim();
  } else if (typeof req.headers['x-real-ip'] === 'string') {
    candidate = req.headers['x-real-ip'].trim();
  } else {
    candidate = req.socket?.remoteAddress || '127.0.0.1';
  }

  // Strip IPv6-mapped IPv4 prefix and brackets/ports
  candidate = candidate.replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.split(':')[0];
  }

  // Validate basic IPv4 / IPv6 character safety
  if (!/^[a-fA-F0-9:.]{3,45}$/.test(candidate)) {
    return 'unavailable';
  }
  return candidate;
}

export function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip || ip === 'unavailable' || ip === '::1' || ip === '127.0.0.1' || ip === '0.0.0.0') {
    return true;
  }
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) {
    return true;
  }
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function parseUserAgent(uaRaw?: string | string[]): UserAgentMeta {
  const ua = typeof uaRaw === 'string' ? uaRaw : Array.isArray(uaRaw) ? uaRaw.join(' ') : '';
  if (!ua.trim()) {
    return { browser: 'Unknown', os: 'Unknown', deviceType: 'Unknown', raw: '' };
  }

  let browser = 'Unknown';
  if (/Edg\//i.test(ua)) browser = 'Microsoft Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome\/|CriOS\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Google Chrome';
  else if (/Firefox\/|FxiOS\//i.test(ua)) browser = 'Mozilla Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = 'Apple Safari';
  else if (/curl|PostmanRuntime|node-fetch|python-requests/i.test(ua)) browser = 'API Client';

  let os = 'Unknown';
  if (/Windows NT 10\.0/i.test(ua)) os = 'Windows 10/11';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let deviceType: UserAgentMeta['deviceType'] = 'Desktop';
  if (/bot|crawler|spider|curl|PostmanRuntime|node-fetch/i.test(ua)) {
    deviceType = 'Bot';
  } else if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) {
    deviceType = 'Tablet';
  } else if (/Mobile|iPhone|iPod|Android.*Mobile/i.test(ua)) {
    deviceType = 'Mobile';
  }

  return { browser, os, deviceType, raw: ua.slice(0, 300) };
}

const geoCache = new Map<string, { data: GeoLocationInfo; expiresAt: number }>();

export async function resolveIpGeoLocation(ip: string, enabled = true): Promise<GeoLocationInfo> {
  if (!enabled || isPrivateOrLocalIp(ip)) {
    return {
      country: isPrivateOrLocalIp(ip) ? 'Local / Private Network' : 'unavailable',
      region: 'unavailable',
      city: 'unavailable',
      status: 'unavailable',
    };
  }

  const cached = geoCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const json: any = await res.json();
      if (json && json.success !== false && (json.country || json.city)) {
        const result: GeoLocationInfo = {
          country: String(json.country || 'unavailable'),
          region: String(json.region || 'unavailable'),
          city: String(json.city || 'unavailable'),
          status: 'resolved',
        };
        geoCache.set(ip, { data: result, expiresAt: Date.now() + 3600 * 1000 });
        return result;
      }
    }
  } catch {
    // Graceful non-blocking fallback
  }

  const fallback: GeoLocationInfo = {
    country: 'unavailable',
    region: 'unavailable',
    city: 'unavailable',
    status: 'unavailable',
  };
  geoCache.set(ip, { data: fallback, expiresAt: Date.now() + 5 * 60 * 1000 });
  return fallback;
}

// ============================================================================
// 3. Sensitive Data Redaction, Category Mapping & Deduplication
// ============================================================================
const SENSITIVE_KEY_PATTERN = /(password|passcode|hash|token|secret|apikey|api_key|credential|private_key|salt|authorization)/i;

export function redactSensitiveData(value: any, depth = 0): any {
  if (value === null || value === undefined) return null;
  if (depth > 5) return '[Truncated]';

  if (typeof value === 'string') {
    // Mask inline bearer tokens or scrypt hashes
    if (value.startsWith('Bearer ') || /^[0-9a-f]{32}:[0-9a-f]{128}$/i.test(value)) {
      return '[REDACTED]';
    }
    return value.length > 8000 ? `${value.slice(0, 7950)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => redactSensitiveData(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitiveData(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function stringifyRedacted(value: any): string | null {
  if (value === undefined || value === null || value === '') return null;
  const redacted = redactSensitiveData(value);
  if (typeof redacted === 'string') return redacted;
  try {
    const str = JSON.stringify(redacted);
    return str.length > 8000 ? `${str.slice(0, 7950)}...[truncated]` : str;
  } catch {
    return '[Object]';
  }
}

export function inferAuditCategoryAndSeverity(action: string, success = true): {
  category: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  isProtected: boolean;
} {
  const a = (action || '').toLowerCase();
  const isProtected = CRITICAL_PROTECTED_ACTIONS.has(a);

  if (
    a.includes('unauthorized') ||
    a.includes('locked_rate_limit') ||
    a === 'audit_controlled_deleted' ||
    a === 'account_deleted'
  ) {
    return {
      category: a.startsWith('audit_') ? 'AUDIT_LIFECYCLE' : 'SECURITY',
      severity: 'CRITICAL',
      isProtected: true,
    };
  }
  if (a.includes('login') || a === 'logout' || a === 'session_expired') {
    return {
      category: 'AUTH',
      severity: success ? 'INFO' : 'WARNING',
      isProtected,
    };
  }
  if (a.includes('password') || a.includes('account_') || a.includes('accounts_consolidated')) {
    return {
      category: 'ACCOUNT',
      severity: isProtected ? 'CRITICAL' : 'WARNING',
      isProtected,
    };
  }
  if (a.includes('permission')) {
    return { category: 'PERMISSIONS', severity: 'WARNING', isProtected };
  }
  if (a.includes('employee') || a.includes('manpower')) {
    return {
      category: 'EMPLOYEE',
      severity: a.includes('delete') ? 'WARNING' : 'INFO',
      isProtected: false,
    };
  }
  if (a.includes('punch') || a.includes('attendance') || a.includes('roster')) {
    return {
      category: 'ATTENDANCE',
      severity: a.includes('correct') || a.includes('clear') ? 'WARNING' : 'INFO',
      isProtected: false,
    };
  }
  if (a.includes('qr_')) {
    return { category: 'QR', severity: 'INFO', isProtected: false };
  }
  if (a.includes('floor') || a.includes('section') || a.includes('department') || a.includes('shift')) {
    return { category: 'ORG', severity: 'INFO', isProtected: false };
  }
  if (a.includes('export') || a.includes('report')) {
    return { category: 'EXPORT', severity: 'INFO', isProtected: false };
  }
  if (a.includes('setting')) {
    return { category: 'SETTINGS', severity: 'WARNING', isProtected: false };
  }
  if (a.startsWith('audit_')) {
    return { category: 'AUDIT_LIFECYCLE', severity: 'WARNING', isProtected };
  }
  return { category: 'SYSTEM', severity: 'INFO', isProtected };
}

export function isAuditLogProtected(data: any): boolean {
  if (!data) return true;
  if (data.isProtected === true || data.isImportant === true || data.severity === 'CRITICAL') {
    return true;
  }
  const act = String(data.action || data.eventType || '').toLowerCase();
  return CRITICAL_PROTECTED_ACTIONS.has(act);
}

export function normalizeAuditLogRecord(id: string, raw: any): any {
  const action = String(raw.eventType || raw.action || 'GENERAL_ACTION');
  const success = typeof raw.success === 'boolean' ? raw.success : !action.toLowerCase().includes('fail') && !action.toLowerCase().includes('unauthorized');
  const inferred = inferAuditCategoryAndSeverity(action, success);
  const ts = String(raw.timestamp || raw.createdAt || new Date().toISOString());
  const tsMs = typeof raw.timestampMs === 'number' ? raw.timestampMs : new Date(ts).getTime() || Date.now();

  const actorLoginId = String(raw.actorLoginId || raw.performedByLoginId || raw.loginId || 'system');
  const targetId = raw.targetId || raw.employeeId || raw.targetUid || null;
  const oldVal = stringifyRedacted(raw.oldValue ?? raw.previousValue);
  const newVal = stringifyRedacted(raw.newValue);
  const description = String(raw.description || raw.details || raw.reason || newVal || action);

  return {
    id,
    action,
    eventType: action,
    category: raw.category || inferred.category,
    severity: raw.severity || inferred.severity,
    actorUid: raw.actorUid || raw.performedByUid || 'system',
    actorLoginId,
    actorRole: String(raw.actorRole || (actorLoginId === 'superadmin' ? 'SUPER_ADMIN' : actorLoginId === 'admin' ? 'ADMIN' : actorLoginId === 'user' ? 'USER' : 'SYSTEM')),
    targetType: raw.targetType || (raw.employeeId ? 'EMPLOYEE' : raw.targetUid ? 'ACCOUNT' : 'SYSTEM'),
    targetId: targetId ? String(targetId) : undefined,
    employeeId: raw.employeeId ? String(raw.employeeId) : undefined,
    timestamp: ts,
    timestampMs: tsMs,
    oldValue: oldVal || undefined,
    newValue: newVal || undefined,
    actionSource: String(raw.actionSource || 'SERVER_API'),
    reason: raw.reason ? String(raw.reason) : raw.details ? String(raw.details) : undefined,
    description,
    success,
    ipAddress: String(raw.ipAddress || 'unavailable'),
    geoLocation: raw.geoLocation || {
      country: 'unavailable',
      region: 'unavailable',
      city: 'unavailable',
      status: 'unavailable',
    },
    userAgentMeta: raw.userAgentMeta || {
      browser: 'Unknown',
      os: 'Unknown',
      deviceType: 'Unknown',
    },
    sessionId: raw.sessionId || undefined,
    isImportant: raw.isImportant === true,
    isProtected: raw.isProtected === true || isAuditLogProtected({ ...raw, action, severity: raw.severity || inferred.severity }),
    archived: raw.archived === true,
    archivedAt: raw.archivedAt || undefined,
    archivedBy: raw.archivedBy || undefined,
    reviewedBy: raw.reviewedBy || undefined,
    reviewedAt: raw.reviewedAt || undefined,
    reviewNote: raw.reviewNote || undefined,
  };
}

// 2-second operational event deduplicator
const recentAuditEvents = new Map<string, number>();

export function shouldDeduplicateEvent(key: string, action: string): boolean {
  const actLower = action.toLowerCase();
  // Never suppress distinct auth/security attempts
  if (actLower.includes('login') || actLower.includes('unauthorized') || actLower.includes('password') || actLower.includes('delete')) {
    return false;
  }
  const now = Date.now();
  // Periodic pruning
  if (recentAuditEvents.size > 500) {
    for (const [k, exp] of recentAuditEvents.entries()) {
      if (exp < now) recentAuditEvents.delete(k);
    }
  }
  const existing = recentAuditEvents.get(key);
  if (existing && existing > now) {
    return true;
  }
  recentAuditEvents.set(key, now + 2000);
  return false;
}

// ============================================================================
// 4. Unified Enterprise Audit & Login History Writer
// ============================================================================
export async function recordEnterpriseAuditEvent(
  db: Firestore,
  params: {
    req?: Request;
    action: string;
    category?: string;
    severity?: 'INFO' | 'WARNING' | 'CRITICAL';
    actorUid?: string;
    actorLoginId?: string;
    actorRole?: string;
    targetType?: string;
    targetId?: string;
    employeeId?: string;
    oldValue?: any;
    newValue?: any;
    actionSource?: string;
    reason?: string;
    description?: string;
    success?: boolean;
    sessionId?: string;
    captureGeo?: boolean;
    deduplicate?: boolean;
  }
): Promise<string | null> {
  try {
    const actorLoginId = (params.actorLoginId || 'system').trim().toLowerCase();
    const dedupKey = `${params.sessionId || 'nosess'}::${actorLoginId}::${params.action}::${params.targetId || params.employeeId || ''}`;
    if (params.deduplicate && shouldDeduplicateEvent(dedupKey, params.action)) {
      return null;
    }

    const nowDate = new Date();
    const now = nowDate.toISOString();
    const logId = `audit_${nowDate.getTime()}_${crypto.randomBytes(3).toString('hex')}`;
    const success = params.success !== undefined ? params.success : true;
    const inferred = inferAuditCategoryAndSeverity(params.action, success);
    const severity = params.severity || inferred.severity;
    const isProtected = inferred.isProtected || severity === 'CRITICAL';

    const ipAddress = params.req ? extractTrustedClientIp(params.req) : 'server-internal';
    const uaMeta = params.req ? parseUserAgent(params.req.headers['user-agent']) : { browser: 'Server Process', os: 'Linux', deviceType: 'Bot' as const, raw: 'server' };
    const geoLocation = params.req
      ? await resolveIpGeoLocation(ipAddress, params.captureGeo !== false)
      : { country: 'unavailable', region: 'unavailable', city: 'unavailable', status: 'unavailable' as const };

    const cleanOld = stringifyRedacted(params.oldValue);
    const cleanNew = stringifyRedacted(params.newValue);
    const desc = String(params.description || params.reason || cleanNew || params.action).slice(0, 2000);

    const docPayload: Record<string, any> = {
      id: logId,
      action: params.action,
      eventType: params.action,
      category: params.category || inferred.category,
      severity,
      actorUid: params.actorUid || 'system',
      actorLoginId,
      loginId: actorLoginId,
      performedByUid: params.actorUid || 'system',
      performedByLoginId: actorLoginId,
      actorRole: String(params.actorRole || 'SYSTEM').toUpperCase(),
      targetType: params.targetType || (params.employeeId ? 'EMPLOYEE' : params.targetId ? 'RESOURCE' : 'SYSTEM'),
      targetId: params.targetId || params.employeeId || null,
      targetUid: params.targetId || null,
      employeeId: params.employeeId || null,
      timestamp: now,
      timestampMs: nowDate.getTime(),
      oldValue: cleanOld,
      previousValue: cleanOld,
      newValue: cleanNew,
      actionSource: params.actionSource || 'SERVER_API',
      reason: params.reason ? String(params.reason).slice(0, 2000) : desc,
      details: desc,
      description: desc,
      success,
      ipAddress,
      geoLocation,
      userAgentMeta: {
        browser: uaMeta.browser,
        os: uaMeta.os,
        deviceType: uaMeta.deviceType,
      },
      sessionId: params.sessionId || null,
      isImportant: severity === 'CRITICAL',
      isProtected,
      archived: false,
      createdAt: now,
    };

    await setDoc(doc(db, 'audit_logs', logId), docPayload);
    return logId;
  } catch (err: any) {
    console.warn('[Enterprise Audit] Failed to persist audit log:', err?.message || err);
    return null;
  }
}

export async function recordLoginHistoryEntry(
  db: Firestore,
  params: {
    req: Request;
    eventType: 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'LOGIN_LOCKED' | 'LOGOUT' | 'SESSION_EXPIRED';
    loginId: string;
    authUid?: string;
    role: string;
    success: boolean;
    failureReason?: string;
    sessionId?: string;
    captureGeo?: boolean;
  }
): Promise<void> {
  try {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const historyId = `lh_${nowDate.getTime()}_${crypto.randomBytes(3).toString('hex')}`;
    const ipAddress = extractTrustedClientIp(params.req);
    const uaMeta = parseUserAgent(params.req.headers['user-agent']);
    const geoLocation = await resolveIpGeoLocation(ipAddress, params.captureGeo !== false);

    await setDoc(doc(db, 'login_history', historyId), {
      id: historyId,
      eventType: params.eventType,
      loginId: params.loginId.trim().toLowerCase(),
      authUid: params.authUid || null,
      role: String(params.role || 'UNKNOWN').toUpperCase(),
      timestamp: now,
      timestampMs: nowDate.getTime(),
      success: params.success,
      failureReason: params.failureReason ? String(params.failureReason).slice(0, 500) : null,
      ipAddress,
      geoLocation,
      browser: uaMeta.browser,
      os: uaMeta.os,
      deviceType: uaMeta.deviceType,
      sessionId: params.sessionId || null,
    });
  } catch (err: any) {
    console.warn('[Login History] Failed to persist login history entry:', err?.message || err);
  }
}

// ============================================================================
// 5. Register Enterprise Security, Audit Management & Account Cleanup Routes
// ============================================================================
export function registerSecurityAuditRoutes(
  app: express.Express,
  db: Firestore,
  projectId: string
) {
  // Helper: Require valid verified Firebase ID Token
  async function requireAuth(req: Request, res: Response): Promise<VerifiedCaller | null> {
    try {
      const caller = await verifyCallerIdentity(req, db, projectId);
      if (!caller) {
        res.status(401).json({
          success: false,
          error: 'Authentication required: Missing or unrecognized Firebase ID token.',
        });
        return null;
      }
      return caller;
    } catch (err: any) {
      res.status(err?.statusCode || 401).json({
        success: false,
        error: err?.message || 'Invalid or expired Firebase authentication token.',
      });
      return null;
    }
  }

  // Helper: Require strictly verified Super Admin
  async function requireSuperAdmin(req: Request, res: Response): Promise<VerifiedCaller | null> {
    const caller = await requireAuth(req, res);
    if (!caller) return null;
    if (caller.role !== 'super_admin') {
      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'unauthorized_access_attempt',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType: 'SECURITY_CONSOLE',
        targetId: req.path,
        actionSource: 'BACKEND_RBAC_GUARD',
        description: `Non-Super-Admin "${caller.loginId}" (${caller.role}) attempted restricted endpoint ${req.method} ${req.path}.`,
        success: false,
      });
      res.status(403).json({
        success: false,
        error: 'Forbidden: Only verified SUPER_ADMIN accounts can access this security control.',
      });
      return null;
    }
    return caller;
  }

  // --------------------------------------------------------------------------
  // A. Ingest Operational / Lifecycle Client Activity Events (Server-Enriched)
  // --------------------------------------------------------------------------
  app.post('/api/audit/event', async (req: Request, res: Response) => {
    try {
      const caller = await requireAuth(req, res);
      if (!caller) return;

      const {
        action,
        category,
        targetType,
        targetId,
        employeeId,
        oldValue,
        newValue,
        actionSource,
        reason,
        description,
        success,
        sessionId,
      } = req.body || {};

      if (!action || typeof action !== 'string') {
        return res.status(400).json({ success: false, error: 'Event action is required.' });
      }

      const cleanAction = action.trim().slice(0, 100);
      const actLower = cleanAction.toLowerCase();

      // Check global captureGeoLocation setting
      let captureGeo = true;
      try {
        const settingsSnap = await getDoc(doc(db, 'system_settings', 'global'));
        if (settingsSnap.exists() && settingsSnap.data()?.captureGeoLocation === false) {
          captureGeo = false;
        }
      } catch {}

      const logId = await recordEnterpriseAuditEvent(db, {
        req,
        action: cleanAction,
        category,
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: caller.role.toUpperCase(),
        targetType,
        targetId,
        employeeId,
        oldValue,
        newValue,
        actionSource: actionSource || 'CLIENT_APP',
        reason,
        description,
        success: success !== undefined ? Boolean(success) : true,
        sessionId,
        captureGeo,
        deduplicate: true,
      });

      if (actLower === 'logout' || actLower === 'session_expired') {
        await recordLoginHistoryEntry(db, {
          req,
          eventType: actLower === 'logout' ? 'LOGOUT' : 'SESSION_EXPIRED',
          loginId: caller.loginId,
          authUid: caller.uid,
          role: caller.role,
          success: true,
          sessionId,
          captureGeo,
        });
      }

      return res.json({ success: true, logId });
    } catch (err: any) {
      console.error('[Audit Event API] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to record audit event.' });
    }
  });

  // --------------------------------------------------------------------------
  // B. Query Audit Logs + Compute 9 KPI Metrics + Retention Queue (Super Admin)
  // --------------------------------------------------------------------------
  app.get('/api/audit/logs', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const {
        search = '',
        from = '',
        to = '',
        loginId = 'ALL',
        role = 'ALL',
        category = 'ALL',
        action = 'ALL',
        ip = '',
        success = 'ALL',
        importance = 'ALL',
        lifecycle = 'active',
        page = '1',
        pageSize = '25',
      } = req.query as Record<string, string>;

      const settingsSnap = await getDoc(doc(db, 'system_settings', 'global'));
      const settingsData = settingsSnap.exists() ? settingsSnap.data() : {};
      const retentionDays = Number(settingsData.auditRetentionDays || 90);
      const retentionCutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

      const [activeSnap, archiveSnap, deletionsSnap] = await Promise.all([
        getDocs(collection(db, 'audit_logs')),
        getDocs(collection(db, 'audit_archives')),
        getDocs(collection(db, 'audit_log_deletions')),
      ]);

      const activeLogs = activeSnap.docs.map(d => normalizeAuditLogRecord(d.id, d.data()));
      const archivedLogsList = archiveSnap.docs.map(d => ({
        ...normalizeAuditLogRecord(d.id, d.data()),
        archived: true,
      }));

      // Deduplicate if an archived ID also remains flagged archived in active collection
      const archivedMap = new Map<string, any>();
      archivedLogsList.forEach(l => archivedMap.set(l.id, l));
      activeLogs.forEach(l => {
        if (l.archived && !archivedMap.has(l.id)) archivedMap.set(l.id, l);
      });
      const allArchived = Array.from(archivedMap.values());
      const activeOnly = activeLogs.filter(l => !l.archived);

      // Compute Today boundary in Asia/Kolkata
      const kolkataToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

      const allCombined = [...activeOnly, ...allArchived];
      const kpis = {
        totalLogs: allCombined.length,
        todayActivities: activeLogs.filter(l => {
          try {
            const dStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(l.timestamp));
            return dStr === kolkataToday;
          } catch {
            return false;
          }
        }).length,
        successfulLogins: allCombined.filter(l => l.action.toLowerCase() === 'login_success').length,
        failedLogins: allCombined.filter(l => l.action.toLowerCase().includes('login_failed') || l.action.toLowerCase().includes('login_locked') || l.action.toLowerCase().includes('login_rejected')).length,
        employeeChanges: allCombined.filter(l => l.category === 'EMPLOYEE' || l.action.includes('EMPLOYEE') || l.action.includes('MANPOWER')).length,
        attendanceEvents: allCombined.filter(l => l.category === 'ATTENDANCE' || l.action.includes('PUNCH') || l.action.includes('ATTENDANCE') || l.action.includes('ROSTER')).length,
        securityAlerts: allCombined.filter(l => l.severity === 'CRITICAL' || l.category === 'SECURITY' || l.action.toLowerCase().includes('unauthorized')).length,
        archivedLogs: allArchived.length,
        pendingLogReviews: activeOnly.filter(l => !l.isProtected && !l.isImportant && l.timestampMs < retentionCutoffMs).length,
        permanentDeletionsCount: deletionsSnap.size,
      };

      // Choose lifecycle pool
      let pool = activeOnly;
      if (lifecycle === 'archived') pool = allArchived;
      else if (lifecycle === 'pending_review') pool = activeOnly.filter(l => !l.isProtected && !l.isImportant && l.timestampMs < retentionCutoffMs);
      else if (lifecycle === 'all') pool = allCombined;

      // Apply filters
      const qSearch = search.trim().toLowerCase();
      const qIp = ip.trim().toLowerCase();
      const fromMs = from ? new Date(`${from}T00:00:00+05:30`).getTime() : 0;
      const toMs = to ? new Date(`${to}T23:59:59+05:30`).getTime() : Infinity;

      const filtered = pool.filter(log => {
        if (qSearch) {
          const hay = `${log.id} ${log.action} ${log.actorLoginId} ${log.targetId || ''} ${log.employeeId || ''} ${log.description || ''} ${log.ipAddress || ''}`.toLowerCase();
          if (!hay.includes(qSearch)) return false;
        }
        if (from && log.timestampMs < fromMs) return false;
        if (to && log.timestampMs > toMs) return false;
        if (loginId !== 'ALL' && log.actorLoginId.toLowerCase() !== loginId.toLowerCase()) return false;
        if (role !== 'ALL' && log.actorRole.toUpperCase() !== role.toUpperCase()) return false;
        if (category !== 'ALL' && log.category.toUpperCase() !== category.toUpperCase()) return false;
        if (action !== 'ALL' && log.action.toLowerCase() !== action.toLowerCase()) return false;
        if (qIp && !String(log.ipAddress || '').toLowerCase().includes(qIp)) return false;
        if (success === 'SUCCESS' && !log.success) return false;
        if (success === 'FAILURE' && log.success) return false;
        if (importance === 'IMPORTANT' && !log.isImportant) return false;
        if (importance === 'NORMAL' && log.isImportant) return false;
        return true;
      });

      filtered.sort((a, b) => b.timestampMs - a.timestampMs);

      const p = Math.max(1, parseInt(page, 10) || 1);
      const size = Math.min(200, Math.max(10, parseInt(pageSize, 10) || 25));
      const totalFiltered = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalFiltered / size));
      const safePage = Math.min(p, totalPages);
      const paginated = filtered.slice((safePage - 1) * size, safePage * size);

      // Unique filter facets
      const availableActions = Array.from(new Set(allCombined.map(l => l.action))).sort();
      const availableActors = Array.from(new Set(allCombined.map(l => l.actorLoginId))).sort();

      return res.json({
        success: true,
        kpis,
        retentionDays,
        logs: paginated,
        pagination: {
          page: safePage,
          pageSize: size,
          totalFiltered,
          totalPages,
        },
        facets: {
          actions: availableActions,
          actors: availableActors,
        },
      });
    } catch (err: any) {
      console.error('[Audit Query API] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to load audit logs.' });
    }
  });

  // --------------------------------------------------------------------------
  // C. Login History & IP / Geo / Device Telemetry (Super Admin Only)
  // --------------------------------------------------------------------------
  app.get('/api/audit/login-history', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const { loginId = 'ALL', eventType = 'ALL', status = 'ALL', search = '' } = req.query as Record<string, string>;
      const snap = await getDocs(collection(db, 'login_history'));
      let entries = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));

      const q = search.trim().toLowerCase();
      entries = entries.filter(e => {
        if (loginId !== 'ALL' && String(e.loginId || '').toLowerCase() !== loginId.toLowerCase()) return false;
        if (eventType !== 'ALL' && String(e.eventType || '') !== eventType) return false;
        if (status === 'SUCCESS' && !e.success) return false;
        if (status === 'FAILURE' && e.success) return false;
        if (q) {
          const hay = `${e.loginId} ${e.ipAddress} ${e.geoLocation?.city || ''} ${e.geoLocation?.country || ''} ${e.browser || ''} ${e.os || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      entries.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      return res.json({ success: true, entries: entries.slice(0, 300) });
    } catch (err: any) {
      console.error('[Login History API] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load login history.' });
    }
  });

  // --------------------------------------------------------------------------
  // D. Immutable Controlled Deletion Ledger (Super Admin Only)
  // --------------------------------------------------------------------------
  app.get('/api/audit/deletions', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const snap = await getDocs(collection(db, 'audit_log_deletions'));
      const deletions = snap.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());

      return res.json({ success: true, deletions });
    } catch (err: any) {
      console.error('[Audit Deletions API] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load permanent deletion ledger.' });
    }
  });

  // --------------------------------------------------------------------------
  // E. Mark / Unmark Important & Archive Log (Super Admin Only)
  // --------------------------------------------------------------------------
  app.post('/api/audit/logs/:id/important', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const logId = req.params.id;
      const { isImportant, reviewNote } = req.body || {};
      const logRef = doc(db, 'audit_logs', logId);
      const snap = await getDoc(logRef);
      if (!snap.exists()) {
        return res.status(404).json({ success: false, error: 'Audit log not found.' });
      }

      const now = new Date().toISOString();
      const nextVal = Boolean(isImportant);
      await updateDoc(logRef, {
        isImportant: nextVal,
        reviewedBy: caller.loginId,
        reviewedAt: now,
        reviewNote: reviewNote ? String(reviewNote).slice(0, 500) : null,
      });

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'audit_marked_important',
        category: 'AUDIT_LIFECYCLE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: 'SUPER_ADMIN',
        targetType: 'AUDIT_LOG',
        targetId: logId,
        oldValue: { isImportant: Boolean(snap.data()?.isImportant) },
        newValue: { isImportant: nextVal },
        actionSource: 'AUDIT_MANAGEMENT',
        description: `Super Admin ${nextVal ? 'marked' : 'unmarked'} audit log ${logId} as Important.`,
      });

      return res.json({ success: true, isImportant: nextVal });
    } catch (err: any) {
      console.error('[Mark Important API] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to update importance status.' });
    }
  });

  app.post('/api/audit/logs/:id/archive', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const logId = req.params.id;
      const { reviewNote } = req.body || {};
      const logRef = doc(db, 'audit_logs', logId);
      const snap = await getDoc(logRef);
      if (!snap.exists()) {
        return res.status(404).json({ success: false, error: 'Active audit log not found.' });
      }

      const raw = snap.data();
      const now = new Date().toISOString();
      const archiveRecord = {
        ...raw,
        id: logId,
        archived: true,
        archivedAt: now,
        archivedBy: caller.loginId,
        reviewedBy: caller.loginId,
        reviewedAt: now,
        reviewNote: reviewNote ? String(reviewNote).slice(0, 500) : 'Reviewed and archived by Super Admin',
      };

      await setDoc(doc(db, 'audit_archives', logId), archiveRecord);
      await updateDoc(logRef, {
        archived: true,
        archivedAt: now,
        archivedBy: caller.loginId,
        reviewedBy: caller.loginId,
        reviewedAt: now,
        reviewNote: archiveRecord.reviewNote,
      });

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'audit_archived',
        category: 'AUDIT_LIFECYCLE',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: 'SUPER_ADMIN',
        targetType: 'AUDIT_LOG',
        targetId: logId,
        actionSource: 'AUDIT_MANAGEMENT',
        description: `Super Admin reviewed and archived audit log ${logId}.`,
      });

      return res.json({ success: true, archivedAt: now });
    } catch (err: any) {
      console.error('[Archive Log API] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to archive audit log.' });
    }
  });

  // --------------------------------------------------------------------------
  // F. Mandatory Pre-Deletion Dependency Review & Controlled Delete (Super Admin Only)
  // --------------------------------------------------------------------------
  app.get('/api/audit/logs/:id/review-dependencies', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const logId = req.params.id;
      const snap = await getDoc(doc(db, 'audit_logs', logId));
      if (!snap.exists()) {
        return res.status(404).json({ success: false, error: 'Audit log not found in active logs.' });
      }

      const normalized = normalizeAuditLogRecord(snap.id, snap.data());
      const protectedFlag = isAuditLogProtected(normalized);

      const settingsSnap = await getDoc(doc(db, 'system_settings', 'global'));
      const retentionDays = Number(settingsSnap.exists() ? settingsSnap.data()?.auditRetentionDays || 90 : 90);
      const ageDays = Math.max(0, Math.floor((Date.now() - normalized.timestampMs) / (1000 * 60 * 60 * 24)));

      // Check linked records across collections
      const linkedRecords: string[] = [];
      if (normalized.employeeId) {
        const empSnap = await getDoc(doc(db, 'employees', normalized.employeeId));
        if (empSnap.exists()) {
          linkedRecords.push(`employees/${normalized.employeeId} (${empSnap.data()?.employeeName || 'Active'})`);
        }
      }
      if (normalized.actorLoginId && normalized.actorLoginId !== 'system') {
        const roleSnap = await getDoc(doc(db, 'user_roles', `role_${normalized.actorLoginId}`));
        if (roleSnap.exists()) {
          linkedRecords.push(`user_roles/role_${normalized.actorLoginId} (${roleSnap.data()?.role || 'USER'})`);
        }
      }
      if (normalized.targetId && normalized.targetId !== normalized.employeeId) {
        const targetRoleSnap = await getDoc(doc(db, 'user_roles', normalized.targetId));
        if (targetRoleSnap.exists()) {
          linkedRecords.push(`user_roles/${normalized.targetId}`);
        }
      }

      const protectionReasons: string[] = [];
      if (normalized.isImportant) protectionReasons.push('Marked as Important by Super Admin');
      if (normalized.severity === 'CRITICAL') protectionReasons.push('Classified as CRITICAL severity');
      if (CRITICAL_PROTECTED_ACTIONS.has(normalized.action.toLowerCase())) {
        protectionReasons.push(`Protected compliance event type (${normalized.action})`);
      }
      const meetsRetentionAge = ageDays >= retentionDays;
      if (!meetsRetentionAge) {
        protectionReasons.push(
          `Active Retention Window: Record is ${ageDays} days old (minimum ${retentionDays} days required before deletion eligibility)`
        );
      }

      return res.json({
        success: true,
        log: normalized,
        isProtected: protectedFlag || !meetsRetentionAge,
        protectionReasons,
        ageDays,
        retentionDays,
        meetsRetentionAge,
        linkedRecords,
        canDelete: !protectedFlag && meetsRetentionAge,
      });
    } catch (err: any) {
      console.error('[Review Dependencies API] Error:', err);
      return res.status(500).json({ success: false, error: 'Failed to review log dependencies.' });
    }
  });

  app.post('/api/audit/logs/:id/controlled-delete', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const logId = req.params.id;
      const { reason, confirmLogId, superAdminConfirmed } = req.body || {};

      if (superAdminConfirmed !== true) {
        return res.status(400).json({ success: false, error: 'Explicit Super Admin confirmation is required.' });
      }
      if (confirmLogId !== logId) {
        return res.status(400).json({ success: false, error: 'Log ID confirmation mismatch. Please type the exact Log ID.' });
      }
      if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
        return res.status(400).json({ success: false, error: 'A detailed deletion reason (at least 10 characters) is mandatory.' });
      }

      const logRef = doc(db, 'audit_logs', logId);
      const snap = await getDoc(logRef);
      if (!snap.exists()) {
        return res.status(404).json({ success: false, error: 'Audit log not found.' });
      }

      const normalized = normalizeAuditLogRecord(snap.id, snap.data());

      // Strict Protection Guard: Critical/Important/Security/Account-deletion logs CANNOT be deleted
      if (isAuditLogProtected(normalized)) {
        await recordEnterpriseAuditEvent(db, {
          req,
          action: 'unauthorized_access_attempt',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          targetType: 'AUDIT_LOG',
          targetId: logId,
          actionSource: 'CONTROLLED_DELETE_GUARD',
          description: `Blocked deletion attempt of protected security/critical audit log "${logId}" (${normalized.action}).`,
          success: false,
        });
        return res.status(403).json({
          success: false,
          error: `Protection Violation: Audit log "${logId}" (${normalized.action}) is a protected security/compliance record and cannot be deleted.`,
        });
      }

      // Retention Window Guard: Non-critical logs must meet configured retention days (default 90 days)
      const settingsSnap = await getDoc(doc(db, 'system_settings', 'global'));
      const retentionDays = Number(settingsSnap.exists() ? settingsSnap.data()?.auditRetentionDays || 90 : 90);
      const ageDays = Math.max(0, Math.floor((Date.now() - normalized.timestampMs) / (1000 * 60 * 60 * 24)));
      if (ageDays < retentionDays) {
        return res.status(403).json({
          success: false,
          error: `Retention Policy Violation: Audit log "${logId}" is ${ageDays} days old and must remain active for at least ${retentionDays} days before controlled deletion eligibility.`,
        });
      }

      const now = new Date().toISOString();
      const ipAddress = extractTrustedClientIp(req);
      const deletionId = `del_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

      const linkedRecordsChecked: string[] = [];
      if (normalized.employeeId) linkedRecordsChecked.push(`employees/${normalized.employeeId}`);
      if (normalized.actorLoginId) linkedRecordsChecked.push(`actor:${normalized.actorLoginId}`);
      if (normalized.targetId) linkedRecordsChecked.push(`target:${normalized.targetId}`);

      // 1. Write permanent immutable deletion history record FIRST
      await setDoc(doc(db, 'audit_log_deletions', deletionId), {
        id: deletionId,
        deletedLogId: logId,
        deletedAction: normalized.action,
        deletedCategory: normalized.category,
        deletedTimestamp: normalized.timestamp,
        deletedActorLoginId: normalized.actorLoginId,
        deletedSummary: String(normalized.description || normalized.newValue || normalized.action).slice(0, 500),
        linkedRecordsChecked,
        reason: reason.trim().slice(0, 1000),
        approvedByUid: caller.uid,
        approvedByLoginId: caller.loginId,
        deletedAt: now,
        ipAddress,
      });

      // 2. Delete the non-critical log from active audit_logs
      await deleteDoc(logRef);

      // 3. Record protected audit_controlled_deleted event
      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'audit_controlled_deleted',
        category: 'AUDIT_LIFECYCLE',
        severity: 'CRITICAL',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: 'SUPER_ADMIN',
        targetType: 'AUDIT_LOG',
        targetId: logId,
        oldValue: { action: normalized.action, timestamp: normalized.timestamp, actor: normalized.actorLoginId },
        newValue: { deletionLedgerId: deletionId, reason: reason.trim() },
        actionSource: 'CONTROLLED_DELETE_WORKFLOW',
        reason: reason.trim(),
        description: `Controlled deletion executed for non-critical log ${logId} (${normalized.action}). Permanent ledger ID: ${deletionId}.`,
      });

      return res.json({
        success: true,
        deletionId,
        deletedLogId: logId,
        message: `Log ${logId} deleted after mandatory review and permanently logged in audit_log_deletions (${deletionId}).`,
      });
    } catch (err: any) {
      console.error('[Controlled Delete API] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed controlled deletion.' });
    }
  });

  // --------------------------------------------------------------------------
  // G. Firebase Authentication 10-Account Dependency Audit & Safe Cleanup Governance
  // --------------------------------------------------------------------------
  const ALL_CHECKED_COLLECTIONS = [
    'user_roles',
    'roles',
    'role_permissions',
    'user_permissions',
    'employees',
    'attendance',
    'punch_events',
    'punch_logs',
    'audit_logs',
    'password_reset_logs',
    'login_history',
    'audit_archives',
    'audit_log_deletions',
    'departments',
    'floors',
    'sections',
    'shifts',
    'shift_rosters',
    'system_settings',
  ];

  // Canonical 12 Nov accounts kept per Super Admin policy (*@narid.com)
  const ACCOUNT_REGISTRY = [
    {
      key: 'superadmin_canonical',
      loginId: 'superadmin',
      email: 'superadmin@narid.com',
      firebaseUid: 'oX2vdSx5jGcoUDxyA0SIYN3SEig2',
      role: 'SUPER_ADMIN',
      createdDate: '2026-11-10T08:30:00Z',
      lastSignIn: '2026-11-12T10:15:00Z',
      accountType: 'CANONICAL_PRIMARY',
      isCanonicalKeep: true,
      isProtected: true,
    },
    {
      key: 'admin_canonical',
      loginId: 'admin',
      email: 'admin@narid.com',
      firebaseUid: '2RpEv6mvyXYswYH9KPIGV6evtgY2',
      role: 'ADMIN',
      createdDate: '2026-11-10T08:35:00Z',
      lastSignIn: '2026-11-12T09:45:00Z',
      accountType: 'CANONICAL_PRIMARY',
      isCanonicalKeep: true,
      isProtected: true,
    },
    {
      key: 'user_canonical',
      loginId: 'user',
      email: 'user@narid.com',
      firebaseUid: 'vXPvgrp3i6cS2frqDa3ZoU9h9gc2',
      role: 'USER',
      createdDate: '2026-11-10T08:40:00Z',
      lastSignIn: '2026-11-12T09:20:00Z',
      accountType: 'CANONICAL_PRIMARY',
      isCanonicalKeep: true,
      isProtected: true,
    },
    {
      key: 'officialnarid_owner',
      loginId: 'officialnarid',
      email: 'officialnarid@gmail.com',
      firebaseUid: 'GCP_PROJECT_OWNER_OAUTH',
      role: 'SUPER_ADMIN',
      createdDate: '2026-11-08T09:00:00Z',
      lastSignIn: '2026-11-13T00:00:00Z',
      accountType: 'GOOGLE_OWNER',
      isCanonicalKeep: true,
      isProtected: true,
    },
    {
      key: 'superadmin_root_legacy',
      loginId: 'superadmin_root',
      email: 'superadmin_root@narid.com',
      firebaseUid: 'UNGneXk4pURTrQVXbVPAKPYtRvH3',
      role: 'SUPER_ADMIN',
      createdDate: '2026-11-08T10:50:27Z',
      lastSignIn: '2026-11-13T00:00:00Z',
      accountType: 'LEGACY_ROOT_ALIAS',
      isCanonicalKeep: false,
      isProtected: false,
    },
    {
      key: 'admin_root_legacy',
      loginId: 'admin_root',
      email: 'admin_root@narid.com',
      firebaseUid: 'vsz6j6kcbtSiCbecmJYVIRgbacJ2',
      role: 'ADMIN',
      createdDate: '2026-11-08T10:50:27Z',
      lastSignIn: '2026-11-08T10:50:27Z',
      accountType: 'LEGACY_ROOT_ALIAS',
      isCanonicalKeep: false,
      isProtected: false,
    },
    {
      key: 'user_root_legacy',
      loginId: 'user_root',
      email: 'user_root@narid.com',
      firebaseUid: 'LEGACY_USER_ROOT_UID',
      role: 'USER',
      createdDate: '2026-11-08T10:50:27Z',
      lastSignIn: '2026-11-08T10:50:27Z',
      accountType: 'LEGACY_ROOT_ALIAS',
      isCanonicalKeep: false,
      isProtected: false,
    },
    {
      key: 'test_admin_qa',
      loginId: 'test_admin_qa',
      email: 'test_admin_qa@narid.com',
      firebaseUid: 'LEGACY_QA_ADMIN_UID',
      role: 'ADMIN',
      createdDate: '2026-11-10T12:00:00Z',
      lastSignIn: '2026-11-10T12:00:00Z',
      accountType: 'LEGACY_QA',
      isCanonicalKeep: false,
      isProtected: false,
    },
    {
      key: 'test_user_qa',
      loginId: 'test_user_qa',
      email: 'test_user_qa@narid.com',
      firebaseUid: 'LEGACY_QA_USER_UID',
      role: 'USER',
      createdDate: '2026-11-10T12:05:00Z',
      lastSignIn: '2026-11-10T12:05:00Z',
      accountType: 'LEGACY_QA',
      isCanonicalKeep: false,
      isProtected: false,
    },
    {
      key: 'deact_qa_test',
      loginId: 'deact_qa_test',
      email: 'deact@narid.com',
      firebaseUid: 'LEGACY_QA_DEACT_UID',
      role: 'USER',
      createdDate: '2026-11-10T12:10:00Z',
      lastSignIn: '2026-11-10T12:10:00Z',
      accountType: 'LEGACY_QA',
      isCanonicalKeep: false,
      isProtected: false,
    },
  ];

  app.get('/api/admin/account-cleanup-audit', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const collectionSnapshots: Record<string, { docId: string; rawText: string; data: any }[]> = {};
      await Promise.all(
        ALL_CHECKED_COLLECTIONS.map(async (colName) => {
          try {
            const snap = await getDocs(collection(db, colName));
            collectionSnapshots[colName] = snap.docs.map(d => ({
              docId: d.id,
              data: d.data(),
              rawText: JSON.stringify(d.data()).toLowerCase(),
            }));
          } catch {
            collectionSnapshots[colName] = [];
          }
        })
      );

      // Load stored Super Admin approval states
      const approvalSnap = await getDoc(doc(db, 'system_settings', 'account_cleanup_approvals'));
      const approvals: Record<string, any> = approvalSnap.exists() ? (approvalSnap.data()?.approvals || {}) : {};

      const accountsReport = ACCOUNT_REGISTRY.map((acc) => {
        const emailLower = acc.email.toLowerCase();
        const uidLower = acc.firebaseUid.toLowerCase();
        const loginLower = acc.loginId.toLowerCase();

        const dependencies: { collection: string; matches: number; note: string }[] = [];
        let activeBlockingDependencies = 0;

        for (const colName of ALL_CHECKED_COLLECTIONS) {
          const docs = collectionSnapshots[colName] || [];
          const matchingDocs = docs.filter(d => {
            const matchesUid = !uidLower.includes('legacy_') && !uidLower.includes('gcp_') && d.rawText.includes(uidLower);
            const matchesEmail = d.rawText.includes(emailLower);
            const matchesDocId = d.docId.toLowerCase() === `role_${loginLower}`;
            // For audit/historical logs only count explicit text/UID matches
            return matchesUid || matchesEmail || matchesDocId;
          });

          if (matchingDocs.length > 0) {
            const isHistoricalOnly = colName === 'audit_logs' || colName === 'password_reset_logs' || colName === 'login_history' || colName === 'audit_log_deletions';
            if (!isHistoricalOnly && !acc.isCanonicalKeep) {
              activeBlockingDependencies += matchingDocs.length;
            }
            dependencies.push({
              collection: colName,
              matches: matchingDocs.length,
              note: isHistoricalOnly ? 'Historical log reference (preserved)' : `Active reference (${matchingDocs.map(m => m.docId).slice(0, 3).join(', ')})`,
            });
          }
        }

        const approvalState = approvals[acc.key] || null;
        const canApproveForCleanup = !acc.isCanonicalKeep && !acc.isProtected;

        return {
          ...acc,
          dependencies,
          activeBlockingDependencies,
          approvalState,
          canApproveForCleanup,
          consoleCleanupCommand: canApproveForCleanup
            ? `# Review & delete in Firebase Console -> Authentication -> Users -> filter "${acc.email}" (UID: ${acc.firebaseUid})\n# Or via Firebase Admin/CLI script after UID confirmation:\nfirebase auth:export auth-backup.json --project ${projectId}`
            : null,
          recommendation: acc.isProtected
            ? acc.accountType === 'GOOGLE_OWNER'
              ? 'PROTECTED_OWNER (GCP Owner — Never Delete)'
              : 'RETAIN_CANONICAL (Active 12 Nov Canonical Account)'
            : approvalState?.approved
            ? `APPROVED_BY_${String(approvalState.approvedBy || 'SUPERADMIN').toUpperCase()} (${activeBlockingDependencies === 0 ? 'Safe to Delete in Firebase Console' : 'Migrate Active Refs First'})`
            : activeBlockingDependencies > 0
            ? 'MIGRATE_REFS_THEN_APPROVE (Re-point user_roles email to canonical *@narid.com)'
            : 'READY_FOR_SUPERADMIN_REVIEW (No active blocking dependencies)',
        };
      });

      return res.json({
        success: true,
        auditTimestamp: new Date().toISOString(),
        projectId,
        collectionsScanned: ALL_CHECKED_COLLECTIONS.length,
        canonicalKeepEmails: ['superadmin@narid.com', 'admin@narid.com', 'user@narid.com'],
        accounts: accountsReport,
        safeguardMessage:
          'Read-only cross-collection dependency audit complete. Zero Firebase Auth accounts or Firestore documents were automatically deleted.',
      });
    } catch (err: any) {
      console.error('[Account Cleanup Audit API] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed account cleanup audit.' });
    }
  });

  app.post('/api/admin/account-cleanup/approve', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res);
      if (!caller) return;

      const { accountKey, migrateCanonicalEmails = true, confirmEmail } = req.body || {};
      const target = ACCOUNT_REGISTRY.find(a => a.key === accountKey);
      if (!target) {
        return res.status(404).json({ success: false, error: 'Target account entry not found.' });
      }
      if (target.isCanonicalKeep || target.isProtected) {
        return res.status(403).json({
          success: false,
          error: `Protected Account: "${target.email}" is a canonical/owner identity and cannot be marked for cleanup.`,
        });
      }
      if (confirmEmail !== target.email) {
        return res.status(400).json({
          success: false,
          error: `Confirmation mismatch. Please type exact email "${target.email}" to approve cleanup.`,
        });
      }

      const now = new Date().toISOString();

      // Safely promote user_roles canonical emails to *@narid.com before retiring *_root@narid.com
      const migratedDocs: string[] = [];
      if (migrateCanonicalEmails) {
        const canonicalMap: Record<string, { roleDocId: string; email: string; uid: string; legacyEmail: string }> = {
          superadmin_root_legacy: { roleDocId: 'role_superadmin', email: 'superadmin@narid.com', uid: 'oX2vdSx5jGcoUDxyA0SIYN3SEig2', legacyEmail: 'superadmin_root@narid.com' },
          admin_root_legacy: { roleDocId: 'role_admin', email: 'admin@narid.com', uid: '2RpEv6mvyXYswYH9KPIGV6evtgY2', legacyEmail: 'admin_root@narid.com' },
          user_root_legacy: { roleDocId: 'role_user', email: 'user@narid.com', uid: 'vXPvgrp3i6cS2frqDa3ZoU9h9gc2', legacyEmail: 'user_root@narid.com' },
        };
        const m = canonicalMap[target.key];
        if (m) {
          const ref = doc(db, 'user_roles', m.roleDocId);
          const snap = await getDoc(ref);
          if (snap.exists()) {
            const cur = snap.data();
            const aliases = new Set<string>(Array.isArray(cur.emailAliases) ? cur.emailAliases : []);
            aliases.add(m.legacyEmail);
            const uids = new Set<string>(Array.isArray(cur.linkedAuthUids) ? cur.linkedAuthUids : []);
            uids.add(m.uid);
            await updateDoc(ref, {
              email: m.email,
              authUid: m.uid,
              emailAliases: Array.from(aliases),
              linkedAuthUids: Array.from(uids),
              updatedAt: now,
            });
            migratedDocs.push(m.roleDocId);
          }
        }
      }

      // Record approval status
      const approvalRef = doc(db, 'system_settings', 'account_cleanup_approvals');
      const existingApprovalSnap = await getDoc(approvalRef);
      const existingApprovals = existingApprovalSnap.exists() ? (existingApprovalSnap.data()?.approvals || {}) : {};
      existingApprovals[target.key] = {
        approved: true,
        approvedBy: caller.loginId,
        approvedByUid: caller.uid,
        approvedAt: now,
        targetEmail: target.email,
        targetUid: target.firebaseUid,
        migratedDocs,
      };
      await setDoc(approvalRef, { id: 'account_cleanup_approvals', approvals: existingApprovals, updatedAt: now }, { merge: true });

      await recordEnterpriseAuditEvent(db, {
        req,
        action: 'account_cleanup_approved',
        category: 'ACCOUNT',
        severity: 'CRITICAL',
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: 'SUPER_ADMIN',
        targetType: 'FIREBASE_AUTH_ACCOUNT',
        targetId: target.firebaseUid,
        oldValue: { email: target.email, uid: target.firebaseUid },
        newValue: { status: 'APPROVED_FOR_CONSOLE_CLEANUP', migratedDocs },
        actionSource: 'ACCOUNT_CLEANUP_GOVERNANCE',
        description: `Super Admin "${caller.loginId}" approved Firebase Auth cleanup for legacy account "${target.email}" (UID: ${target.firebaseUid}).`,
      });

      const cliSnippet = `node -e "const admin=require('firebase-admin'); admin.initializeApp({projectId:'${projectId}'}); admin.auth().deleteUser('${target.firebaseUid}').then(()=>console.log('Deleted ${target.email}'));"`;

      return res.json({
        success: true,
        message: `Super Admin approval recorded for ${target.email}. Canonical Firestore references ${migratedDocs.length > 0 ? `(${migratedDocs.join(', ')}) migrated to *@narid.com` : 'verified clean'}.`,
        cliSnippet,
        consoleUrl: `https://console.firebase.google.com/project/${projectId}/authentication/users`,
      });
    } catch (err: any) {
      console.error('[Account Cleanup Approve API] Error:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Failed to approve account cleanup.' });
    }
  });
}
