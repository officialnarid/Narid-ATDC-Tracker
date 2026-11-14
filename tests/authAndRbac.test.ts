import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('Authentication, Token Revocation & Strict UID-Only RBAC', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);
    app = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    }).app;
  });

  it('rejects unauthenticated requests across all protected endpoints with 401', async () => {
    const endpoints: Array<{ method: 'get' | 'post'; path: string; body?: any }> = [
      { method: 'post', path: '/api/auth/verify-session', body: { loginId: 'admin' } },
      { method: 'get', path: '/api/audit/logs' },
      { method: 'get', path: '/api/security/overview' },
      { method: 'get', path: '/api/admin/full-auth-audit' },
      { method: 'get', path: '/api/dashboard/summary' },
      { method: 'post', path: '/api/attendance/scan', body: { rawPayload: 'EMP001', scannerType: 'IN' } },
      { method: 'post', path: '/api/attendance/auto-close', body: {} },
    ];

    for (const ep of endpoints) {
      const res =
        ep.method === 'get'
          ? await request(app).get(ep.path)
          : await request(app).post(ep.path).send(ep.body);
      expect(res.status, `Expected 401 on ${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
      expect(res.body.success).toBe(false);
    }
  });

  it('rejects revoked Firebase ID tokens (checkRevoked = true) and sessionRevokedAt invalidations', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    const beforeRes = await request(app)
      .post('/api/auth/verify-session')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ loginId: 'admin' });
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.body.success).toBe(true);

    // Revoke refresh tokens in Firebase Auth
    await auth.revokeRefreshTokens(TEST_CANONICAL_ACCOUNTS.admin.uid);

    const afterRevokeRes = await request(app)
      .post('/api/auth/verify-session')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ loginId: 'admin' });
    expect(afterRevokeRes.status).toBe(401);
    expect(String(afterRevokeRes.body.error || '').toLowerCase()).toContain('revoked');

    // Also test sessionRevokedAt check on newly issued token minted prior to revocation timestamp
    const userAuthTimeSec = Math.floor(Date.now() / 1000) - 60;
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid, { authTimeSec: userAuthTimeSec });
    await db.collection('user_roles').doc('role_user').update({
      sessionRevokedAt: new Date().toISOString(),
    });

    const userRevokedRes = await request(app)
      .post('/api/auth/verify-session')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ loginId: 'user' });
    expect(userRevokedRes.status).toBe(401);
    expect(userRevokedRes.body.success).toBe(false);
  });

  it('enforces strictly UID-based RBAC with zero email privilege bypasses', async () => {
    // An unlinked user forging an @narid.com or officialnarid@gmail.com email claim MUST NOT get access
    const rogueUid1 = 'rogue_uid_email_spoof_1';
    const rogueUid2 = 'rogue_uid_email_spoof_2';
    auth.seedUser({ uid: rogueUid1, email: 'superadmin@narid.com', password: 'RoguePassword#1' });
    auth.seedUser({ uid: rogueUid2, email: 'officialnarid@gmail.com', password: 'RoguePassword#2' });

    const rogueToken1 = auth.issueToken(rogueUid1, { email: 'superadmin@narid.com' });
    const rogueToken2 = auth.issueToken(rogueUid2, { email: 'officialnarid@gmail.com' });

    const r1 = await request(app)
      .get('/api/audit/logs')
      .set('Authorization', `Bearer ${rogueToken1}`);
    expect(r1.status).toBe(401);

    const r2 = await request(app)
      .get('/api/security/overview')
      .set('Authorization', `Bearer ${rogueToken2}`);
    expect(r2.status).toBe(401);
  });

  it('prevents ADMIN and USER from calling SUPER_ADMIN privileged endpoints', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    const adminAudit = await request(app)
      .get('/api/audit/logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminAudit.status).toBe(403);

    const adminCreateUser = await request(app)
      .post('/api/admin/create-user')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        loginId: 'temp_op',
        name: 'Temp Op',
        email: 'temp_op@narid.com',
        role: 'user',
        password: 'StrongPassword#123',
      });
    expect(adminCreateUser.status).toBe(403);

    const userSetPass = await request(app)
      .post('/api/admin/set-user-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        targetLoginId: 'admin',
        newPassword: 'HackedPassword#99',
      });
    expect(userSetPass.status).toBe(403);

    const userSecurity = await request(app)
      .get('/api/security/overview')
      .set('Authorization', `Bearer ${userToken}`);
    expect(userSecurity.status).toBe(403);
  });

  it('requires explicit password on create-user, writes user_uid_index, and preserves canonical UIDs on password reset', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);

    // Creating user without explicit password must fail 400
    const missingPassRes = await request(app)
      .post('/api/admin/create-user')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        loginId: 'supervisor2',
        name: 'Supervisor Two',
        email: 'supervisor2@narid.com',
        role: 'admin',
      });
    expect(missingPassRes.status).toBe(400);

    // Creating user with explicit password succeeds and syncs user_uid_index
    const createRes = await request(app)
      .post('/api/admin/create-user')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        loginId: 'supervisor2',
        name: 'Supervisor Two',
        email: 'supervisor2@narid.com',
        role: 'admin',
        password: 'UniqueInitPass#2026',
        modulesAllowed: ['dashboard', 'scanner'],
      });
    expect(createRes.status).toBe(200);
    expect(createRes.body.success).toBe(true);
    const createdUid = createRes.body.profile.authUid;
    expect(createdUid).toBeTruthy();

    const idxSnap = await db.collection('user_uid_index').doc(createdUid).get();
    expect(idxSnap.exists).toBe(true);
    expect(idxSnap.data()?.role).toBe('admin');

    // Resetting canonical admin password preserves exact UID and updates password in-place
    const resetRes = await request(app)
      .post('/api/admin/set-user-password')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        targetLoginId: 'admin',
        newPassword: 'RotatedAdminPass#2026',
        mustChangePassword: false,
        unlockAccount: true,
        revokeSessions: true,
      });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);
    expect(resetRes.body.firebaseUid).toBe(TEST_CANONICAL_ACCOUNTS.admin.uid);
    expect(auth.getUserPasswordUnsafe(TEST_CANONICAL_ACCOUNTS.admin.uid)).toBe('RotatedAdminPass#2026');
  });

  it('preserves existing loginId + password scrypt login contract, canonical UIDs, and performs zero unapproved user_roles migrations', async () => {
    // 1. Valid Super Admin & User login with existing scrypt password hashes
    for (const acc of [TEST_CANONICAL_ACCOUNTS.superadmin, TEST_CANONICAL_ACCOUNTS.user]) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.25')
        .send({ loginId: acc.loginId, password: acc.password });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.profile.authUid).toBe(acc.uid);
      expect(res.body.profile.role).toBe(acc.role);
      expect(res.body.profile.passwordHash).toBeUndefined();
    }

    // 2. Invalid password fails cleanly with 401 without modifying canonical UID
    const failRes = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.26')
      .send({ loginId: 'superadmin', password: 'WrongSuperPassword#999' });

    expect(failRes.status).toBe(401);
    expect(failRes.body.success).toBe(false);
    expect(failRes.body.code).toBe('INVALID_PASSWORD');

    const superDocAfter = await db.collection('user_roles').doc('role_superadmin').get();
    expect(superDocAfter.data()?.authUid).toBe(TEST_CANONICAL_ACCOUNTS.superadmin.uid);

    // 3. Legacy user role without dashboardAccessMigratedV1 gets read-only dashboard access without mutating user_roles
    await db.collection('user_roles').doc('role_user').update({
      modulesAllowed: ['scanner'],
    });
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
    const verifyRes = await request(app)
      .post('/api/auth/verify-session')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ loginId: 'user' });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.modulesAllowed).toContain('dashboard');
    expect(verifyRes.body.modulesAllowed).toContain('scanner');

    const userDocAfter = await db.collection('user_roles').doc('role_user').get();
    expect(userDocAfter.data()?.dashboardAccessMigratedV1).toBeUndefined();
    expect(userDocAfter.data()?.modulesAllowed).toEqual(['scanner']);
  });
});
