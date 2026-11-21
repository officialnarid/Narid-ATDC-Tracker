import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import {
  type AdminFirestoreLike,
  type VerifiedCaller,
  normalizeRoleValue,
  recordEnterpriseAuditEvent,
} from './serverSecurityAudit.ts';
import {
  COMPANY_WIFI_DENIED_CODE,
  COMPANY_WIFI_DENIED_MESSAGE,
  type CompanyWifiAccessLog,
  type CompanyWifiAccessMode,
  type CompanyWifiLogEventType,
  type CompanyWifiManagedRoleId,
  type CompanyWifiNetwork,
  type CompanyWifiRolePolicy,
  type CompanyWifiSettings,
  getNetworkMatchTarget,
  ipMatchesCompanyWifiNetwork,
  isPrivateOrNonPublicIp,
  normalizeIpString,
  parseIpOrCidr,
  validatePublicCompanyWifiIpOrCidr,
} from './src/utils/companyWifiUtils.ts';

// ============================================================================
// Firestore Collection Names (Minimal Company Wi-Fi Access Control Schema)
// ============================================================================
export const COL_WIFI_NETWORKS = 'company_wifi_networks';
export const COL_WIFI_POLICIES = 'company_wifi_access_policies';
export const COL_WIFI_SETTINGS = 'company_wifi_settings';
export const COL_WIFI_LOGS = 'company_wifi_access_logs';

const SETTINGS_DOC_ID = 'global';
const MANAGED_ROLE_IDS: CompanyWifiManagedRoleId[] = ['admin', 'user'];

export const DEFAULT_WIFI_SETTINGS: CompanyWifiSettings = {
  enforcementEnabled: false, // Strictly OFF initially so existing accounts are never accidentally blocked
  trustedProxyHops: 1,
  policyVersion: 1,
  updatedAt: '',
  updatedBy: 'system',
};

function defaultRolePolicy(roleId: CompanyWifiManagedRoleId): CompanyWifiRolePolicy {
  return {
    roleId,
    allowedNetworkIds: [],
    accessMode: 'RESTRICTED',
    updatedAt: '',
    updatedBy: 'system',
  };
}

// ============================================================================
// Trusted Proxy Public IP Extraction (Spoof-Resistant — Never Trusts Client Payload)
// ============================================================================

function parseHeaderIpList(headerVal: string | string[] | undefined): string[] {
  if (!headerVal) return [];
  const joined = Array.isArray(headerVal) ? headerVal.join(',') : headerVal;
  return joined
    .split(',')
    .map((part) => normalizeIpString(part))
    .filter((ip) => {
      if (!ip) return false;
      const p = parseIpOrCidr(ip);
      return p.valid && !p.isCidr;
    });
}

/**
 * Extracts the server-observed Public IP from trusted reverse proxy headers or socket.
 * - Never trusts client-submitted IP fields in request bodies or query strings.
 * - On Vercel: prefers x-vercel-forwarded-for (set at Vercel Edge).
 * - Behind trusted proxy hops (default 1): reads right-to-left from X-Forwarded-For
 *   so client-prepended spoofed leftmost values are ignored.
 * - Falls back to req.socket.remoteAddress / req.ip.
 */
export function extractAuthoritativePublicIp(
  req: Request,
  trustedProxyHops = 1
): { ip: string; isPublic: boolean; source: string } {
  const safeHops = Math.max(0, Math.min(5, Math.floor(Number(trustedProxyHops) || 1)));

  const vercelIps = parseHeaderIpList(req.headers['x-vercel-forwarded-for']);
  if (vercelIps.length > 0 && safeHops > 0) {
    const ip = vercelIps[vercelIps.length - 1];
    return { ip, isPublic: !isPrivateOrNonPublicIp(ip), source: 'x-vercel-forwarded-for' };
  }

  const xffIps = parseHeaderIpList(req.headers['x-forwarded-for']);
  if (xffIps.length > 0 && safeHops > 0) {
    const idx = Math.max(0, xffIps.length - safeHops);
    const ip = xffIps[idx];
    return { ip, isPublic: !isPrivateOrNonPublicIp(ip), source: 'x-forwarded-for:trusted-hop' };
  }

  const directCandidate = normalizeIpString(req.socket?.remoteAddress || req.ip || '');
  if (directCandidate) {
    const parsed = parseIpOrCidr(directCandidate);
    if (parsed.valid && !parsed.isCidr) {
      return {
        ip: directCandidate,
        isPublic: !isPrivateOrNonPublicIp(directCandidate),
        source: 'socket',
      };
    }
  }

  return { ip: 'unavailable', isPublic: false, source: 'unavailable' };
}

// ============================================================================
// Scoped Per-DB Cache with Immediate Invalidation & Policy Version Sync
// ============================================================================

interface CachedWifiBundle {
  policyVersion: number;
  networks: CompanyWifiNetwork[];
  policies: Record<string, CompanyWifiRolePolicy>;
  loadedAtMs: number;
}

interface WifiDbCache {
  settingsLoadedAtMs: number;
  settings?: CompanyWifiSettings;
  bundle?: CachedWifiBundle;
}

const wifiCacheMap = new WeakMap<object, WifiDbCache>();

function getWifiCache(db: AdminFirestoreLike): WifiDbCache {
  let entry = wifiCacheMap.get(db as object);
  if (!entry) {
    entry = { settingsLoadedAtMs: 0 };
    wifiCacheMap.set(db as object, entry);
  }
  return entry;
}

export function invalidateCompanyWifiCache(db: AdminFirestoreLike): void {
  const entry = getWifiCache(db);
  entry.settingsLoadedAtMs = 0;
  entry.settings = undefined;
  entry.bundle = undefined;
}

