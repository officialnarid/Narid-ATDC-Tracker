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

  it('completes Admin first-time password change authoritatively without auth/requires-recent-login while enforcing currentPassword, UID preservation, and role RBAC', async () => {
    // Flag canonical admin account for mandatory first-time password change
    await db.collection('user_roles').doc('role_admin').update({
      mustChangePassword: true,
      forcePasswordChange: true,
    });
    await db.collection('account_security').doc('sec_admin').set(
      {
        id: 'sec_admin',
        loginId: 'admin',
        role: 'ADMIN',
        firebaseUid: TEST_CANONICAL_ACCOUNTS.admin.uid,
        forcePasswordChange: true,
      },
      { merge: true }
    );

    // 1. Missing password rejected 400
    const missingPassLogin = await request(app)
      .post('/api/auth/login')
      .send({ loginId: 'admin' });
    expect(missingPassLogin.status).toBe(400);
    expect(missingPassLogin.body.error).toBe('Please enter your password.');

    // 2. Admin signs in with existing initial password -> mustChangePassword=true
    const initialLogin = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.31')
      .send({ loginId: 'admin', password: TEST_CANONICAL_ACCOUNTS.admin.password });
    expect(initialLogin.status).toBe(200);
    expect(initialLogin.body.success).toBe(true);
    expect(initialLogin.body.profile.authUid).toBe(TEST_CANONICAL_ACCOUNTS.admin.uid);
    expect(initialLogin.body.profile.mustChangePassword).toBe(true);

    // Simulate a Firebase ID token whose auth_time is 2 hours old (would have failed client updatePassword with auth/requires-recent-login)
    const staleAuthTimeSec = Math.floor(Date.now() / 1000) - 7200;
    const staleAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid, {
      authTimeSec: staleAuthTimeSec,
    });

    // 3. Reject missing currentPassword (400)
    const noCurrentRes = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${staleAdminToken}`)
      .send({ loginId: 'admin', newPassword: 'BrandNewAdminPass#2026' });
    expect(noCurrentRes.status).toBe(400);
    expect(noCurrentRes.body.code).toBe('CURRENT_PASSWORD_REQUIRED');

    // 4. Reject wrong currentPassword (401)
    const wrongCurrentRes = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${staleAdminToken}`)
      .send({
        loginId: 'admin',
        currentPassword: 'WrongCurrentPass#999',
        newPassword: 'BrandNewAdminPass#2026',
      });
    expect(wrongCurrentRes.status).toBe(401);
    expect(wrongCurrentRes.body.code).toBe('INVALID_CURRENT_PASSWORD');

    // 5. Reject reusing the exact same password (400)
    const reuseRes = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${staleAdminToken}`)
      .send({
        loginId: 'admin',
        currentPassword: TEST_CANONICAL_ACCOUNTS.admin.password,
        newPassword: TEST_CANONICAL_ACCOUNTS.admin.password,
      });
    expect(reuseRes.status).toBe(400);
    expect(reuseRes.body.code).toBe('PASSWORD_REUSE_NOT_ALLOWED');

    // 6. Reject changing another user's password via spoofed loginId (403)
    const spoofTargetRes = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${staleAdminToken}`)
      .send({
        loginId: 'superadmin',
        currentPassword: TEST_CANONICAL_ACCOUNTS.admin.password,
        newPassword: 'HackedSuperPass#2026',
      });
    expect(spoofTargetRes.status).toBe(403);

    // 7. Valid Admin first-time password change with stale auth_time succeeds 200 (no auth/requires-recent-login)
    const changeRes = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${staleAdminToken}`)
      .send({
        loginId: 'admin',
        currentPassword: TEST_CANONICAL_ACCOUNTS.admin.password,
        newPassword: 'BrandNewAdminPass#2026',
      });
    expect(changeRes.status).toBe(200);
    expect(changeRes.body.success).toBe(true);
    expect(changeRes.body.mustChangePassword).toBe(false);
    expect(changeRes.body.forcePasswordChange).toBe(false);
    expect(changeRes.body.firebaseAuthSynced).toBe(true);
    expect(auth.getUserPasswordUnsafe(TEST_CANONICAL_ACCOUNTS.admin.uid)).toBe('BrandNewAdminPass#2026');

    const adminRoleAfter = await db.collection('user_roles').doc('role_admin').get();
    expect(adminRoleAfter.data()?.authUid).toBe(TEST_CANONICAL_ACCOUNTS.admin.uid);
    expect(adminRoleAfter.data()?.mustChangePassword).toBe(false);

    // 8. Old pre-change token is revoked after password update (401); fresh post-signin token is blocked 403 once mustChangePassword is false
    const revokedTokenRes = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${staleAdminToken}`)
      .send({
        loginId: 'admin',
        currentPassword: 'BrandNewAdminPass#2026',
        newPassword: 'AnotherPass#2026',
      });
    expect(revokedTokenRes.status).toBe(401);

    const freshAdminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid, {
      authTimeSec: Math.floor(Date.now() / 1000) + 2,
    });
    const secondChangeRes = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${freshAdminToken}`)
      .send({
        loginId: 'admin',
        currentPassword: 'BrandNewAdminPass#2026',
        newPassword: 'AnotherPass#2026',
      });
    expect(secondChangeRes.status).toBe(403);

    // 9. Admin login with OLD password fails (401), and NEW password succeeds (200) -> accesses dashboard (200), blocked from Super Admin routes (403)
    const oldPassRetry = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.32')
      .send({ loginId: 'admin', password: TEST_CANONICAL_ACCOUNTS.admin.password });
    expect(oldPassRetry.status).toBe(401);

    const newPassLogin = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.33')
      .send({ loginId: 'admin', password: 'BrandNewAdminPass#2026' });
    expect(newPassLogin.status).toBe(200);
    expect(newPassLogin.body.profile.mustChangePassword).toBe(false);
    expect(newPassLogin.body.profile.authUid).toBe(TEST_CANONICAL_ACCOUNTS.admin.uid);

    const adminDashRes = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${freshAdminToken}`);
    expect(adminDashRes.status).toBe(200);
    expect(adminDashRes.body.role).toBe('ADMIN');
    expect(adminDashRes.body.readOnly).toBe(false);

    const adminAuditDenied = await request(app)
      .get('/api/audit/logs')
      .set('Authorization', `Bearer ${freshAdminToken}`);
    expect(adminAuditDenied.status).toBe(403);
  });

  it('verifies Super Admin & Normal User dashboard access, restricted routes, and logout/session-expiration audit recording', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    // Super Admin dashboard + privileged routes succeed
    const superDash = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${superToken}`);
    expect(superDash.status).toBe(200);
    expect(superDash.body.role).toBe('SUPER_ADMIN');
    expect(superDash.body.readOnly).toBe(false);

    const superAudit = await request(app)
      .get('/api/audit/logs')
      .set('Authorization', `Bearer ${superToken}`);
    expect(superAudit.status).toBe(200);

    // Normal User dashboard succeeds read-only; admin/super_admin routes denied 403
    const userDash = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${userToken}`);
    expect(userDash.status).toBe(200);
    expect(userDash.body.role).toBe('USER');
    expect(userDash.body.readOnly).toBe(true);

    const userClearDenied = await request(app)
      .post('/api/attendance/clear')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ confirmed: true, confirmationText: 'CLEAR_ALL_ATTENDANCE', reason: 'Attempt' });
    expect(userClearDenied.status).toBe(403);

    // Logout & session_expired audit capture succeeds while token is valid, and fails 401 after revocation
    const logoutEvent = await request(app)
      .post('/api/audit/event')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ action: 'logout', category: 'AUTH', targetType: 'SESSION', success: true });
    expect(logoutEvent.status).toBe(200);

    await auth.revokeRefreshTokens(TEST_CANONICAL_ACCOUNTS.user.uid);
    const expiredChange = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: TEST_CANONICAL_ACCOUNTS.user.password, newPassword: 'NewUserPass#1' });
    expect(expiredChange.status).toBe(401);
  });
});
