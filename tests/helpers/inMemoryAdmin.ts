import {
  AdminAuthLike,
  AdminCollectionRefLike,
  AdminDecodedTokenLike,
  AdminDocRefLike,
  AdminDocSnapLike,
  AdminFirestoreLike,
  AdminQueryLike,
  AdminQuerySnapLike,
  AdminTransactionLike,
  AdminUserRecordLike,
  AdminWriteBatchLike,
} from '../../serverSecurityAudit.ts';
import { hashPassword } from '../../server.ts';

function cloneData<T>(obj: T): T {
  if (obj === undefined || obj === null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function getNestedValue(obj: Record<string, any>, fieldPath: string): any {
  const parts = fieldPath.split('.');
  let cur: any = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setNestedValue(obj: Record<string, any>, fieldPath: string, value: any): void {
  const parts = fieldPath.split('.');
  let cur: Record<string, any> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = cloneData(target);
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && result[k] && typeof result[k] === 'object' && !Array.isArray(result[k])) {
      result[k] = deepMerge(result[k], v);
    } else {
      result[k] = cloneData(v);
    }
  }
  return result;
}

type WhereClause = { field: string; op: string; value: any };
type OrderClause = { field: string; dir: 'asc' | 'desc' };

export class InMemoryFirestore implements AdminFirestoreLike {
  private store = new Map<string, Map<string, Record<string, any>>>();
  private txQueue: Promise<any> = Promise.resolve();

  private getColMap(path: string): Map<string, Record<string, any>> {
    let col = this.store.get(path);
    if (!col) {
      col = new Map();
      this.store.set(path, col);
    }
    return col;
  }

  public getRawCollection(path: string): Record<string, Record<string, any>> {
    const out: Record<string, Record<string, any>> = {};
    for (const [id, data] of this.getColMap(path).entries()) {
      out[id] = cloneData(data);
    }
    return out;
  }

  private buildQuery(
    path: string,
    wheres: WhereClause[] = [],
    orders: OrderClause[] = [],
    limitCount?: number
  ): AdminQueryLike {
    const execute = async (): Promise<AdminQuerySnapLike> => {
      const col = this.getColMap(path);
      let entries = Array.from(col.entries()).map(([id, data]) => ({
        id,
        data: cloneData(data),
      }));

      for (const w of wheres) {
        entries = entries.filter((entry) => {
          const val = getNestedValue(entry.data, w.field);
          switch (w.op) {
            case '==':
              return val === w.value;
            case '!=':
              return val !== w.value;
            case '>=':
              return val !== undefined && val >= w.value;
            case '<=':
              return val !== undefined && val <= w.value;
            case '>':
              return val !== undefined && val > w.value;
            case '<':
              return val !== undefined && val < w.value;
            case 'in':
              return Array.isArray(w.value) && w.value.includes(val);
            case 'array-contains':
              return Array.isArray(val) && val.includes(w.value);
            default:
              return false;
          }
        });
      }

      if (orders.length > 0) {
        entries.sort((a, b) => {
          for (const ord of orders) {
            const av = getNestedValue(a.data, ord.field);
            const bv = getNestedValue(b.data, ord.field);
            if (av === bv) continue;
            if (av === undefined) return 1;
            if (bv === undefined) return -1;
            const cmp = av < bv ? -1 : 1;
            return ord.dir === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
      }

      if (typeof limitCount === 'number' && limitCount >= 0) {
        entries = entries.slice(0, limitCount);
      }

      const docs: AdminDocSnapLike[] = entries.map((e) => ({
        id: e.id,
        exists: true,
        data: () => cloneData(e.data),
      }));

      return {
        empty: docs.length === 0,
        size: docs.length,
        docs,
      };
    };

    return {
      where: (field: string, opStr: string, value: any) =>
        this.buildQuery(path, [...wheres, { field, op: opStr, value }], orders, limitCount),
      orderBy: (field: string, dir: 'asc' | 'desc' = 'asc') =>
        this.buildQuery(path, wheres, [...orders, { field, dir }], limitCount),
      limit: (n: number) => this.buildQuery(path, wheres, orders, n),
      get: execute,
    };
  }

  public collection(path: string): AdminCollectionRefLike {
    const baseQuery = this.buildQuery(path);
    return {
      ...baseQuery,
      doc: (id: string): AdminDocRefLike => ({
        id,
        get: async (): Promise<AdminDocSnapLike> => {
          const col = this.getColMap(path);
          const raw = col.get(id);
          return {
            id,
            exists: raw !== undefined,
            data: () => (raw !== undefined ? cloneData(raw) : undefined),
          };
        },
        set: async (data: Record<string, any>, options?: { merge?: boolean }) => {
          const col = this.getColMap(path);
          if (options?.merge && col.has(id)) {
            col.set(id, deepMerge(col.get(id)!, data));
          } else {
            col.set(id, cloneData(data));
          }
        },
        update: async (data: Record<string, any>) => {
          const col = this.getColMap(path);
          if (!col.has(id)) {
            throw new Error(`NOT_FOUND: No document to update at ${path}/${id}`);
          }
          const current = cloneData(col.get(id)!);
          for (const [k, v] of Object.entries(data)) {
            if (k.includes('.')) {
              setNestedValue(current, k, cloneData(v));
            } else {
              current[k] = cloneData(v);
            }
          }
          col.set(id, current);
        },
        delete: async () => {
          const col = this.getColMap(path);
          col.delete(id);
        },
      }),
      _path: path,
    } as AdminCollectionRefLike & { _path: string };
  }

  public async runTransaction<T>(updateFunction: (transaction: AdminTransactionLike) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      // Snapshot-isolated serialized transaction with buffered writes
      const pendingOps: Array<() => Promise<void>> = [];
      const tx: AdminTransactionLike = {
        get: (ref: AdminDocRefLike) => ref.get(),
        set: (ref: AdminDocRefLike, data: Record<string, any>, options?: { merge?: boolean }) => {
          pendingOps.push(() => ref.set(data, options));
        },
        update: (ref: AdminDocRefLike, data: Record<string, any>) => {
          pendingOps.push(() => ref.update(data));
        },
        delete: (ref: AdminDocRefLike) => {
          pendingOps.push(() => ref.delete());
        },
      };
      const result = await updateFunction(tx);
      for (const op of pendingOps) {
        await op();
      }
      return result;
    };

    const next = this.txQueue.then(run, run);
    this.txQueue = next.catch(() => undefined);
    return next;
  }

  public batch(): AdminWriteBatchLike {
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: AdminDocRefLike, data: Record<string, any>, options?: { merge?: boolean }) => {
        ops.push(() => ref.set(data, options));
      },
      update: (ref: AdminDocRefLike, data: Record<string, any>) => {
        ops.push(() => ref.update(data));
      },
      delete: (ref: AdminDocRefLike) => {
        ops.push(() => ref.delete());
      },
      commit: async () => {
        for (const op of ops) {
          await op();
        }
      },
    };
  }
}

interface StoredAuthUser extends AdminUserRecordLike {
  password: string;
  tokensValidAfterTimeSec: number;
}

export class InMemoryAdminAuth implements AdminAuthLike {
  private users = new Map<string, StoredAuthUser>();
  private tokens = new Map<string, { uid: string; email?: string; auth_time: number }>();

  public seedUser(props: { uid: string; email: string; password: string; disabled?: boolean }) {
    this.users.set(props.uid, {
      uid: props.uid,
      email: props.email.toLowerCase(),
      password: props.password,
      disabled: Boolean(props.disabled),
      tokensValidAfterTimeSec: 0,
      metadata: {
        creationTime: '2025-01-01T00:00:00.000Z',
        lastSignInTime: new Date().toISOString(),
      },
    });
  }

  public issueToken(uid: string, overrides?: { email?: string; authTimeSec?: number }): string {
    const u = this.users.get(uid);
    const authTime = overrides?.authTimeSec ?? Math.floor(Date.now() / 1000);
    const token = `mock-firebase-id-token-${uid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    this.tokens.set(token, {
      uid,
      email: overrides?.email ?? u?.email,
      auth_time: authTime,
    });
    return token;
  }

  public getUserPasswordUnsafe(uid: string): string | undefined {
    return this.users.get(uid)?.password;
  }

  public async verifyIdToken(token: string, checkRevoked?: boolean): Promise<AdminDecodedTokenLike> {
    const entry = this.tokens.get(token);
    if (!entry) {
      throw new Error('Firebase ID token has invalid signature or unknown payload.');
    }
    const u = this.users.get(entry.uid);
    if (!u) {
      throw new Error('Firebase Auth user record no longer exists.');
    }
    if (u.disabled) {
      throw new Error('Firebase Auth user account is disabled.');
    }
    if (checkRevoked && entry.auth_time < u.tokensValidAfterTimeSec) {
      const err: any = new Error('The Firebase ID token has been revoked.');
      err.code = 'auth/id-token-revoked';
      throw err;
    }
    return {
      uid: entry.uid,
      email: entry.email,
      auth_time: entry.auth_time,
    };
  }

  public async getUser(uid: string): Promise<AdminUserRecordLike> {
    const u = this.users.get(uid);
    if (!u) throw new Error(`auth/user-not-found: ${uid}`);
    return { uid: u.uid, email: u.email, disabled: u.disabled, metadata: u.metadata };
  }

  public async getUserByEmail(email: string): Promise<AdminUserRecordLike> {
    const lower = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email?.toLowerCase() === lower) {
        return { uid: u.uid, email: u.email, disabled: u.disabled, metadata: u.metadata };
      }
    }
    throw new Error(`auth/user-not-found: ${email}`);
  }

  public async createUser(properties: {
    email: string;
    password: string;
    displayName?: string;
    disabled?: boolean;
  }): Promise<AdminUserRecordLike> {
    const lower = properties.email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email?.toLowerCase() === lower) {
        throw new Error('The email address is already in use by another account.');
      }
    }
    const uid = `uid_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    this.seedUser({
      uid,
      email: lower,
      password: properties.password,
      disabled: properties.disabled,
    });
    return { uid, email: lower, disabled: Boolean(properties.disabled) };
  }

  public async updateUser(
    uid: string,
    properties: { password?: string; disabled?: boolean; displayName?: string }
  ): Promise<AdminUserRecordLike> {
    const u = this.users.get(uid);
    if (!u) throw new Error(`auth/user-not-found: ${uid}`);
    if (properties.password !== undefined) u.password = properties.password;
    if (properties.disabled !== undefined) u.disabled = properties.disabled;
    return { uid: u.uid, email: u.email, disabled: u.disabled, metadata: u.metadata };
  }

  public async deleteUser(uid: string): Promise<void> {
    this.users.delete(uid);
  }

  public async revokeRefreshTokens(uid: string): Promise<void> {
    const u = this.users.get(uid);
    if (u) {
      // Advance valid-after timestamp strictly past current second so previously issued tokens fail
      u.tokensValidAfterTimeSec = Math.floor(Date.now() / 1000) + 1;
    }
  }

  public async listUsers(_maxResults?: number): Promise<{ users: AdminUserRecordLike[] }> {
    return {
      users: Array.from(this.users.values()).map((u) => ({
        uid: u.uid,
        email: u.email,
        disabled: u.disabled,
        metadata: u.metadata,
      })),
    };
  }
}

export const TEST_CANONICAL_ACCOUNTS = {
  superadmin: {
    uid: 'oX2vdSx5jGcoUDxyA0SIYN3SEig2',
    docId: 'role_superadmin',
    loginId: 'superadmin',
    email: 'superadmin@narid.com',
    password: 'TestSuperSecret#2026',
    role: 'super_admin' as const,
  },
  admin: {
    uid: '2RpEv6mvyXYswYH9KPIGV6evtgY2',
    docId: 'role_admin',
    loginId: 'admin',
    email: 'admin@narid.com',
    password: 'TestAdminSecret#2026',
    role: 'admin' as const,
  },
  user: {
    uid: 'vXPvgrp3i6cS2frqDa3ZoU9h9gc2',
    docId: 'role_user',
    loginId: 'user',
    email: 'user@narid.com',
    password: 'TestOperatorSecret#2026',
    role: 'user' as const,
  },
};

export async function seedIsolatedTestEnvironment(db: InMemoryFirestore, auth: InMemoryAdminAuth) {
  const now = new Date().toISOString();

  for (const acc of Object.values(TEST_CANONICAL_ACCOUNTS)) {
    auth.seedUser({ uid: acc.uid, email: acc.email, password: acc.password });

    const modulesAllowed =
      acc.role === 'super_admin'
        ? ['all']
        : acc.role === 'admin'
        ? ['dashboard', 'scanner', 'employees', 'history', 'reports']
        : ['dashboard', 'scanner'];

    await db.collection('user_roles').doc(acc.docId).set({
      id: acc.docId,
      loginId: acc.loginId,
      name: acc.loginId.toUpperCase(),
      email: acc.email,
      authUid: acc.uid,
      linkedAuthUids: [acc.uid],
      role: acc.role,
      status: 'Active',
      lockStatus: 'ACTIVE',
      isLocked: false,
      failedLoginAttempts: 0,
      modulesAllowed,
      passwordHash: hashPassword(acc.password),
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now,
    });

    await db.collection('user_uid_index').doc(acc.uid).set({
      uid: acc.uid,
      roleDocId: acc.docId,
      role: acc.role,
      status: 'Active',
      lockStatus: 'ACTIVE',
      loginId: acc.loginId,
      updatedAt: now,
    });

    await db.collection('account_security').doc(`sec_${acc.loginId}`).set({
      id: `sec_${acc.loginId}`,
      loginId: acc.loginId,
      uid: acc.uid,
      role: acc.role.toUpperCase(),
      consecutiveFailedAttempts: 0,
      maxAttemptsAllowed: 3,
      lockStatus: 'ACTIVE',
      isLocked: false,
      lockReason: null,
      lockedAt: null,
      updatedAt: now,
    });
  }

  // Seed default shifts and global settings
  await db.collection('system_settings').doc('global').set({
    id: 'global',
    autoPunchOutEnabled: true,
    lateGraceMinutes: 15,
    scheduledDurationMinutes: 510,
    overtimeThresholdMinutes: 510,
  });

  await db.collection('shifts').doc('DAY').set({
    id: 'DAY',
    name: 'DAY SHIFT',
    startTime: '09:00',
    endTime: '17:30',
    scheduledDurationMinutes: 510,
    punchInWindowStart: '06:00',
    punchInWindowEnd: '18:00',
    isOvernight: false,
    gracePeriodMinutes: 15,
    status: 'Active',
  });

  await db.collection('shifts').doc('NIGHT').set({
    id: 'NIGHT',
    name: 'NIGHT SHIFT',
    startTime: '20:00',
    endTime: '04:30',
    scheduledDurationMinutes: 510,
    punchInWindowStart: '18:00',
    punchInWindowEnd: '06:00',
    isOvernight: true,
    gracePeriodMinutes: 15,
    status: 'Active',
  });

  // Seed sample employees for isolated attendance tests
  await db.collection('employees').doc('EMP001').set({
    id: 'EMP001',
    employeeId: 'EMP001',
    employeeName: 'Ramesh Kumar',
    employeeType: 'Operator',
    floor: 'Line 1',
    section: 'Cutting',
    department: 'Production',
    employeeStatus: 'Active',
    qrCodeToken: 'QR_EMP001_VALID',
  });

  await db.collection('employees').doc('EMP002').set({
    id: 'EMP002',
    employeeId: 'EMP002',
    employeeName: 'Suresh Inactive',
    employeeType: 'Helper',
    floor: 'Line 2',
    section: 'Packing',
    department: 'Finishing',
    employeeStatus: 'Inactive',
    qrCodeToken: 'QR_EMP002_INACTIVE',
  });
}