function normalizeSettingsDoc(raw: Record<string, any> | undefined): CompanyWifiSettings {
  const d = raw || {};
  return {
    enforcementEnabled: Boolean(d.enforcementEnabled),
    trustedProxyHops:
      typeof d.trustedProxyHops === 'number' && Number.isFinite(d.trustedProxyHops)
        ? Math.max(0, Math.min(5, Math.floor(d.trustedProxyHops)))
        : 1,
    policyVersion:
      typeof d.policyVersion === 'number' && Number.isFinite(d.policyVersion)
        ? Math.max(1, Math.floor(d.policyVersion))
        : 1,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : 'system',
  };
}

function normalizeNetworkDoc(id: string, raw: Record<string, any> | undefined): CompanyWifiNetwork {
  const d = raw || {};
  const publicIp = String(d.publicIp || '').trim();
  const cidrRange = String(d.cidrRange || '').trim();
  const parsed = parseIpOrCidr(cidrRange || publicIp);
  return {
    networkId: String(d.networkId || id),
    networkName: String(d.networkName || 'Unnamed Wi-Fi').trim(),
    publicIp: parsed.valid ? parsed.publicIp : publicIp,
    cidrRange: parsed.valid && parsed.isCidr ? parsed.cidrRange : cidrRange,
    ipVersion: d.ipVersion === 'ipv6' || (parsed.valid && parsed.version === 'ipv6') ? 'ipv6' : 'ipv4',
    status: d.status === 'Inactive' ? 'Inactive' : 'Active',
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : '',
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
    createdBy: typeof d.createdBy === 'string' ? d.createdBy : 'system',
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : 'system',
  };
}

function normalizePolicyDoc(
  roleId: CompanyWifiManagedRoleId,
  raw: Record<string, any> | undefined
): CompanyWifiRolePolicy {
  if (!raw) return defaultRolePolicy(roleId);
  const accessMode: CompanyWifiAccessMode =
    String(raw.accessMode || '').toUpperCase() === 'UNRESTRICTED' ? 'UNRESTRICTED' : 'RESTRICTED';
  const allowedNetworkIds = Array.isArray(raw.allowedNetworkIds)
    ? Array.from(
        new Set(
          raw.allowedNetworkIds
            .map((v: unknown) => String(v || '').trim())
            .filter(Boolean)
        )
      )
    : [];
  return {
    roleId,
    allowedNetworkIds,
    accessMode,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : 'system',
  };
}

async function loadWifiSettings(
  db: AdminFirestoreLike,
  opts?: { forceFresh?: boolean; nowMs?: number }
): Promise<CompanyWifiSettings> {
  const nowMs = opts?.nowMs ?? Date.now();
  const cache = getWifiCache(db);
  // Short 3s cache when OFF (and always invalidated immediately on any mutation);
  // when enforcement is ON, always read the lightweight 1-doc settings to catch cross-instance updates immediately.
  if (
    !opts?.forceFresh &&
    cache.settings &&
    !cache.settings.enforcementEnabled &&
    nowMs - cache.settingsLoadedAtMs < 3_000
  ) {
    return cache.settings;
  }

  const snap = await db.collection(COL_WIFI_SETTINGS).doc(SETTINGS_DOC_ID).get();
  const settings = snap.exists ? normalizeSettingsDoc(snap.data()) : { ...DEFAULT_WIFI_SETTINGS };
  cache.settings = settings;
  cache.settingsLoadedAtMs = nowMs;
  return settings;
}

async function loadWifiBundle(
  db: AdminFirestoreLike,
  settings: CompanyWifiSettings,
  opts?: { forceFresh?: boolean; nowMs?: number }
): Promise<CachedWifiBundle> {
  const nowMs = opts?.nowMs ?? Date.now();
  const cache = getWifiCache(db);
  if (
    !opts?.forceFresh &&
    cache.bundle &&
    cache.bundle.policyVersion === settings.policyVersion &&
    nowMs - cache.bundle.loadedAtMs < 30_000
  ) {
    return cache.bundle;
  }

  const [netsSnap, adminPolicySnap, userPolicySnap] = await Promise.all([
    db.collection(COL_WIFI_NETWORKS).get(),
    db.collection(COL_WIFI_POLICIES).doc('admin').get(),
    db.collection(COL_WIFI_POLICIES).doc('user').get(),
  ]);

  const networks = netsSnap.docs
    .map((doc) => normalizeNetworkDoc(doc.id, doc.data()))
    .sort((a, b) => a.networkName.localeCompare(b.networkName));

  const policies: Record<string, CompanyWifiRolePolicy> = {
    admin: adminPolicySnap.exists
      ? normalizePolicyDoc('admin', adminPolicySnap.data())
      : defaultRolePolicy('admin'),
    user: userPolicySnap.exists
      ? normalizePolicyDoc('user', userPolicySnap.data())
      : defaultRolePolicy('user'),
  };

  const bundle: CachedWifiBundle = {
    policyVersion: settings.policyVersion,
    networks,
    policies,
    loadedAtMs: nowMs,
  };
  cache.bundle = bundle;
  return bundle;
}

async function bumpPolicyVersion(
  db: AdminFirestoreLike,
  actorLabel: string,
  nowIso: string,
  patch?: Partial<Pick<CompanyWifiSettings, 'enforcementEnabled' | 'trustedProxyHops'>>
): Promise<CompanyWifiSettings> {
  const ref = db.collection(COL_WIFI_SETTINGS).doc(SETTINGS_DOC_ID);
  const snap = await ref.get();
  const current = snap.exists ? normalizeSettingsDoc(snap.data()) : { ...DEFAULT_WIFI_SETTINGS };
  const next: CompanyWifiSettings = {
    enforcementEnabled:
      patch?.enforcementEnabled !== undefined
        ? Boolean(patch.enforcementEnabled)
        : current.enforcementEnabled,
    trustedProxyHops:
      patch?.trustedProxyHops !== undefined
        ? Math.max(0, Math.min(5, Math.floor(patch.trustedProxyHops)))
        : current.trustedProxyHops,
    policyVersion: current.policyVersion + 1,
    updatedAt: nowIso,
    updatedBy: actorLabel,
  };
  await ref.set(next);
  invalidateCompanyWifiCache(db);
  return next;
}

