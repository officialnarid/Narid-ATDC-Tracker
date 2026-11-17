import type { AdminFirestoreLike } from './serverSecurityAudit.ts';

// ============================================================================
// Scoped, Invalidatable Server Cache & Performance Timing Helper
// ============================================================================
// CRITICAL: All cache buckets are strictly scoped per Firestore `db` instance via
// WeakMap so isolated test doubles (InMemoryFirestore) never leak state across
// test cases while production Express / Vercel containers reuse warm config.
//
// SECURITY INVARIANT:
// - NEVER cache employee active status, QR tokens, attendance records,
//   user account lock/revocation state, or passwords.
// - Cache ONLY low-churn role/config metadata with short TTLs + explicit
//   write-path invalidation.
// ============================================================================

interface CachedDocSnapshotLike {
  exists: boolean;
  data: Record<string, any> | undefined;
  expiresAt: number;
}

interface CachedListEntry<T> {
  value: T;
  expiresAt: number;
}

interface DbCacheStore {
  shifts?: CachedListEntry<any[]>;
  shiftsInFlight?: Promise<any[]>;
  systemSettings?: CachedDocSnapshotLike;
  systemSettingsInFlight?: Promise<Record<string, any>>;
  roleDefs: Map<string, CachedDocSnapshotLike>;
  rolePerms: Map<string, CachedDocSnapshotLike>;
  inFlightRequests: Map<string, Promise<any>>;
  recentIdempotentResponses: Map<string, { value: any; expiresAt: number }>;
}

const dbCacheWeakMap = new WeakMap<object, DbCacheStore>();

function getStore(db: AdminFirestoreLike): DbCacheStore {
  let store = dbCacheWeakMap.get(db as object);
  if (!store) {
    store = {
      roleDefs: new Map(),
      rolePerms: new Map(),
      inFlightRequests: new Map(),
      recentIdempotentResponses: new Map(),
    };
    dbCacheWeakMap.set(db as object, store);
  }
  return store;
}

const CONFIG_TTL_MS = 30_000;
const ROLE_TTL_MS = 15_000;

export async function getCachedShifts(
  db: AdminFirestoreLike,
  defaultShifts: any[]
): Promise<{ shifts: any[]; cacheHit: boolean }> {
  const store = getStore(db);
  const now = Date.now();
  if (store.shifts && store.shifts.expiresAt > now) {
    return { shifts: store.shifts.value, cacheHit: true };
  }
  if (!store.shiftsInFlight) {
    store.shiftsInFlight = db
      .collection('shifts')
      .get()
      .then((snap) => {
        const list = snap.empty ? defaultShifts : snap.docs.map((d) => d.data()!);
        store.shifts = { value: list, expiresAt: Date.now() + CONFIG_TTL_MS };
        return list;
      })
      .finally(() => {
        store.shiftsInFlight = undefined;
      });
  }
  const shifts = await store.shiftsInFlight;
  return { shifts, cacheHit: false };
}

export async function getCachedSystemSettings(
  db: AdminFirestoreLike,
  defaultSettings: Record<string, any> = {}
): Promise<{ exists: boolean; data: Record<string, any>; cacheHit: boolean }> {
  const store = getStore(db);
  const now = Date.now();
  if (store.systemSettings && store.systemSettings.expiresAt > now) {
    return {
      exists: store.systemSettings.exists,
      data: store.systemSettings.data || defaultSettings,
      cacheHit: true,
    };
  }
  if (!store.systemSettingsInFlight) {
    store.systemSettingsInFlight = db
      .collection('system_settings')
      .doc('global')
      .get()
      .then((snap) => {
        const exists = snap.exists;
        const data = exists ? snap.data() || defaultSettings : defaultSettings;
        store.systemSettings = {
          exists,
          data,
          expiresAt: Date.now() + CONFIG_TTL_MS,
        };
        return data;
      })
      .finally(() => {
        store.systemSettingsInFlight = undefined;
      });
  }
  const data = await store.systemSettingsInFlight;
  return {
    exists: store.systemSettings?.exists ?? true,
    data,
    cacheHit: false,
  };
}

