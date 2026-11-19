import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp, hashPassword } from '../server.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';
import {
  formatCountdownSeconds,
  computeRemainingLockoutSeconds,
  deriveServerLockoutState,
} from '../src/components/Login.tsx';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe('Canonical Super Admin Progressive Temporary Lockout Policy', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let clockMs: number;
  let app: ReturnType<typeof createApp>['app'];

  const buildApp = () =>
    createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
      nowProvider: () => clockMs,
    }).app;

  const attemptLogin = (
    targetApp: ReturnType<typeof createApp>['app'],
    loginId: string,
    password: string,
    ip = '10.42.0.10'
  ) =>
    request(targetApp)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ loginId, password });

  const triggerThreeFailedAttempts = async (
    targetApp: ReturnType<typeof createApp>['app'],
    loginId: string,
    ip: string
  ) => {
    const r1 = await attemptLogin(targetApp, loginId, 'WrongPass#1', ip);
    const r2 = await attemptLogin(targetApp, loginId, 'WrongPass#2', ip);
    const r3 = await attemptLogin(targetApp, loginId, 'WrongPass#3', ip);
    return { r1, r2, r3 };
  };

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    clockMs = Date.now() + 60 * 1000;
    await seedIsolatedTestEnvironment(db, auth);
    app = buildApp();
  });

  it('enforces progressive durations (10m -> 20m -> 30m -> 60m -> 60m cap) exclusively for canonical Super Admin without leaking internal escalation level', async () => {
    const expectedDurations = [10, 20, 30, 60, 60];

    for (let i = 0; i < expectedDurations.length; i++) {
      const expectedMin = expectedDurations[i];
      const ip = `10.50.0.${i + 1}`;
      const { r1, r2, r3 } = await triggerThreeFailedAttempts(app, 'superadmin', ip);

      expect(r1.status).toBe(401);
      expect(r1.body.attemptNumber).toBe(1);
      expect(r2.status).toBe(401);
      expect(r2.body.attemptNumber).toBe(2);
      expect(r2.body.code).toBe('SECOND_FAILED_WARNING');

      expect(r3.status).toBe(423);
      expect(r3.body.code).toBe('ACCOUNT_LOCKED');
      expect(r3.body.locked).toBe(true);
      expect(r3.body.temporaryLock).toBe(true);
      expect(r3.body.lockDurationMinutes).toBe(expectedMin);
      expect(r3.body.remainingSeconds).toBe(expectedMin * 60);
      expect(r3.body.serverNowMs).toBe(clockMs);
      expect(r3.body.lockedUntilMs).toBe(clockMs + expectedMin * MINUTE_MS);

      // Must NOT leak sensitive internal escalation count or credentials on unauthenticated 423
      expect(r3.body.progressiveLockLevel).toBeUndefined();
      expect(r3.body.totalLockoutEvents).toBeUndefined();
      expect(r3.body.passwordHash).toBeUndefined();

      // Advance time past this lockout duration so the next lockout event can occur
      clockMs += expectedMin * MINUTE_MS + 1000;
    }

    // Verify stored progressive level and history in Firestore
    const secDoc = (await db.collection('account_security').doc('sec_superadmin').get()).data();
    expect(secDoc?.progressiveLockLevel).toBe(5);
    expect(secDoc?.totalLockoutEvents).toBe(5);
    expect(secDoc?.lockPolicyType).toBe('PROGRESSIVE_TEMPORARY');
  });

  it('rejects even the correct password during active lockout and invalidates active Super Admin sessions', async () => {
    const preLockToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid, {
      authTimeSec: Math.floor(Date.now() / 1000),
    });

    // Sanity check: active Super Admin session works before lockout
    const beforeOverview = await request(app)
      .get('/api/security/overview')
      .set('Authorization', `Bearer ${preLockToken}`);
    expect(beforeOverview.status).toBe(200);

    // Trigger 1st lockout (10 minutes)
    const { r3 } = await triggerThreeFailedAttempts(app, 'superadmin', '10.60.0.1');
    expect(r3.status).toBe(423);
    expect(r3.body.lockDurationMinutes).toBe(10);

    // 1. Advance 3 minutes (still 7 minutes remaining) and try the CORRECT password
    clockMs += 3 * MINUTE_MS;
    const correctDuringLock = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.60.0.2'
    );
    expect(correctDuringLock.status).toBe(423);
    expect(correctDuringLock.body.locked).toBe(true);
    expect(correctDuringLock.body.temporaryLock).toBe(true);
    expect(correctDuringLock.body.remainingSeconds).toBe(7 * 60);
    expect(correctDuringLock.body.progressiveLockLevel).toBeUndefined();

    // 2. Pre-lockout token must be rejected because refresh tokens & sessionRevokedAt were revoked
    const preLockCall = await request(app)
      .get('/api/security/overview')
      .set('Authorization', `Bearer ${preLockToken}`);
    expect([401, 403]).toContain(preLockCall.status);

    // 3. Even a freshly minted token while account is actively locked must be rejected with 403
    const freshDuringLockToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid, {
      authTimeSec: Math.floor(clockMs / 1000),
    });
    const freshCall = await request(app)
      .get('/api/security/overview')
      .set('Authorization', `Bearer ${freshDuringLockToken}`);
    expect(freshCall.status).toBe(403);
    expect(String(freshCall.body.error || '')).toContain('temporarily locked');

    // 4. Verify user_uid_index carries LOCKED + lockedUntilMs
    const uidIndex = (
      await db.collection('user_uid_index').doc(TEST_CANONICAL_ACCOUNTS.superadmin.uid).get()
    ).data();
    expect(uidIndex?.lockStatus).toBe('LOCKED');
    expect(typeof uidIndex?.lockedUntilMs).toBe('number');

    // 5. After lockout expires, pre-login token must still require clean re-authentication (401)
    clockMs += 8 * MINUTE_MS;
    const expiredSessionCall = await request(app)
      .get('/api/security/overview')
      .set('Authorization', `Bearer ${freshDuringLockToken}`);
    expect(expiredSessionCall.status).toBe(401);
    expect(String(expiredSessionCall.body.error || '').toLowerCase()).toContain('expired');
  });

  it('handles 10 concurrent wrong-password requests atomically without counter corruption or double escalation', async () => {
    const burst = Array.from({ length: 10 }, (_, idx) =>
      attemptLogin(app, 'superadmin', `BadBurst#${idx}`, `10.70.0.${idx + 1}`)
    );
    const responses = await Promise.all(burst);

    const status401 = responses.filter((r) => r.status === 401);
    const status423 = responses.filter((r) => r.status === 423);

    expect(status401.length).toBe(2);
    expect(status423.length).toBe(8);

    const secDoc = (await db.collection('account_security').doc('sec_superadmin').get()).data();
    const roleDoc = (await db.collection('user_roles').doc('role_superadmin').get()).data();
    expect(secDoc?.lockStatus).toBe('LOCKED');
    expect(secDoc?.consecutiveFailedAttempts).toBe(3);
    expect(secDoc?.progressiveLockLevel).toBe(1);
    expect(secDoc?.totalLockoutEvents).toBe(1);
    expect(secDoc?.lockDurationMinutes).toBe(10);
    expect(roleDoc?.progressiveLockLevel).toBe(1);
  });

  it('auto-reactivates after expiry, resets consecutive counter, retains level, audits post-lockout login, and auto-resets level after 24h clean usage', async () => {
    // 1. Trigger 1st lockout (10 min, level 1)
    const { r3 } = await triggerThreeFailedAttempts(app, 'superadmin', '10.80.0.1');
    expect(r3.status).toBe(423);
    expect(r3.body.lockDurationMinutes).toBe(10);

    // 2. Advance past 10 min lockout expiry and sign in with valid password
    clockMs += 10 * MINUTE_MS + 5000;
    const loginAfterExpiry = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.80.0.2'
    );
    expect(loginAfterExpiry.status).toBe(200);
    expect(loginAfterExpiry.body.success).toBe(true);
    expect(loginAfterExpiry.body.profile.authUid).toBe(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    expect(loginAfterExpiry.body.profile.lockStatus).toBe('ACTIVE');
    expect(loginAfterExpiry.body.profile.consecutiveFailedAttempts).toBe(0);

    // Verify uid index reactivated
    const uidIndex = (
      await db.collection('user_uid_index').doc(TEST_CANONICAL_ACCOUNTS.superadmin.uid).get()
    ).data();
    expect(uidIndex?.lockStatus).toBe('ACTIVE');
    expect(uidIndex?.lockedUntilMs).toBeNull();

    // Verify audit logs for lockout, expiry reactivation, and post-lockout login
    const secAuditDocs = Object.values(db.getRawCollection('security_audit_logs'));
    expect(secAuditDocs.some((l) => l.action === 'ACCOUNT_LOCKED')).toBe(true);
    expect(secAuditDocs.some((l) => l.action === 'LOCKOUT_EXPIRED_REACTIVATED')).toBe(true);
    expect(secAuditDocs.some((l) => l.action === 'LOGIN_SUCCESS_AFTER_LOCKOUT')).toBe(true);

    const enterpriseAuditDocs = Object.values(db.getRawCollection('audit_logs'));
    expect(enterpriseAuditDocs.some((l) => l.action === 'super_admin_progressive_lockout')).toBe(true);
    expect(enterpriseAuditDocs.some((l) => l.action === 'super_admin_lockout_expired')).toBe(true);
    expect(enterpriseAuditDocs.some((l) => l.action === 'login_success_after_lockout')).toBe(true);

    // 3. After 12 hours (< 24h default window), successful login still retains progressiveLockLevel = 1
    clockMs += 12 * HOUR_MS;
    const loginAt12h = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.80.0.3'
    );
    expect(loginAt12h.status).toBe(200);
    let secDoc = (await db.collection('account_security').doc('sec_superadmin').get()).data();
    expect(secDoc?.progressiveLockLevel).toBe(1);
    expect(secDoc?.cleanLoginsSinceLastLockout).toBe(2);

    // 4. A single failed password resets the clean window clock!
    clockMs += 10 * HOUR_MS; // 22h total, still < 24h
    const singleFail = await attemptLogin(app, 'superadmin', 'TypoPass#1', '10.80.0.4');
    expect(singleFail.status).toBe(401);
    secDoc = (await db.collection('account_security').doc('sec_superadmin').get()).data();
    expect(secDoc?.cleanWindowStartMs).toBeNull();
    expect(secDoc?.progressiveLockLevel).toBe(1);

    // Restart clean window with successful login
    clockMs += 1 * MINUTE_MS;
    const restartCleanLogin = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.80.0.5'
    );
    expect(restartCleanLogin.status).toBe(200);

    // 5. Advance 24h + 1m with zero failed attempts -> next successful login resets level to 0!
    clockMs += 24 * HOUR_MS + MINUTE_MS;
    const loginAt24h = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.80.0.6'
    );
    expect(loginAt24h.status).toBe(200);

    secDoc = (await db.collection('account_security').doc('sec_superadmin').get()).data();
    expect(secDoc?.progressiveLockLevel).toBe(0);
    expect(secDoc?.totalLockoutEvents).toBe(1); // history preserved!

    const allSecLogs = Object.values(db.getRawCollection('security_audit_logs'));
    expect(allSecLogs.some((l) => l.action === 'LOCKOUT_LEVEL_RESET')).toBe(true);
    const allEnterpriseLogs = Object.values(db.getRawCollection('audit_logs'));
    expect(allEnterpriseLogs.some((l) => l.action === 'super_admin_lockout_level_reset')).toBe(true);

    // 6. Verify next 3-strike lockout starts back at 10 minutes (Level 1)
    const nextLock = await triggerThreeFailedAttempts(app, 'superadmin', '10.80.0.7');
    expect(nextLock.r3.status).toBe(423);
    expect(nextLock.r3.body.lockDurationMinutes).toBe(10);
  });

  it('supports configurable superAdminLockoutResetHours in system_settings/global', async () => {
    await db.collection('system_settings').doc('global').update({
      superAdminLockoutResetHours: 6,
    });

    // Lock level 1 -> expire -> clean login
    await triggerThreeFailedAttempts(app, 'superadmin', '10.85.0.1');
    clockMs += 11 * MINUTE_MS;
    const firstClean = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.85.0.2'
    );
    expect(firstClean.status).toBe(200);

    // Advance 6 hours + 1 minute -> level resets to 0
    clockMs += 6 * HOUR_MS + MINUTE_MS;
    const secondClean = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.85.0.3'
    );
    expect(secondClean.status).toBe(200);

    const secDoc = (await db.collection('account_security').doc('sec_superadmin').get()).data();
    expect(secDoc?.progressiveLockLevel).toBe(0);
  });

  it('enforces Super Admin RBAC and fresh auth on POST /api/security/reset-superadmin-lockout-level', async () => {
    // Reach progressive level 2 (10m -> expire -> 20m -> expire -> sign in)
    await triggerThreeFailedAttempts(app, 'superadmin', '10.90.0.1');
    clockMs += 11 * MINUTE_MS;
    await triggerThreeFailedAttempts(app, 'superadmin', '10.90.0.2');
    clockMs += 21 * MINUTE_MS;
    const okLogin = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.90.0.3'
    );
    expect(okLogin.status).toBe(200);

    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid, {
      authTimeSec: Math.floor(clockMs / 1000),
    });
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid, {
      authTimeSec: Math.floor(clockMs / 1000),
    });
    // Mint a valid post-login Super Admin token, then advance 10 minutes so it exceeds the 5-min fresh-auth window
    const staleSuperToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid, {
      authTimeSec: Math.floor(clockMs / 1000),
    });
    clockMs += 10 * MINUTE_MS;

    // Non-Super-Admin must receive 403
    const adminRes = await request(app)
      .post('/api/security/reset-superadmin-lockout-level')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Unauthorized admin attempt', confirmed: true });
    expect(adminRes.status).toBe(403);

    const userRes = await request(app)
      .post('/api/security/reset-superadmin-lockout-level')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: 'Unauthorized user attempt', confirmed: true });
    expect(userRes.status).toBe(403);

    // Stale Super Admin token without fresh password must receive 401 requiresFreshAuth
    const noFreshRes = await request(app)
      .post('/api/security/reset-superadmin-lockout-level')
      .set('Authorization', `Bearer ${staleSuperToken}`)
      .send({ reason: 'Security review completed', confirmed: true });
    expect(noFreshRes.status).toBe(401);
    expect(noFreshRes.body.requiresFreshAuth).toBe(true);

    // Wrong fresh password must receive 401
    const wrongFreshRes = await request(app)
      .post('/api/security/reset-superadmin-lockout-level')
      .set('Authorization', `Bearer ${staleSuperToken}`)
      .send({
        reason: 'Security review completed',
        confirmed: true,
        freshSuperAdminPassword: 'WrongSuperPassword!',
      });
    expect(wrongFreshRes.status).toBe(401);

    // Valid fresh password + confirmation + reason succeeds
    const validResetRes = await request(app)
      .post('/api/security/reset-superadmin-lockout-level')
      .set('Authorization', `Bearer ${staleSuperToken}`)
      .send({
        reason: 'Incident investigated and cleared by Chief Plant Operations',
        confirmed: true,
        freshSuperAdminPassword: TEST_CANONICAL_ACCOUNTS.superadmin.password,
      });
    expect(validResetRes.status).toBe(200);
    expect(validResetRes.body.success).toBe(true);
    expect(validResetRes.body.previousLevel).toBe(2);
    expect(validResetRes.body.newLevel).toBe(0);
    expect(validResetRes.body.totalLockoutEvents).toBe(2);

    // Overview reflects level 0 while preserving totalLockoutEvents = 2
    const overviewRes = await request(app)
      .get('/api/security/overview')
      .set('Authorization', `Bearer ${staleSuperToken}`);
    expect(overviewRes.status).toBe(200);
    const saAccount = overviewRes.body.accounts.find((a: any) => a.loginId === 'superadmin');
    expect(saAccount.lockPolicyType).toBe('PROGRESSIVE_TEMPORARY');
    expect(saAccount.progressiveLockLevel).toBe(0);
    expect(saAccount.totalLockoutEvents).toBe(2);
  });

  it('persists active lockout, remaining duration, and progressive level across server restarts/redeploys', async () => {
    const { r3 } = await triggerThreeFailedAttempts(app, 'superadmin', '10.95.0.1');
    expect(r3.status).toBe(423);
    expect(r3.body.lockDurationMinutes).toBe(10);

    // Simulate 4 minutes passing and a fresh server instance cold-starting over the same Firestore DB
    clockMs += 4 * MINUTE_MS;
    const restartedApp = buildApp();

    const retryAfterRestart = await attemptLogin(
      restartedApp,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.95.0.2'
    );
    expect(retryAfterRestart.status).toBe(423);
    expect(retryAfterRestart.body.temporaryLock).toBe(true);
    expect(retryAfterRestart.body.remainingSeconds).toBe(6 * 60);

    // Advance past remaining 6 minutes on restarted instance -> next 3-strike escalates to 20 minutes
    clockMs += 6 * MINUTE_MS + 1000;
    const secondLock = await triggerThreeFailedAttempts(restartedApp, 'superadmin', '10.95.0.3');
    expect(secondLock.r3.status).toBe(423);
    expect(secondLock.r3.body.lockDurationMinutes).toBe(20);
  });

  it('keeps Admin, User, and Custom Role accounts strictly on permanent manual lockout (unchanged behavior)', async () => {
    // Seed a custom role account
    const customUid = 'custom_supervisor_uid_999';
    auth.seedUser({ uid: customUid, email: 'line_sup@narid.com', password: 'CustomSupPassword#1' });
    await db.collection('roles').doc('line_supervisor').set({
      id: 'line_supervisor',
      name: 'Line Supervisor',
      isActive: true,
    });
    await db.collection('user_roles').doc('role_line_sup').set({
      id: 'role_line_sup',
      loginId: 'line_sup',
      name: 'Line Supervisor Test',
      email: 'line_sup@narid.com',
      authUid: customUid,
      role: 'line_supervisor',
      status: 'Active',
      lockStatus: 'ACTIVE',
      isLocked: false,
      passwordHash: hashPassword('CustomSupPassword#1'),
      modulesAllowed: ['dashboard', 'scanner'],
    });

    for (const target of [
      { loginId: 'admin', password: TEST_CANONICAL_ACCOUNTS.admin.password, ip: '10.99.0.1' },
      { loginId: 'user', password: TEST_CANONICAL_ACCOUNTS.user.password, ip: '10.99.0.2' },
      { loginId: 'line_sup', password: 'CustomSupPassword#1', ip: '10.99.0.3' },
    ]) {
      const { r3 } = await triggerThreeFailedAttempts(app, target.loginId, target.ip);
      expect(r3.status).toBe(423);
      expect(r3.body.temporaryLock).toBe(false);
      expect(r3.body.lockedUntil).toBeUndefined();
      expect(r3.body.remainingSeconds).toBeUndefined();
      expect(r3.body.error).toContain('contact Super Admin');
    }

    // Advance 72 hours — Admin, User, and Custom Role must STILL remain permanently LOCKED!
    clockMs += 72 * HOUR_MS;

    for (const target of [
      { loginId: 'admin', password: TEST_CANONICAL_ACCOUNTS.admin.password, ip: '10.99.1.1' },
      { loginId: 'user', password: TEST_CANONICAL_ACCOUNTS.user.password, ip: '10.99.1.2' },
      { loginId: 'line_sup', password: 'CustomSupPassword#1', ip: '10.99.1.3' },
    ]) {
      const stillLocked = await attemptLogin(app, target.loginId, target.password, target.ip);
      expect(stillLocked.status).toBe(423);
      expect(stillLocked.body.temporaryLock).toBe(false);
    }

    // Super Admin manual unblock restores Admin cleanly
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid, {
      authTimeSec: Math.floor(clockMs / 1000),
    });
    const unblockRes = await request(app)
      .post('/api/security/unblock-account')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        targetLoginId: 'admin',
        reason: 'Verified identity with Shift Supervisor',
        confirmed: true,
      });
    expect(unblockRes.status).toBe(200);

    const adminLoginAfterUnblock = await attemptLogin(
      app,
      'admin',
      TEST_CANONICAL_ACCOUNTS.admin.password,
      '10.99.2.1'
    );
    expect(adminLoginAfterUnblock.status).toBe(200);
  });

  it('retains persistent IP rate limiting when hammering a temporarily locked Super Admin from a single IP', async () => {
    const attackerIp = '203.0.113.77';
    // 3 failures -> temporary lockout
    const { r3 } = await triggerThreeFailedAttempts(app, 'superadmin', attackerIp);
    expect(r3.status).toBe(423);

    // Hammer locked account 5 times from same IP -> 5th locked_hit sets IP cooldown -> 6th returns 429
    for (let i = 0; i < 5; i++) {
      const hit = await attemptLogin(app, 'superadmin', 'StillHammering#1', attackerIp);
      expect(hit.status).toBe(423);
    }
    const throttled = await attemptLogin(app, 'superadmin', 'StillHammering#6', attackerIp);
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe('RATE_LIMITED');
  });

  it('serves accurate server-authoritative countdown via GET /api/auth/lockout-status across refresh, multiple devices, and server restarts without browser storage', async () => {
    const deviceAIp = '10.1.1.1';
    const deviceBIp = '192.168.9.9';

    // Before lockout, status reports unlocked
    const initialStatus = await request(app)
      .get('/api/auth/lockout-status')
      .set('X-Forwarded-For', deviceAIp);
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.headers['cache-control']).toContain('no-store');
    expect(initialStatus.body.locked).toBe(false);
    expect(initialStatus.body.temporaryLock).toBe(false);

    // Device A triggers 1st progressive lockout (10 minutes)
    const { r3 } = await triggerThreeFailedAttempts(app, 'superadmin', deviceAIp);
    expect(r3.status).toBe(423);
    expect(r3.body.lockoutUntil).toBeTruthy();
    expect(r3.body.lockedUntil).toBe(r3.body.lockoutUntil);
    expect(r3.body.lockDurationMinutes).toBe(10);

    // Firestore stores authoritative lockoutUntil on both account_security and user_roles
    const secDoc = (await db.collection('account_security').doc('sec_superadmin').get()).data();
    const roleDoc = (await db.collection('user_roles').doc('role_superadmin').get()).data();
    expect(secDoc?.lockoutUntil).toBe(r3.body.lockoutUntil);
    expect(roleDoc?.lockoutUntil).toBe(r3.body.lockoutUntil);

    // Advance 18 seconds -> simulate page refresh on Device A (09:42 remaining = 582s)
    clockMs += 18 * 1000;
    const refreshStatus = await request(app)
      .get('/api/auth/lockout-status?loginId=superadmin')
      .set('X-Forwarded-For', deviceAIp)
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0');
    expect(refreshStatus.status).toBe(200);
    expect(refreshStatus.body.locked).toBe(true);
    expect(refreshStatus.body.temporaryLock).toBe(true);
    expect(refreshStatus.body.lockoutUntil).toBe(r3.body.lockoutUntil);
    expect(refreshStatus.body.lockDurationMinutes).toBe(10);
    expect(refreshStatus.body.remainingSeconds).toBe(582);
    expect(formatCountdownSeconds(refreshStatus.body.remainingSeconds)).toBe('09:42');
    // Internal escalation fields must never leak
    expect(refreshStatus.body.progressiveLockLevel).toBeUndefined();
    expect(refreshStatus.body.totalLockoutEvents).toBeUndefined();

    // Device B (different IP & device, zero local storage) sees the exact same remaining time
    const deviceBStatus = await request(app)
      .get('/api/auth/lockout-status')
      .set('X-Forwarded-For', deviceBIp)
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1');
    expect(deviceBStatus.status).toBe(200);
    expect(deviceBStatus.body.locked).toBe(true);
    expect(deviceBStatus.body.lockoutUntil).toBe(r3.body.lockoutUntil);
    expect(deviceBStatus.body.lockedUntilMs).toBe(r3.body.lockedUntilMs);
    expect(deviceBStatus.body.lockDurationMinutes).toBe(10);
    expect(deviceBStatus.body.remainingSeconds).toBe(582);

    // Simulate backend server restart (fresh Express app instance over same Firestore DB)
    clockMs += 42 * 1000; // Total elapsed: 60s -> 09:00 remaining = 540s
    const restartedApp = buildApp();
    const afterRestartStatus = await request(restartedApp)
      .get('/api/auth/lockout-status')
      .set('X-Forwarded-For', deviceBIp);
    expect(afterRestartStatus.status).toBe(200);
    expect(afterRestartStatus.body.locked).toBe(true);
    expect(afterRestartStatus.body.lockoutUntil).toBe(r3.body.lockoutUntil);
    expect(afterRestartStatus.body.remainingSeconds).toBe(540);
    expect(formatCountdownSeconds(afterRestartStatus.body.remainingSeconds)).toBe('09:00');
  });

  it('requires backend verification at 00:00: refuses premature client unlock before lockoutUntil <= serverNowMs and reactivates once expired', async () => {
    const ip = '10.65.0.1';
    const { r3 } = await triggerThreeFailedAttempts(app, 'superadmin', ip);
    expect(r3.status).toBe(423);
    const lockedUntilMs = r3.body.lockedUntilMs as number;

    // 5 seconds BEFORE expiry (simulates client clock drifting ahead and calling re-check at client 00:00)
    clockMs = lockedUntilMs - 5 * 1000;
    const prematureCheck = await request(app)
      .get('/api/auth/lockout-status?loginId=superadmin')
      .set('X-Forwarded-For', ip);
    expect(prematureCheck.status).toBe(200);
    expect(prematureCheck.body.locked).toBe(true);
    expect(prematureCheck.body.temporaryLock).toBe(true);
    expect(prematureCheck.body.remainingSeconds).toBe(5);
    expect(formatCountdownSeconds(prematureCheck.body.remainingSeconds)).toBe('00:05');

    // Correct password must STILL be rejected before lockoutUntil <= serverNowMs
    const prematureLogin = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.65.0.2'
    );
    expect(prematureLogin.status).toBe(423);
    expect(prematureLogin.body.locked).toBe(true);

    // Advance exactly to lockoutUntil -> backend independently verifies lockoutUntil <= serverNowMs & reactivates
    clockMs = lockedUntilMs;
    const expiredCheck = await request(app)
      .get('/api/auth/lockout-status?loginId=superadmin')
      .set('X-Forwarded-For', ip);
    expect(expiredCheck.status).toBe(200);
    expect(expiredCheck.body.locked).toBe(false);
    expect(expiredCheck.body.temporaryLock).toBe(false);
    expect(expiredCheck.body.expiredReactivated).toBe(true);

    // Firestore state reactivated while retaining progressive lockout level
    const secAfter = (await db.collection('account_security').doc('sec_superadmin').get()).data();
    const roleAfter = (await db.collection('user_roles').doc('role_superadmin').get()).data();
    expect(secAfter?.lockStatus).toBe('ACTIVE');
    expect(secAfter?.lockoutUntil).toBeNull();
    expect(secAfter?.consecutiveFailedAttempts).toBe(0);
    expect(secAfter?.progressiveLockLevel).toBe(1);
    expect(roleAfter?.isLocked).toBe(false);
    expect(roleAfter?.lockoutUntil).toBeNull();

    // Audit trail recorded automatic reactivation
    const secLogs = (await db.collection('security_audit_logs').get()).docs.map((d) => d.data());
    expect(secLogs.some((l) => l?.action === 'LOCKOUT_EXPIRED_REACTIVATED')).toBe(true);

    // Normal login now succeeds immediately
    const loginAfter = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.65.0.3'
    );
    expect(loginAfter.status).toBe(200);
    expect(loginAfter.body.success).toBe(true);
  });

  it('never exposes or alters Admin, User, or Custom Role lockout status via GET /api/auth/lockout-status', async () => {
    // Permanently lock Admin via 3 wrong passwords
    const { r3: adminLock } = await triggerThreeFailedAttempts(app, 'admin', '10.88.0.1');
    expect(adminLock.status).toBe(423);
    expect(adminLock.body.temporaryLock).toBe(false);

    // Querying lockout-status for admin, user, or custom role must NEVER leak lock status
    for (const loginId of ['admin', 'user', 'line_sup', 'nonexistent_user']) {
      const res = await request(app)
        .get(`/api/auth/lockout-status?loginId=${loginId}`)
        .set('X-Forwarded-For', '10.88.0.2');
      expect(res.status).toBe(200);
      expect(res.body.locked).toBe(false);
      expect(res.body.temporaryLock).toBe(false);
      expect(res.body.lockoutUntil).toBeUndefined();
    }
  });

  it('derives clock-skew-immune MM:SS countdown state strictly from server lockoutUntil and serverNowMs', () => {
    const serverNow = Date.parse('2026-11-19T10:00:00.000Z');
    const lockedUntilMs = serverNow + 10 * MINUTE_MS;
    const lockoutUntilIso = new Date(lockedUntilMs).toISOString();

    expect(formatCountdownSeconds(600)).toBe('10:00');
    expect(formatCountdownSeconds(582)).toBe('09:42');
    expect(formatCountdownSeconds(1200)).toBe('20:00');
    expect(formatCountdownSeconds(1800)).toBe('30:00');
    expect(formatCountdownSeconds(3600)).toBe('60:00');
    expect(formatCountdownSeconds(5)).toBe('00:05');
    expect(formatCountdownSeconds(0)).toBe('00:00');

    // Client A clock is +5 minutes ahead; Client B clock is -7 minutes behind
    const clientANow = serverNow + 5 * MINUTE_MS;
    const clientBNow = serverNow - 7 * MINUTE_MS;

    const stateA = deriveServerLockoutState(
      {
        locked: true,
        temporaryLock: true,
        loginId: 'superadmin',
        lockoutUntil: lockoutUntilIso,
        serverNowMs: serverNow,
        lockDurationMinutes: 10,
      },
      clientANow
    );
    const stateB = deriveServerLockoutState(
      {
        locked: true,
        temporaryLock: true,
        loginId: 'superadmin',
        lockoutUntil: lockoutUntilIso,
        serverNowMs: serverNow,
        lockDurationMinutes: 10,
      },
      clientBNow
    );

    expect(stateA).not.toBeNull();
    expect(stateB).not.toBeNull();

    // Both devices calculate the EXACT same 582s (09:42) 18 seconds later despite 12-minute clock difference
    const remA = computeRemainingLockoutSeconds(
      stateA!.lockedUntilMs,
      stateA!.clockOffsetMs,
      clientANow + 18 * 1000
    );
    const remB = computeRemainingLockoutSeconds(
      stateB!.lockedUntilMs,
      stateB!.clockOffsetMs,
      clientBNow + 18 * 1000
    );
    expect(remA).toBe(582);
    expect(remB).toBe(582);
    expect(formatCountdownSeconds(remA)).toBe('09:42');
    expect(formatCountdownSeconds(remB)).toBe('09:42');

    // Non-temporary or unlocked payloads always return null
    expect(deriveServerLockoutState({ locked: false, temporaryLock: false }, clientANow)).toBeNull();
    expect(deriveServerLockoutState({ locked: true, temporaryLock: false }, clientANow)).toBeNull();

    // Fallback: when lockedUntilMs/lockoutUntil are omitted but remainingSeconds + serverNowMs are present
    const fallbackState = deriveServerLockoutState(
      {
        locked: true,
        temporaryLock: true,
        loginId: 'superadmin',
        serverNowMs: serverNow,
        remainingSeconds: 1200,
        lockDurationMinutes: 20,
      },
      clientANow
    );
    expect(fallbackState).not.toBeNull();
    expect(fallbackState!.lockDurationMinutes).toBe(20);
    expect(
      computeRemainingLockoutSeconds(fallbackState!.lockedUntilMs, fallbackState!.clockOffsetMs, clientANow)
    ).toBe(1200);
  });

  it('resolves legacy canonical Super Admin locks missing lockoutUntil without falling back to permanent Contact Super Admin message', async () => {
    const legacyLockedAt = new Date(clockMs - 3 * MINUTE_MS).toISOString(); // locked 3 minutes ago
    await db.collection('user_roles').doc('role_superadmin').update({
      isLocked: true,
      lockStatus: 'LOCKED',
      lockedAt: legacyLockedAt,
      lockedUntil: null,
      lockoutUntil: null,
      lockedUntilMs: null,
      lockDurationMinutes: null,
      progressiveLockLevel: 1,
      consecutiveFailedAttempts: 3,
    });
    await db.collection('account_security').doc('sec_superadmin').set(
      {
        id: 'sec_superadmin',
        loginId: 'superadmin',
        role: 'SUPER_ADMIN',
        lockStatus: 'LOCKED',
        lockedAt: legacyLockedAt,
        lockedUntil: null,
        lockoutUntil: null,
        lockedUntilMs: null,
        lockDurationMinutes: null,
        progressiveLockLevel: 1,
        consecutiveFailedAttempts: 3,
      },
      { merge: true }
    );

    // 1. GET /api/auth/lockout-status returns active temporary lock with 7 minutes remaining (420s)
    const statusRes = await request(app)
      .get('/api/auth/lockout-status?loginId=superadmin')
      .set('X-Forwarded-For', '10.77.0.1');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.locked).toBe(true);
    expect(statusRes.body.temporaryLock).toBe(true);
    expect(statusRes.body.lockDurationMinutes).toBe(10);
    expect(statusRes.body.remainingSeconds).toBe(420);
    expect(statusRes.body.lockoutUntil).toBeTruthy();

    // 2. POST /api/auth/login returns 423 temporaryLock=true (NOT "Please contact Super Admin")
    const loginRes = await attemptLogin(
      app,
      'superadmin',
      TEST_CANONICAL_ACCOUNTS.superadmin.password,
      '10.77.0.2'
    );
    expect(loginRes.status).toBe(423);
    expect(loginRes.body.temporaryLock).toBe(true);
    expect(loginRes.body.lockDurationMinutes).toBe(10);
    expect(loginRes.body.remainingSeconds).toBe(420);
    expect(loginRes.body.error).not.toContain('Please contact Super Admin');

    // 3. After remaining 7 minutes elapse, backend automatically reactivates on status verification
    clockMs += 7 * MINUTE_MS;
    const expiredRes = await request(app)
      .get('/api/auth/lockout-status?loginId=superadmin')
      .set('X-Forwarded-For', '10.77.0.3');
    expect(expiredRes.status).toBe(200);
    expect(expiredRes.body.locked).toBe(false);
    expect(expiredRes.body.expiredReactivated).toBe(true);
  });

  it('routes AI Studio Preview auth login & lockout-status to live same-origin backend first, parses 423 lockout payload, and handles API failures safely', async () => {
    const { executeApiFetch } = await import('../src/config/api.ts');
    const {
      loginWithLoginIdAndPassword,
      fetchSuperAdminLockoutStatus,
    } = await import('../src/services/authService.ts');

    const prevWindow = (globalThis as any).window;
    const prevFetch = globalThis.fetch;

    try {
      (globalThis as any).window = {
        location: {
          hostname: 'ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app',
          origin: 'https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app',
        },
      };

      const nowMs = Date.parse('2026-11-19T18:00:00.000Z');
      const lockedUntilMs = nowMs + 10 * MINUTE_MS;
      const lockoutUntil = new Date(lockedUntilMs).toISOString();

      // 1. In Preview, loginWithLoginIdAndPassword MUST hit same-origin /api/auth/login (NOT stale Vercel)
      //    and parse full 423 ACCOUNT_LOCKED metadata onto LoginAuthError
      const loginFetchTargets: string[] = [];
      globalThis.fetch = (async (input: any) => {
        const target = String(input);
        loginFetchTargets.push(target);
        return new Response(
          JSON.stringify({
            success: false,
            code: 'ACCOUNT_LOCKED',
            locked: true,
            temporaryLock: true,
            lockoutUntil,
            lockedUntil: lockoutUntil,
            lockedUntilMs,
            serverNowMs: nowMs,
            remainingSeconds: 600,
            lockDurationMinutes: 10,
            error: 'Super Admin account temporarily locked for 10 minutes.',
          }),
          { status: 423, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      let caughtErr: any = null;
      try {
        await loginWithLoginIdAndPassword('superadmin', 'WrongPass#3', true);
      } catch (e) {
        caughtErr = e;
      }

      expect(loginFetchTargets).toEqual(['/api/auth/login']);
      expect(caughtErr).not.toBeNull();
      expect(caughtErr.status).toBe(423);
      expect(caughtErr.code).toBe('ACCOUNT_LOCKED');
      expect(caughtErr.locked).toBe(true);
      expect(caughtErr.temporaryLock).toBe(true);
      expect(caughtErr.lockoutUntil).toBe(lockoutUntil);
      expect(caughtErr.lockedUntilMs).toBe(lockedUntilMs);
      expect(caughtErr.serverNowMs).toBe(nowMs);
      expect(caughtErr.remainingSeconds).toBe(600);
      expect(caughtErr.lockDurationMinutes).toBe(10);

      // Derived UI state activates immediately from the 423 LoginAuthError
      const uiState = deriveServerLockoutState(caughtErr, nowMs);
      expect(uiState).not.toBeNull();
      expect(uiState!.lockDurationMinutes).toBe(10);
      expect(computeRemainingLockoutSeconds(uiState!.lockedUntilMs, uiState!.clockOffsetMs, nowMs)).toBe(600);

      // 2. fetchSuperAdminLockoutStatus calls same-origin /api/auth/lockout-status?loginId=superadmin and parses all fields
      const statusTargets: string[] = [];
      globalThis.fetch = (async (input: any) => {
        statusTargets.push(String(input));
        return new Response(
          JSON.stringify({
            success: true,
            locked: true,
            temporaryLock: true,
            loginId: 'superadmin',
            lockoutUntil,
            lockedUntil: lockoutUntil,
            lockedUntilMs,
            serverNowMs: nowMs + 18 * 1000,
            remainingSeconds: 582,
            lockDurationMinutes: 10,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const parsedStatus = await fetchSuperAdminLockoutStatus('superadmin');
      expect(statusTargets).toEqual(['/api/auth/lockout-status?loginId=superadmin']);
      expect(parsedStatus).toMatchObject({
        success: true,
        locked: true,
        temporaryLock: true,
        loginId: 'superadmin',
        lockoutUntil,
        lockedUntilMs,
        remainingSeconds: 582,
        lockDurationMinutes: 10,
      });

      // 3. Non-Super-Admin loginId skips network fetch completely and returns unlocked
      const nonSaTargets: string[] = [];
      globalThis.fetch = (async (input: any) => {
        nonSaTargets.push(String(input));
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      const adminStatus = await fetchSuperAdminLockoutStatus('admin');
      expect(nonSaTargets).toEqual([]);
      expect(adminStatus?.locked).toBe(false);

      // 4. API failure (HTTP 500) returns null safely (never triggers false client unlock)
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ success: false, error: 'Temporary outage' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch;
      const failedStatus = await fetchSuperAdminLockoutStatus('superadmin');
      expect(failedStatus).toBeNull();

      // 5. Preview auth requests STRICTLY target local Express backend with credentials:'include' and NEVER silently fall back to Vercel
      const strictCalls: Array<{ target: string; credentials?: RequestCredentials; accept?: string | null }> = [];
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const headers = new Headers(init?.headers || {});
        strictCalls.push({
          target: String(input),
          credentials: init?.credentials,
          accept: headers.get('accept'),
        });
        return new Response(
          JSON.stringify({ success: false, code: 'FIREBASE_ADMIN_UNCONFIGURED', error: 'Not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const strictRes = await executeApiFetch(
        'https://narid-atdc-tracker.vercel.app/api/auth/login',
        { method: 'POST', body: '{}' },
        'POST /api/auth/login',
        { preferSameOriginInPreview: true, noRetryOnNetworkError: true }
      );
      expect(strictRes.status).toBe(503);
      expect(strictCalls).toEqual([
        {
          target: '/api/auth/login',
          credentials: 'include',
          accept: 'application/json',
        },
      ]);

      // Network failure on local Preview Express backend surfaces clear error without silently hitting Vercel
      const netErrCalls: string[] = [];
      globalThis.fetch = (async (input: any) => {
        netErrCalls.push(String(input));
        throw new TypeError('Failed to fetch');
      }) as typeof fetch;

      await expect(
        executeApiFetch(
          'https://narid-atdc-tracker.vercel.app/api/auth/login',
          { method: 'POST', body: '{}' },
          'POST /api/auth/login',
          { preferSameOriginInPreview: true, noRetryOnNetworkError: true }
        )
      ).rejects.toThrow('Unable to reach local Preview backend for POST /api/auth/login');
      expect(netErrCalls).toEqual(['/api/auth/login']);
    } finally {
      (globalThis as any).window = prevWindow;
      globalThis.fetch = prevFetch;
    }
  });

  it('guarantees JSON responses for /api/auth/login & /api/auth/lockout-status, blocks SPA index.html fallthrough, and rejects HTTP 200 HTML safely', async () => {
    const { resolveServerPort, isApiRequestPath } = await import('../server.ts');
    const { safeParseJsonResponse, isAiStudioPreviewHostname } = await import('../src/config/api.ts');
    const { loginWithLoginIdAndPassword } = await import('../src/services/authService.ts');

    // Port & path guards
    expect(resolveServerPort(['--port', '3000', '--host', '0.0.0.0'], { PORT: '8080', NODE_ENV: 'development' })).toBe(3000);
    expect(resolveServerPort(['--port=3001'], { NODE_ENV: 'development' })).toBe(3001);
    expect(resolveServerPort([], { NODE_ENV: 'development' })).toBe(3000);
    expect(resolveServerPort([], { NODE_ENV: 'production' })).toBe(8080);
    expect(isApiRequestPath('/api/auth/login')).toBe(true);
    expect(isApiRequestPath('/api/auth/lockout-status?loginId=superadmin')).toBe(true);
    expect(isApiRequestPath('/api')).toBe(true);
    expect(isApiRequestPath('/dashboard')).toBe(false);
    expect(isAiStudioPreviewHostname('ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app')).toBe(true);
    expect(isAiStudioPreviewHostname('ais-pre-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app')).toBe(true);
    expect(isAiStudioPreviewHostname('narid-atdc-tracker.vercel.app')).toBe(false);

    // Mount a simulated SPA index.html catch-all AFTER createApp() to verify /api/* NEVER falls through to HTML
    const testApp = buildApp();
    testApp.get('*', (_req, res) => {
      res.status(200).type('text/html').send('<!doctype html><html><body><div id="root"></div></body></html>');
    });

    // 1. POST /api/auth/login returns JSON for success, wrong password, lockout (423), and malformed JSON (400)
    const okLogin = await request(testApp)
      .post('/api/auth/login')
      .send({ loginId: 'admin', password: TEST_CANONICAL_ACCOUNTS.admin.password });
    expect(okLogin.status).toBe(200);
    expect(okLogin.headers['content-type']).toContain('application/json');
    expect(okLogin.body.success).toBe(true);

    const wrongPass = await request(testApp)
      .post('/api/auth/login')
      .send({ loginId: 'superadmin', password: 'WrongPassword#1' });
    expect(wrongPass.status).toBe(401);
    expect(wrongPass.headers['content-type']).toContain('application/json');
    expect(wrongPass.body.success).toBe(false);

    await request(testApp).post('/api/auth/login').send({ loginId: 'superadmin', password: 'WrongPassword#2' });
    const locked423 = await request(testApp)
      .post('/api/auth/login')
      .send({ loginId: 'superadmin', password: 'WrongPassword#3' });
    expect(locked423.status).toBe(423);
    expect(locked423.headers['content-type']).toContain('application/json');
    expect(locked423.body.code).toBe('ACCOUNT_LOCKED');
    expect(locked423.body.temporaryLock).toBe(true);

    const malformedJson = await request(testApp)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"loginId": "superadmin", invalid');
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.headers['content-type']).toContain('application/json');
    expect(malformedJson.body.code).toBe('INVALID_JSON_BODY');

    // 2. GET /api/auth/lockout-status returns JSON (never HTML)
    const lockoutStatus = await request(testApp).get('/api/auth/lockout-status?loginId=superadmin');
    expect(lockoutStatus.status).toBe(200);
    expect(lockoutStatus.headers['content-type']).toContain('application/json');
    expect(lockoutStatus.body.locked).toBe(true);
    expect(lockoutStatus.body.temporaryLock).toBe(true);

    // 3. Unknown /api/* GET & POST return JSON 404 (never fall through to SPA index.html)
    const unknownApiGet = await request(testApp).get('/api/auth/does-not-exist');
    expect(unknownApiGet.status).toBe(404);
    expect(unknownApiGet.headers['content-type']).toContain('application/json');
    expect(unknownApiGet.text).not.toContain('<!doctype html>');

    // 4. Non-API SPA route still serves index.html
    const spaRes = await request(testApp).get('/dashboard');
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers['content-type']).toContain('text/html');

    // 5. HTTP 200 HTML responses (SPA index.html, AI Studio cookie check, nginx warmup) are NEVER treated as successful auth
    const spaHtml200 = new Response('<!doctype html><html><head><title>Narid ATDC Tracker</title></head><body><div id="root"></div></body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const parsedSpa = await safeParseJsonResponse(spaHtml200, 'POST /api/auth/login');
    expect(parsedSpa.ok).toBe(false);
    expect(parsedSpa.isHtmlOrNonJson).toBe(true);
    expect(parsedSpa.errorMessage).toContain('index.html');

    const cookieCheckHtml200 = new Response('<!doctype html><html><head><title>Cookie check</title></head><body>Checking cookies</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const parsedCookie = await safeParseJsonResponse(cookieCheckHtml200, 'POST /api/auth/login');
    expect(parsedCookie.ok).toBe(false);
    expect(parsedCookie.isHtmlOrNonJson).toBe(true);
    expect(parsedCookie.errorMessage).toContain('session authentication check');

    const warmupHtml200 = new Response('<!doctype html><html><head><title>Starting Server...</title></head><body>Warming up</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const parsedWarmup = await safeParseJsonResponse(warmupHtml200, 'POST /api/auth/login');
    expect(parsedWarmup.ok).toBe(false);
    expect(parsedWarmup.isHtmlOrNonJson).toBe(true);
    expect(parsedWarmup.errorMessage).toContain('warmup HTML');

    // loginWithLoginIdAndPassword rejects HTTP 200 HTML cleanly without treating it as authenticated
    const prevWindow = (globalThis as any).window;
    const prevFetch = globalThis.fetch;
    try {
      (globalThis as any).window = {
        location: {
          hostname: 'ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app',
          origin: 'https://ais-dev-ffrnx5p5324ee4aajyzxbj-356936239657.asia-southeast1.run.app',
        },
      };
      globalThis.fetch = (async () =>
        new Response('<!doctype html><html><head><title>Starting Server...</title></head><body></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })) as typeof fetch;

      await expect(loginWithLoginIdAndPassword('superadmin', 'AnyPass#1', true)).rejects.toMatchObject({
        status: 200,
        code: 'HTTP_200_NON_JSON',
      });
    } finally {
      (globalThis as any).window = prevWindow;
      globalThis.fetch = prevFetch;
    }
  });
});