async function writeWifiAccessLog(
  db: AdminFirestoreLike,
  entry: Omit<CompanyWifiAccessLog, 'id'>
): Promise<CompanyWifiAccessLog> {
  const id = `wlog_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const doc: CompanyWifiAccessLog = {
    id,
    actorUid: String(entry.actorUid || 'unknown'),
    actorLoginId: String(entry.actorLoginId || 'unknown'),
    actorRole: String(entry.actorRole || 'UNKNOWN').toUpperCase(),
    eventType: entry.eventType,
    observedIp: String(entry.observedIp || 'unavailable'),
    networkId: entry.networkId || null,
    networkName: entry.networkName || null,
    targetRole: entry.targetRole || null,
    detail: entry.detail ? String(entry.detail).slice(0, 500) : '',
    timestamp: entry.timestamp,
    result: entry.result,
  };
  try {
    await db.collection(COL_WIFI_LOGS).doc(id).set(doc);
  } catch (err) {
    console.warn('[CompanyWifi] Failed to persist access log:', err);
  }
  return doc;
}

// ============================================================================
// Authoritative Server-Side Enforcement Engine (Called on Every Protected API)
// ============================================================================

export interface CompanyWifiEnforcementOutcome {
  allowed: boolean;
  enforcementEnabled: boolean;
  bypassReason?: 'SUPER_ADMIN' | 'ENFORCEMENT_OFF' | 'ROLE_UNRESTRICTED' | null;
  observedIp: string;
  observedIpIsPublic: boolean;
  matchedNetwork: CompanyWifiNetwork | null;
  httpStatus?: number;
  safeErrorPayload?: {
    success: false;
    code: string;
    error: string;
  };
}

export async function enforceCompanyWifiAccess(
  db: AdminFirestoreLike,
  req: Request,
  caller: VerifiedCaller,
  opts?: { nowMs?: number; skipBlockLog?: boolean }
): Promise<CompanyWifiEnforcementOutcome> {
  const roleId = normalizeRoleValue(caller.role);

  // 1. SUPER_ADMIN PERMANENT UNRESTRICTED BYPASS (Cannot be disabled or overridden)
  if (roleId === 'super_admin') {
    const observed = extractAuthoritativePublicIp(req, 1);
    return {
      allowed: true,
      enforcementEnabled: false,
      bypassReason: 'SUPER_ADMIN',
      observedIp: observed.ip,
      observedIpIsPublic: observed.isPublic,
      matchedNetwork: null,
    };
  }

  const nowMs = opts?.nowMs ?? Date.now();
  const settings = await loadWifiSettings(db, { nowMs });
  const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);

  // 2. Global enforcement OFF -> allow without blocking
  if (!settings.enforcementEnabled) {
    return {
      allowed: true,
      enforcementEnabled: false,
      bypassReason: 'ENFORCEMENT_OFF',
      observedIp: observed.ip,
      observedIpIsPublic: observed.isPublic,
      matchedNetwork: null,
    };
  }

  // 3. Enforcement ON -> evaluate role policy authoritatively
  const bundle = await loadWifiBundle(db, settings, { nowMs });
  const rolePolicy =
    roleId === 'admin'
      ? bundle.policies.admin
      : roleId === 'user'
      ? bundle.policies.user
      : // Any non-super-admin custom role defaults to secure deny-by-default unless explicitly unrestricted
        defaultRolePolicy('user');

  if (rolePolicy.accessMode === 'UNRESTRICTED') {
    return {
      allowed: true,
      enforcementEnabled: true,
      bypassReason: 'ROLE_UNRESTRICTED',
      observedIp: observed.ip,
      observedIpIsPublic: observed.isPublic,
      matchedNetwork: null,
    };
  }

  // 4. Restricted role: must match an ACTIVE network assigned to this role, and observed IP must be a valid public IP
  const networksById = new Map(bundle.networks.map((n) => [n.networkId, n]));
  const activeAllowedNetworks = rolePolicy.allowedNetworkIds
    .map((id) => networksById.get(id))
    .filter((net): net is CompanyWifiNetwork => Boolean(net && net.status === 'Active'));

  const matchedNetwork =
    observed.isPublic && activeAllowedNetworks.length > 0
      ? activeAllowedNetworks.find((net) => ipMatchesCompanyWifiNetwork(observed.ip, net)) || null
      : null;

  if (matchedNetwork) {
    return {
      allowed: true,
      enforcementEnabled: true,
      bypassReason: null,
      observedIp: observed.ip,
      observedIpIsPublic: observed.isPublic,
      matchedNetwork,
    };
  }

  // 5. Blocked: record safe audit log without exposing permitted IP list in HTTP response
  if (!opts?.skipBlockLog) {
    const nowIso = new Date(nowMs).toISOString();
    const reasonDetail =
      activeAllowedNetworks.length === 0
        ? `Role "${roleId.toUpperCase()}" has no active Company Wi-Fi networks assigned (deny-by-default).`
        : !observed.isPublic
        ? `Observed IP "${observed.ip}" is not a valid public IP.`
        : `Observed IP "${observed.ip}" is not in allowed Company Wi-Fi networks for role "${roleId.toUpperCase()}".`;

    await writeWifiAccessLog(db, {
      actorUid: caller.uid,
      actorLoginId: caller.loginId,
      actorRole: roleId.toUpperCase(),
      eventType: 'ACCESS_BLOCKED',
      observedIp: observed.ip,
      networkId: null,
      networkName: null,
      targetRole: roleId,
      detail: `${reasonDetail} (${req.method} ${req.path})`,
      timestamp: nowIso,
      result: 'Blocked',
    });
  }

  return {
    allowed: false,
    enforcementEnabled: true,
    bypassReason: null,
    observedIp: observed.ip,
    observedIpIsPublic: observed.isPublic,
    matchedNetwork: null,
    httpStatus: 403,
    safeErrorPayload: {
      success: false,
      code: COMPANY_WIFI_DENIED_CODE,
      error: COMPANY_WIFI_DENIED_MESSAGE,
    },
  };
}

// ============================================================================
// Input Validation Schemas (Zod)
// ============================================================================

const NetworkCreateSchema = z.object({
  networkName: z
    .string()
    .trim()
    .min(2, 'Company Wi-Fi name must be at least 2 characters.')
    .max(80, 'Company Wi-Fi name must be 80 characters or fewer.'),
  ipOrCidr: z
    .string()
    .trim()
    .min(3, 'Public IP address or CIDR range is required.')
    .max(64),
  status: z.enum(['Active', 'Inactive']).default('Active'),
});

const NetworkUpdateSchema = z.object({
  networkName: z
    .string()
    .trim()
    .min(2, 'Company Wi-Fi name must be at least 2 characters.')
    .max(80, 'Company Wi-Fi name must be 80 characters or fewer.')
    .optional(),
  ipOrCidr: z.string().trim().min(3).max(64).optional(),
  status: z.enum(['Active', 'Inactive']).optional(),
});

const NetworkStatusSchema = z.object({
  status: z.enum(['Active', 'Inactive']),
});

const RolePolicyUpdateSchema = z.object({
  accessMode: z.enum(['RESTRICTED', 'UNRESTRICTED']),
  allowedNetworkIds: z.array(z.string().trim().min(1).max(128)).max(200),
});

const SettingsUpdateSchema = z.object({
  enforcementEnabled: z.boolean(),
  confirmEnable: z.boolean().optional(),
  trustedProxyHops: z.number().int().min(0).max(5).optional(),
});

// ============================================================================
// Express Route Registration
// ============================================================================

export function registerCompanyWifiRoutes(
  app: Express,
  deps: {
    db: AdminFirestoreLike;
    requireVerifiedCaller: (
      req: Request,
      res: Response,
      allowedRoles: string[] | '*',
      actionLabel: string,
      options?: { skipWifiCheck?: boolean }
    ) => Promise<VerifiedCaller | null>;
    nowProvider?: () => number;
  }
): void {
  const { db, requireVerifiedCaller } = deps;
  const getNowMs = deps.nowProvider || (() => Date.now());

  const requireSuperAdmin = (req: Request, res: Response, actionLabel: string) =>
    requireVerifiedCaller(req, res, ['super_admin'], actionLabel, { skipWifiCheck: true });

  // --------------------------------------------------------------------------
  // 1. GET /api/company-wifi/check — Caller Self-Check (Authenticated Any Role)
  //    Never exposes permitted IP list or internal policy structure.
  // --------------------------------------------------------------------------
  app.get('/api/company-wifi/check', async (req: Request, res: Response) => {
    try {
      const caller = await requireVerifiedCaller(
        req,
        res,
        '*',
        'Check Company Wi-Fi Access',
        { skipWifiCheck: true }
      );
      if (!caller) return;

      const outcome = await enforceCompanyWifiAccess(db, req, caller, {
        nowMs: getNowMs(),
        skipBlockLog: req.query.dry === '1',
      });

      if (!outcome.allowed) {
        return res.status(403).json({
          success: false,
          allowed: false,
          enforcementEnabled: true,
          role: caller.role,
          code: COMPANY_WIFI_DENIED_CODE,
          error: COMPANY_WIFI_DENIED_MESSAGE,
        });
      }

      return res.json({
        success: true,
        allowed: true,
        enforcementEnabled: outcome.enforcementEnabled,
        role: caller.role,
        bypassReason: outcome.bypassReason || null,
        matchedNetworkName: outcome.matchedNetwork?.networkName || null,
      });
    } catch (err) {
      console.error('[CompanyWifi] Check error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to verify Company Wi-Fi access status.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 2. GET /api/company-wifi/dashboard — Super Admin Summary & Full Config
  // --------------------------------------------------------------------------
  app.get('/api/company-wifi/dashboard', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'View Company Wi-Fi Access Dashboard');
      if (!caller) return;

      const nowMs = getNowMs();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const bundle = await loadWifiBundle(db, settings, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);

      const activeNetworks = bundle.networks.filter((n) => n.status === 'Active');
      const activeIds = new Set(activeNetworks.map((n) => n.networkId));

      const adminPolicy = bundle.policies.admin;
      const userPolicy = bundle.policies.user;

      const adminAllowedCount = adminPolicy.allowedNetworkIds.filter((id) => activeIds.has(id)).length;
      const userAllowedCount = userPolicy.allowedNetworkIds.filter((id) => activeIds.has(id)).length;

      const matchedNetwork = observed.isPublic
        ? activeNetworks.find((n) => ipMatchesCompanyWifiNetwork(observed.ip, n)) || null
        : null;

      const timestamps = [
        settings.updatedAt,
        adminPolicy.updatedAt,
        userPolicy.updatedAt,
        ...bundle.networks.map((n) => n.updatedAt),
      ].filter(Boolean);
      const lastPolicyUpdate =
        timestamps.length > 0 ? timestamps.sort().reverse()[0] : null;

      return res.json({
        success: true,
        settings,
        summary: {
          enforcementEnabled: settings.enforcementEnabled,
          totalNetworks: bundle.networks.length,
          activeNetworks: activeNetworks.length,
          adminAllowedCount,
          userAllowedCount,
          currentObservedIp: observed.ip,
          currentObservedIpIsPublic: observed.isPublic,
          currentNetworkMatched: Boolean(matchedNetwork),
          currentMatchedNetworkId: matchedNetwork?.networkId || null,
          currentMatchedNetworkName: matchedNetwork?.networkName || null,
          lastPolicyUpdate,
        },
        networks: bundle.networks,
        policies: {
          admin: adminPolicy,
          user: userPolicy,
        },
      });
    } catch (err) {
      console.error('[CompanyWifi] Dashboard error:', err);
      return res.status(500).json({
        success: false,
        error: 'Failed to load Company Wi-Fi Access Control dashboard.',
      });
    }
  });

  // --------------------------------------------------------------------------
  // 3. GET /api/company-wifi/networks — List All Company Wi-Fi Networks
  // --------------------------------------------------------------------------
  app.get('/api/company-wifi/networks', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'List Company Wi-Fi Networks');
      if (!caller) return;

      const nowMs = getNowMs();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const bundle = await loadWifiBundle(db, settings, { forceFresh: true, nowMs });
      return res.json({ success: true, networks: bundle.networks });
    } catch (err) {
      console.error('[CompanyWifi] List networks error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load Company Wi-Fi networks.' });
    }
  });

  // --------------------------------------------------------------------------
  // 4. POST /api/company-wifi/networks — Add Company Wi-Fi Network
  // --------------------------------------------------------------------------
  app.post('/api/company-wifi/networks', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'Add Company Wi-Fi Network');
      if (!caller) return;

      const parsedBody = NetworkCreateSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({
          success: false,
          error: parsedBody.error.issues[0]?.message || 'Invalid Company Wi-Fi network payload.',
        });
      }

      const ipValidation = validatePublicCompanyWifiIpOrCidr(parsedBody.data.ipOrCidr);
      if (!ipValidation.valid) {
        return res.status(400).json({
          success: false,
          error: ipValidation.error || 'Invalid Public IP or CIDR range.',
        });
      }

      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);

      // Prevent duplicate normalized IP/CIDR or duplicate name
      const existingSnap = await db.collection(COL_WIFI_NETWORKS).get();
      const existingList = existingSnap.docs.map((d) => normalizeNetworkDoc(d.id, d.data()));
      const duplicateTarget = existingList.find(
        (n) => getNetworkMatchTarget(n).toLowerCase() === ipValidation.normalized.toLowerCase()
      );
      if (duplicateTarget) {
        return res.status(409).json({
          success: false,
          error: `Public IP/CIDR "${ipValidation.normalized}" is already registered as "${duplicateTarget.networkName}".`,
        });
      }

      const networkId = `wifi_${nowMs}_${crypto.randomBytes(3).toString('hex')}`;
      const newNetwork: CompanyWifiNetwork = {
        networkId,
        networkName: parsedBody.data.networkName,
        publicIp: ipValidation.publicIp,
        cidrRange: ipValidation.cidrRange,
        ipVersion: ipValidation.version,
        status: parsedBody.data.status,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: caller.uid,
        updatedBy: caller.uid,
      };

      await db.collection(COL_WIFI_NETWORKS).doc(networkId).set(newNetwork);
      await bumpPolicyVersion(db, caller.loginId, nowIso);

      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          eventType: 'NETWORK_ADDED',
          observedIp: observed.ip,
          networkId,
          networkName: newNetwork.networkName,
          detail: `Added Company Wi-Fi "${newNetwork.networkName}" (${ipValidation.normalized}, ${newNetwork.status}).`,
          timestamp: nowIso,
          result: 'Updated',
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: 'company_wifi_network_added',
          category: 'SECURITY',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          targetType: 'COMPANY_WIFI_NETWORK',
          targetId: networkId,
          newValue: `${newNetwork.networkName} (${ipValidation.normalized})`,
          actionSource: 'COMPANY_WIFI_CONTROL',
          description: `Added Company Wi-Fi "${newNetwork.networkName}" (${ipValidation.normalized}).`,
        }),
      ]);

      return res.status(201).json({ success: true, network: newNetwork });
    } catch (err) {
      console.error('[CompanyWifi] Create network error:', err);
      return res.status(500).json({ success: false, error: 'Failed to add Company Wi-Fi network.' });
    }
  });

  // --------------------------------------------------------------------------
  // 5. PUT /api/company-wifi/networks/:networkId — Edit Company Wi-Fi Network
  // --------------------------------------------------------------------------
  app.put('/api/company-wifi/networks/:networkId', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'Update Company Wi-Fi Network');
      if (!caller) return;

      const networkId = String(req.params.networkId || '').trim();
      if (!networkId || !/^[a-zA-Z0-9_-]{3,128}$/.test(networkId)) {
        return res.status(400).json({ success: false, error: 'Invalid network ID.' });
      }

      const parsedBody = NetworkUpdateSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({
          success: false,
          error: parsedBody.error.issues[0]?.message || 'Invalid update payload.',
        });
      }

      const docRef = db.collection(COL_WIFI_NETWORKS).doc(networkId);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: 'Company Wi-Fi network not found.' });
      }

      const current = normalizeNetworkDoc(networkId, snap.data());
      let nextPublicIp = current.publicIp;
      let nextCidrRange = current.cidrRange;
      let nextIpVersion = current.ipVersion;

      if (parsedBody.data.ipOrCidr !== undefined) {
        const ipValidation = validatePublicCompanyWifiIpOrCidr(parsedBody.data.ipOrCidr);
        if (!ipValidation.valid) {
          return res.status(400).json({
            success: false,
            error: ipValidation.error || 'Invalid Public IP or CIDR range.',
          });
        }
        const existingSnap = await db.collection(COL_WIFI_NETWORKS).get();
        const duplicateTarget = existingSnap.docs
          .map((d) => normalizeNetworkDoc(d.id, d.data()))
          .find(
            (n) =>
              n.networkId !== networkId &&
              getNetworkMatchTarget(n).toLowerCase() === ipValidation.normalized.toLowerCase()
          );
        if (duplicateTarget) {
          return res.status(409).json({
            success: false,
            error: `Public IP/CIDR "${ipValidation.normalized}" is already registered as "${duplicateTarget.networkName}".`,
          });
        }
        nextPublicIp = ipValidation.publicIp;
        nextCidrRange = ipValidation.cidrRange;
        nextIpVersion = ipValidation.version;
      }

      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);

      const updated: CompanyWifiNetwork = {
        ...current,
        networkName: parsedBody.data.networkName ?? current.networkName,
        publicIp: nextPublicIp,
        cidrRange: nextCidrRange,
        ipVersion: nextIpVersion,
        status: parsedBody.data.status ?? current.status,
        updatedAt: nowIso,
        updatedBy: caller.uid,
      };

      await docRef.set(updated);
      await bumpPolicyVersion(db, caller.loginId, nowIso);

      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          eventType: 'NETWORK_UPDATED',
          observedIp: observed.ip,
          networkId,
          networkName: updated.networkName,
          detail: `Updated Company Wi-Fi "${updated.networkName}" (${getNetworkMatchTarget(updated)}, ${updated.status}).`,
          timestamp: nowIso,
          result: 'Updated',
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: 'company_wifi_network_updated',
          category: 'SECURITY',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          targetType: 'COMPANY_WIFI_NETWORK',
          targetId: networkId,
          oldValue: `${current.networkName} (${getNetworkMatchTarget(current)}, ${current.status})`,
          newValue: `${updated.networkName} (${getNetworkMatchTarget(updated)}, ${updated.status})`,
          actionSource: 'COMPANY_WIFI_CONTROL',
          description: `Updated Company Wi-Fi "${updated.networkName}".`,
        }),
      ]);

      return res.json({ success: true, network: updated });
    } catch (err) {
      console.error('[CompanyWifi] Update network error:', err);
      return res.status(500).json({ success: false, error: 'Failed to update Company Wi-Fi network.' });
    }
  });

  // --------------------------------------------------------------------------
  // 6. PATCH /api/company-wifi/networks/:networkId/status — Enable/Disable Wi-Fi
  // --------------------------------------------------------------------------
  app.patch('/api/company-wifi/networks/:networkId/status', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'Toggle Company Wi-Fi Status');
      if (!caller) return;

      const networkId = String(req.params.networkId || '').trim();
      if (!networkId || !/^[a-zA-Z0-9_-]{3,128}$/.test(networkId)) {
        return res.status(400).json({ success: false, error: 'Invalid network ID.' });
      }

      const parsedBody = NetworkStatusSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({ success: false, error: 'Status must be Active or Inactive.' });
      }

      const docRef = db.collection(COL_WIFI_NETWORKS).doc(networkId);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: 'Company Wi-Fi network not found.' });
      }

      const current = normalizeNetworkDoc(networkId, snap.data());
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);

      const updated: CompanyWifiNetwork = {
        ...current,
        status: parsedBody.data.status,
        updatedAt: nowIso,
        updatedBy: caller.uid,
      };

      await docRef.set(updated);
      await bumpPolicyVersion(db, caller.loginId, nowIso);

      await writeWifiAccessLog(db, {
        actorUid: caller.uid,
        actorLoginId: caller.loginId,
        actorRole: 'SUPER_ADMIN',
        eventType: 'NETWORK_STATUS_CHANGED',
        observedIp: observed.ip,
        networkId,
        networkName: updated.networkName,
        detail: `Changed "${updated.networkName}" status from ${current.status} to ${updated.status}.`,
        timestamp: nowIso,
        result: 'Updated',
      });

      return res.json({ success: true, network: updated });
    } catch (err) {
      console.error('[CompanyWifi] Status toggle error:', err);
      return res.status(500).json({ success: false, error: 'Failed to update network status.' });
    }
  });

  // --------------------------------------------------------------------------
  // 7. DELETE /api/company-wifi/networks/:networkId — Delete Company Wi-Fi
  //    Removes dangling networkId references from admin & user policies cleanly.
  // --------------------------------------------------------------------------
  app.delete('/api/company-wifi/networks/:networkId', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'Delete Company Wi-Fi Network');
      if (!caller) return;

      const networkId = String(req.params.networkId || '').trim();
      if (!networkId || !/^[a-zA-Z0-9_-]{3,128}$/.test(networkId)) {
        return res.status(400).json({ success: false, error: 'Invalid network ID.' });
      }

      const docRef = db.collection(COL_WIFI_NETWORKS).doc(networkId);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ success: false, error: 'Company Wi-Fi network not found.' });
      }

      const existing = normalizeNetworkDoc(networkId, snap.data());
      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);

      await docRef.delete();

      // Remove deleted networkId from ADMIN and USER policies so no stale reference lingers
      for (const roleId of MANAGED_ROLE_IDS) {
        const polRef = db.collection(COL_WIFI_POLICIES).doc(roleId);
        const polSnap = await polRef.get();
        if (polSnap.exists) {
          const pol = normalizePolicyDoc(roleId, polSnap.data());
          if (pol.allowedNetworkIds.includes(networkId)) {
            await polRef.set({
              ...pol,
              allowedNetworkIds: pol.allowedNetworkIds.filter((id) => id !== networkId),
              updatedAt: nowIso,
              updatedBy: caller.uid,
            });
          }
        }
      }

      await bumpPolicyVersion(db, caller.loginId, nowIso);

      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          eventType: 'NETWORK_DELETED',
          observedIp: observed.ip,
          networkId,
          networkName: existing.networkName,
          detail: `Deleted Company Wi-Fi "${existing.networkName}" (${getNetworkMatchTarget(existing)}).`,
          timestamp: nowIso,
          result: 'Updated',
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: 'company_wifi_network_deleted',
          category: 'SECURITY',
          severity: 'WARNING',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          targetType: 'COMPANY_WIFI_NETWORK',
          targetId: networkId,
          oldValue: `${existing.networkName} (${getNetworkMatchTarget(existing)})`,
          actionSource: 'COMPANY_WIFI_CONTROL',
          description: `Deleted Company Wi-Fi "${existing.networkName}".`,
        }),
      ]);

      return res.json({ success: true, deletedNetworkId: networkId });
    } catch (err) {
      console.error('[CompanyWifi] Delete network error:', err);
      return res.status(500).json({ success: false, error: 'Failed to delete Company Wi-Fi network.' });
    }
  });

  // --------------------------------------------------------------------------
  // 8. PUT /api/company-wifi/policies/:roleId — Save ADMIN or USER Wi-Fi Policy
  //    Strictly rejects super_admin so SUPER_ADMIN can never be restricted.
  // --------------------------------------------------------------------------
  app.put('/api/company-wifi/policies/:roleId', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'Update Role Company Wi-Fi Policy');
      if (!caller) return;

      const rawRoleId = normalizeRoleValue(req.params.roleId);
      if (rawRoleId === 'super_admin') {
        return res.status(400).json({
          success: false,
          error: 'SUPER_ADMIN is permanently unrestricted and cannot be assigned Company Wi-Fi restrictions.',
        });
      }
      if (rawRoleId !== 'admin' && rawRoleId !== 'user') {
        return res.status(400).json({
          success: false,
          error: 'Only ADMIN and USER roles can be configured in Company Wi-Fi Access Control.',
        });
      }

      const parsedBody = RolePolicyUpdateSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({
          success: false,
          error: parsedBody.error.issues[0]?.message || 'Invalid role policy payload.',
        });
      }

      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const settings = await loadWifiSettings(db, { forceFresh: true, nowMs });
      const observed = extractAuthoritativePublicIp(req, settings.trustedProxyHops);

      // Verify all referenced networkIds actually exist
      const netsSnap = await db.collection(COL_WIFI_NETWORKS).get();
      const existingNetMap = new Map(
        netsSnap.docs.map((d) => {
          const n = normalizeNetworkDoc(d.id, d.data());
          return [n.networkId, n];
        })
      );

      const dedupIds = Array.from(new Set(parsedBody.data.allowedNetworkIds));
      const unknownIds = dedupIds.filter((id) => !existingNetMap.has(id));
      if (unknownIds.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Unknown Company Wi-Fi network ID(s): ${unknownIds.join(', ')}.`,
        });
      }

      const policyRef = db.collection(COL_WIFI_POLICIES).doc(rawRoleId);
      const prevSnap = await policyRef.get();
      const prevPolicy = prevSnap.exists
        ? normalizePolicyDoc(rawRoleId, prevSnap.data())
        : defaultRolePolicy(rawRoleId);

      const nextPolicy: CompanyWifiRolePolicy = {
        roleId: rawRoleId,
        allowedNetworkIds: dedupIds,
        accessMode: parsedBody.data.accessMode,
        updatedAt: nowIso,
        updatedBy: caller.uid,
      };

      await policyRef.set(nextPolicy);
      await bumpPolicyVersion(db, caller.loginId, nowIso);

      const allowedNames = dedupIds
        .map((id) => existingNetMap.get(id)?.networkName || id)
        .join(', ');

      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          eventType: 'POLICY_UPDATED',
          observedIp: observed.ip,
          networkId: null,
          targetRole: rawRoleId,
          detail: `Updated ${rawRoleId.toUpperCase()} policy: mode=${nextPolicy.accessMode}, allowed=[${allowedNames || 'none'}].`,
          timestamp: nowIso,
          result: 'Updated',
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: 'company_wifi_policy_updated',
          category: 'SECURITY',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          targetType: 'COMPANY_WIFI_POLICY',
          targetId: rawRoleId,
          oldValue: `${prevPolicy.accessMode} (${prevPolicy.allowedNetworkIds.length} network(s))`,
          newValue: `${nextPolicy.accessMode} (${nextPolicy.allowedNetworkIds.length} network(s))`,
          actionSource: 'COMPANY_WIFI_CONTROL',
          description: `Updated Company Wi-Fi access policy for ${rawRoleId.toUpperCase()}.`,
        }),
      ]);

      return res.json({ success: true, policy: nextPolicy });
    } catch (err) {
      console.error('[CompanyWifi] Update role policy error:', err);
      return res.status(500).json({ success: false, error: 'Failed to save role Wi-Fi policy.' });
    }
  });

  // --------------------------------------------------------------------------
  // 9. PUT /api/company-wifi/settings — Toggle Global Enforcement ON / OFF
  // --------------------------------------------------------------------------
  app.put('/api/company-wifi/settings', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'Update Company Wi-Fi Enforcement Settings');
      if (!caller) return;

      const parsedBody = SettingsUpdateSchema.safeParse(req.body || {});
      if (!parsedBody.success) {
        return res.status(400).json({
          success: false,
          error: parsedBody.error.issues[0]?.message || 'Invalid settings payload.',
        });
      }

      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const current = await loadWifiSettings(db, { forceFresh: true, nowMs });

      if (parsedBody.data.enforcementEnabled && !current.enforcementEnabled && !parsedBody.data.confirmEnable) {
        return res.status(400).json({
          success: false,
          error: 'Explicit confirmation is required before enabling Company Wi-Fi Access Control enforcement.',
        });
      }

      const nextSettings = await bumpPolicyVersion(db, caller.loginId, nowIso, {
        enforcementEnabled: parsedBody.data.enforcementEnabled,
        trustedProxyHops: parsedBody.data.trustedProxyHops,
      });

      const observed = extractAuthoritativePublicIp(req, nextSettings.trustedProxyHops);
      const eventType: CompanyWifiLogEventType = nextSettings.enforcementEnabled
        ? 'ENFORCEMENT_ENABLED'
        : 'ENFORCEMENT_DISABLED';

      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          eventType,
          observedIp: observed.ip,
          networkId: null,
          detail: `Global Company Wi-Fi enforcement set to ${nextSettings.enforcementEnabled ? 'ON' : 'OFF'}.`,
          timestamp: nowIso,
          result: 'Updated',
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: nextSettings.enforcementEnabled
            ? 'company_wifi_enforcement_enabled'
            : 'company_wifi_enforcement_disabled',
          category: 'SECURITY',
          severity: 'WARNING',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          targetType: 'COMPANY_WIFI_SETTINGS',
          targetId: SETTINGS_DOC_ID,
          oldValue: `enforcementEnabled=${current.enforcementEnabled}`,
          newValue: `enforcementEnabled=${nextSettings.enforcementEnabled}`,
          actionSource: 'COMPANY_WIFI_CONTROL',
          description: `Company Wi-Fi Access Control enforcement turned ${nextSettings.enforcementEnabled ? 'ON' : 'OFF'}.`,
        }),
      ]);

      return res.json({ success: true, settings: nextSettings });
    } catch (err) {
      console.error('[CompanyWifi] Update settings error:', err);
      return res.status(500).json({ success: false, error: 'Failed to update Company Wi-Fi settings.' });
    }
  });

  // --------------------------------------------------------------------------
  // 10. POST /api/company-wifi/emergency-disable — Super Admin Safe Recovery
  // --------------------------------------------------------------------------
  app.post('/api/company-wifi/emergency-disable', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'Emergency Disable Company Wi-Fi Enforcement');
      if (!caller) return;

      const nowMs = getNowMs();
      const nowIso = new Date(nowMs).toISOString();
      const nextSettings = await bumpPolicyVersion(db, caller.loginId, nowIso, {
        enforcementEnabled: false,
      });
      const observed = extractAuthoritativePublicIp(req, nextSettings.trustedProxyHops);

      await Promise.all([
        writeWifiAccessLog(db, {
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          eventType: 'EMERGENCY_DISABLED',
          observedIp: observed.ip,
          networkId: null,
          detail: 'Super Admin triggered Emergency Disable for Company Wi-Fi Access Control.',
          timestamp: nowIso,
          result: 'Updated',
        }),
        recordEnterpriseAuditEvent(db, {
          req,
          action: 'company_wifi_emergency_disable',
          category: 'SECURITY',
          severity: 'CRITICAL',
          actorUid: caller.uid,
          actorLoginId: caller.loginId,
          actorRole: 'SUPER_ADMIN',
          targetType: 'COMPANY_WIFI_SETTINGS',
          targetId: SETTINGS_DOC_ID,
          newValue: 'enforcementEnabled=false',
          actionSource: 'COMPANY_WIFI_EMERGENCY_RECOVERY',
          description: 'Super Admin disabled Company Wi-Fi enforcement via Emergency Recovery.',
        }),
      ]);

      return res.json({
        success: true,
        settings: nextSettings,
        message: 'Company Wi-Fi enforcement has been disabled immediately.',
      });
    } catch (err) {
      console.error('[CompanyWifi] Emergency disable error:', err);
      return res.status(500).json({ success: false, error: 'Failed to disable enforcement.' });
    }
  });

  // --------------------------------------------------------------------------
  // 11. GET /api/company-wifi/logs — Super Admin Access & Audit History
  // --------------------------------------------------------------------------
  app.get('/api/company-wifi/logs', async (req: Request, res: Response) => {
    try {
      const caller = await requireSuperAdmin(req, res, 'View Company Wi-Fi Access Logs');
      if (!caller) return;

      const eventTypeFilter = String(req.query.eventType || '').trim().toUpperCase();
      const resultFilter = String(req.query.result || '').trim().toLowerCase();
      const searchFilter = String(req.query.search || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '100'), 10) || 100));

      const snap = await db.collection(COL_WIFI_LOGS).get();
      let logs: CompanyWifiAccessLog[] = snap.docs
        .map((d) => {
          const data = d.data() || {};
          return {
            id: String(data.id || d.id),
            actorUid: String(data.actorUid || 'unknown'),
            actorLoginId: String(data.actorLoginId || 'unknown'),
            actorRole: String(data.actorRole || 'UNKNOWN'),
            eventType: (data.eventType || 'ACCESS_BLOCKED') as CompanyWifiLogEventType,
            observedIp: String(data.observedIp || 'unavailable'),
            networkId: data.networkId || null,
            networkName: data.networkName || null,
            targetRole: data.targetRole || null,
            detail: String(data.detail || ''),
            timestamp: String(data.timestamp || ''),
            result: (data.result || 'Updated') as CompanyWifiAccessLog['result'],
          };
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      if (eventTypeFilter && eventTypeFilter !== 'ALL') {
        logs = logs.filter((l) => l.eventType === eventTypeFilter);
      }
      if (resultFilter && resultFilter !== 'all') {
        logs = logs.filter((l) => l.result.toLowerCase() === resultFilter);
      }
      if (searchFilter) {
        logs = logs.filter(
          (l) =>
            l.actorLoginId.toLowerCase().includes(searchFilter) ||
            l.actorUid.toLowerCase().includes(searchFilter) ||
            l.observedIp.toLowerCase().includes(searchFilter) ||
            (l.networkName || '').toLowerCase().includes(searchFilter) ||
            (l.detail || '').toLowerCase().includes(searchFilter)
        );
      }

      return res.json({
        success: true,
        total: logs.length,
        logs: logs.slice(0, limit),
      });
    } catch (err) {
      console.error('[CompanyWifi] Logs error:', err);
      return res.status(500).json({ success: false, error: 'Failed to load Company Wi-Fi access history.' });
    }
  });
}