export async function getCachedRoleDefDoc(
  db: AdminFirestoreLike,
  roleId: string
): Promise<{ exists: boolean; data: Record<string, any> | undefined; cacheHit: boolean }> {
  const cleanRole = String(roleId || '').trim().toLowerCase();
  if (!cleanRole) return { exists: false, data: undefined, cacheHit: false };

  const store = getStore(db);
  const now = Date.now();
  const cached = store.roleDefs.get(cleanRole);
  if (cached && cached.expiresAt > now) {
    return { exists: cached.exists, data: cached.data, cacheHit: true };
  }

  const snap = await db.collection('roles').doc(cleanRole).get();
  const entry: CachedDocSnapshotLike = {
    exists: snap.exists,
    data: snap.exists ? snap.data() || {} : undefined,
    expiresAt: Date.now() + ROLE_TTL_MS,
  };
  store.roleDefs.set(cleanRole, entry);
  return { exists: entry.exists, data: entry.data, cacheHit: false };
}

export async function getCachedRolePermissionsDoc(
  db: AdminFirestoreLike,
  roleId: string
): Promise<{ exists: boolean; data: Record<string, any> | undefined; cacheHit: boolean }> {
  const cleanRole = String(roleId || '').trim().toLowerCase();
  if (!cleanRole) return { exists: false, data: undefined, cacheHit: false };

  const store = getStore(db);
  const now = Date.now();
  const cached = store.rolePerms.get(cleanRole);
  if (cached && cached.expiresAt > now) {
    return { exists: cached.exists, data: cached.data, cacheHit: true };
  }

  const snap = await db.collection('role_permissions').doc(cleanRole).get();
  const entry: CachedDocSnapshotLike = {
    exists: snap.exists,
    data: snap.exists ? snap.data() || {} : undefined,
    expiresAt: Date.now() + ROLE_TTL_MS,
  };
  store.rolePerms.set(cleanRole, entry);
  return { exists: entry.exists, data: entry.data, cacheHit: false };
}

export function invalidateRoleCaches(db: AdminFirestoreLike, roleId?: string): void {
  const store = getStore(db);
  if (roleId) {
    const clean = String(roleId).trim().toLowerCase();
    store.roleDefs.delete(clean);
    store.rolePerms.delete(clean);
  } else {
    store.roleDefs.clear();
    store.rolePerms.clear();
  }
}

export function invalidateConfigCaches(db: AdminFirestoreLike): void {
  const store = getStore(db);
  store.shifts = undefined;
  store.systemSettings = undefined;
}

/**
 * Deduplicates accidental double-submits sharing the exact same clientRequestId
 * while in-flight (and within a 1.5s replay guard), without interfering with
 * distinct requests or server-side 409/429 duplicate/bounce enforcement.
 */
export async function runWithOptionalClientRequestDedup<T>(
  db: AdminFirestoreLike,
  dedupKey: string | null | undefined,
  task: () => Promise<T>
): Promise<T> {
  if (!dedupKey) {
    return task();
  }
  const store = getStore(db);
  const now = Date.now();
  const recent = store.recentIdempotentResponses.get(dedupKey);
  if (recent && recent.expiresAt > now) {
    return recent.value as T;
  }
  const existing = store.inFlightRequests.get(dedupKey);
  if (existing) {
    return (await existing) as T;
  }

  const promise = task()
    .then((result) => {
      if (store.recentIdempotentResponses.size > 200) {
        const cutoff = Date.now();
        for (const [k, v] of store.recentIdempotentResponses.entries()) {
          if (v.expiresAt <= cutoff) store.recentIdempotentResponses.delete(k);
        }
      }
      store.recentIdempotentResponses.set(dedupKey, {
        value: result,
        expiresAt: Date.now() + 1500,
      });
      return result;
    })
    .finally(() => {
      store.inFlightRequests.delete(dedupKey);
    });

  store.inFlightRequests.set(dedupKey, promise);
  return promise;
}

// ============================================================================
// Non-Sensitive Pipeline Performance Instrumentation
// ============================================================================
export interface AttendancePerfMetrics {
  authMs: number;
  permissionMs: number;
  lookupAndQueryMs: number;
  txMs: number;
  auditMs?: number;
  totalServerMs: number;
  cacheHitRolePerms?: boolean;
  cacheHitConfig?: boolean;
}

export function roundMs(val: number): number {
  return Math.round(val * 10) / 10;
}

export function emitNonSensitivePerfLog(
  operation: string,
  metrics: Record<string, number | boolean | string>
): void {
  if (process.env.VITEST) return;
  if (process.env.PERF_LOG === '1' || Number(metrics.totalServerMs || 0) > 1000) {
    // Only non-sensitive numeric timings and operation name — zero tokens, secrets, or PII.
    console.info(`[PERF] ${operation}`, JSON.stringify(metrics));
  }
}
