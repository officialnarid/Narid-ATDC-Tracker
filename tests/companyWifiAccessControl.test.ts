import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../server.ts';
import {
  COMPANY_WIFI_DENIED_CODE,
  COMPANY_WIFI_DENIED_MESSAGE,
  validatePublicCompanyWifiIpOrCidr,
  ipMatchesCompanyWifiNetwork,
} from '../src/utils/companyWifiUtils.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

describe('Company Wi-Fi Access Control (Full Replacement Suite)', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];
  let superToken: string;
  let adminToken: string;
  let userToken: string;

  const PLANT1_IP = '203.0.113.10';
  const PLANT2_CIDR = '198.51.100.0/24';
  const PLANT2_HOST_IP = '198.51.100.42';
  const HQ_IPV6 = '2001:db8:abcd::1';
  const UNAUTHORIZED_IP = '192.0.2.99';

  async function createNetwork(
    networkName: string,
    ipOrCidr: string,
    status: 'Active' | 'Inactive' = 'Active'
  ) {
    const res = await request(app)
      .post('/api/company-wifi/networks')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Forwarded-For', PLANT1_IP)
      .send({ networkName, ipOrCidr, status });
    expect(res.status).toBe(201);
    return res.body.network;
  }

  async function setRolePolicy(
    roleId: 'admin' | 'user',
    accessMode: 'RESTRICTED' | 'UNRESTRICTED',
    allowedNetworkIds: string[]
  ) {
    const res = await request(app)
      .put(`/api/company-wifi/policies/${roleId}`)
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Forwarded-For', PLANT1_IP)
      .send({ accessMode, allowedNetworkIds });
    expect(res.status).toBe(200);
    return res.body.policy;
  }

  async function enableEnforcement() {
    const res = await request(app)
      .put('/api/company-wifi/settings')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Forwarded-For', PLANT1_IP)
      .send({ enforcementEnabled: true, confirmEnable: true });
    expect(res.status).toBe(200);
    expect(res.body.settings.enforcementEnabled).toBe(true);
    return res.body.settings;
  }

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

    superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
  });

  // --------------------------------------------------------------------------
  // IPv4 / IPv6 / CIDR Validation Unit Checks
  // --------------------------------------------------------------------------
  it('validates IPv4, IPv4 CIDR, IPv6, and rejects private, loopback, invalid, and overly-broad CIDRs', () => {
    expect(validatePublicCompanyWifiIpOrCidr('203.0.113.10').valid).toBe(true);
    expect(validatePublicCompanyWifiIpOrCidr('198.51.100.0/24').valid).toBe(true);
    expect(validatePublicCompanyWifiIpOrCidr('2001:db8:abcd::1').valid).toBe(true);
    expect(validatePublicCompanyWifiIpOrCidr('2001:db8:abcd::/48').valid).toBe(true);

    // Reject private LAN, loopback, CGNAT, link-local, invalid, and too-broad CIDRs
    const rejected = [
      '192.168.1.1',
      '10.0.0.1',
      '172.16.5.20',
      '127.0.0.1',
      '100.64.0.1',
      '169.254.1.1',
      '::1',
      'fe80::1',
      'fc00::1',
      'not-an-ip',
      '999.1.1.1',
      '0.0.0.0/0',
      '203.0.113.0/8',
      '198.51.100.0/15',
      '2001:db8::/16',
    ];
    for (const bad of rejected) {
      expect(validatePublicCompanyWifiIpOrCidr(bad).valid, `Expected "${bad}" to be rejected`).toBe(false);
    }

    // Matching check for IPv4 CIDR and IPv6
    expect(
      ipMatchesCompanyWifiNetwork(PLANT2_HOST_IP, {
        publicIp: '198.51.100.0',
        cidrRange: PLANT2_CIDR,
        status: 'Active',
      })
    ).toBe(true);
    expect(
      ipMatchesCompanyWifiNetwork('2001:0db8:abcd:0000:0000:0000:0000:0001', {
        publicIp: HQ_IPV6,
        cidrRange: '',
        status: 'Active',
      })
    ).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test Case 1: Super Admin Permanent Unrestricted Bypass
  // --------------------------------------------------------------------------
  it('TC1: Super Admin bypasses Company Wi-Fi restrictions from ANY IP (even unauthorized or private) when enforcement is ON', async () => {
    await enableEnforcement();

    // Super Admin from unauthorized public IP
    const dashExternal = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Forwarded-For', UNAUTHORIZED_IP);
    expect(dashExternal.status).toBe(200);

    // Super Admin from private LAN IP
    const dashPrivate = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Forwarded-For', '192.168.1.50');
    expect(dashPrivate.status).toBe(200);

    // Self-check reports SUPER_ADMIN bypass
    const checkRes = await request(app)
      .get('/api/company-wifi/check')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Forwarded-For', UNAUTHORIZED_IP);
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.allowed).toBe(true);
    expect(checkRes.body.bypassReason).toBe('SUPER_ADMIN');

    // Super Admin session verification always succeeds
    const verifyRes = await request(app)
      .post('/api/auth/verify-session')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Forwarded-For', UNAUTHORIZED_IP)
      .send({ loginId: 'superadmin' });
    expect(verifyRes.status).toBe(200);
  });

  // --------------------------------------------------------------------------
  // Test Case 2: ADMIN Allowed ONLY from Assigned Company Wi-Fi
  // --------------------------------------------------------------------------
  it('TC2: ADMIN can access protected endpoints ONLY from assigned active Company Wi-Fi IP/CIDR', async () => {
    const plant1 = await createNetwork('Plant 1 Wi-Fi', PLANT1_IP);
    await setRolePolicy('admin', 'RESTRICTED', [plant1.networkId]);
    await enableEnforcement();

    // Allowed from Plant 1 IP
    const allowedDash = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP);
    expect(allowedDash.status).toBe(200);

    const allowedScan = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP)
      .send({ rawPayload: 'QR_EMP001_VALID', scannerType: 'IN' });
    expect(allowedScan.status).toBe(200);

    // Blocked from unauthorized IP
    const blockedDash = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', UNAUTHORIZED_IP);
    expect(blockedDash.status).toBe(403);
    expect(blockedDash.body.code).toBe(COMPANY_WIFI_DENIED_CODE);

    const blockedScan = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', UNAUTHORIZED_IP)
      .send({ rawPayload: 'QR_EMP001_VALID', scannerType: 'OUT' });
    expect(blockedScan.status).toBe(403);
    expect(blockedScan.body.code).toBe(COMPANY_WIFI_DENIED_CODE);
  });

  // --------------------------------------------------------------------------
  // Test Case 3: USER Allowed ONLY from Assigned Company Wi-Fi
  // --------------------------------------------------------------------------
  it('TC3: USER can access protected endpoints ONLY from assigned active Company Wi-Fi CIDR/IP', async () => {
    const plant2 = await createNetwork('Plant 2 Wi-Fi', PLANT2_CIDR);
    await setRolePolicy('user', 'RESTRICTED', [plant2.networkId]);
    await enableEnforcement();

    // Allowed from IP inside Plant 2 CIDR
    const allowedDash = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', PLANT2_HOST_IP);
    expect(allowedDash.status).toBe(200);

    const allowedScan = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', PLANT2_HOST_IP)
      .send({ rawPayload: 'QR_EMP001_VALID', scannerType: 'IN' });
    expect(allowedScan.status).toBe(200);

    // Blocked from IP outside Plant 2 CIDR
    const blockedDash = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', UNAUTHORIZED_IP);
    expect(blockedDash.status).toBe(403);
    expect(blockedDash.body.code).toBe(COMPANY_WIFI_DENIED_CODE);
  });

  // --------------------------------------------------------------------------
  // Test Case 4: ADMIN and USER Independent Allowed Wi-Fi Policies
  // --------------------------------------------------------------------------
  it('TC4: ADMIN and USER independently enforce distinct allowed Company Wi-Fi networks', async () => {
    const plant1 = await createNetwork('Plant 1 Admin Wi-Fi', PLANT1_IP);
    const plant2 = await createNetwork('Plant 2 Floor Wi-Fi', PLANT2_CIDR);

    await setRolePolicy('admin', 'RESTRICTED', [plant1.networkId]);
    await setRolePolicy('user', 'RESTRICTED', [plant2.networkId]);
    await enableEnforcement();

    // ADMIN allowed on Plant 1, denied on Plant 2
    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Forwarded-For', PLANT1_IP)
      ).status
    ).toBe(200);

    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Forwarded-For', PLANT2_HOST_IP)
      ).status
    ).toBe(403);

    // USER allowed on Plant 2, denied on Plant 1
    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${userToken}`)
          .set('X-Forwarded-For', PLANT2_HOST_IP)
      ).status
    ).toBe(200);

    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${userToken}`)
          .set('X-Forwarded-For', PLANT1_IP)
      ).status
    ).toBe(403);

    // Setting ADMIN to UNRESTRICTED leaves USER restricted
    await setRolePolicy('admin', 'UNRESTRICTED', []);
    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Forwarded-For', UNAUTHORIZED_IP)
      ).status
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${userToken}`)
          .set('X-Forwarded-For', UNAUTHORIZED_IP)
      ).status
    ).toBe(403);
  });

  // --------------------------------------------------------------------------
  // Test Case 5: Super Admin Management CRUD, Validation & Strict RBAC
  // --------------------------------------------------------------------------
  it('TC5: Super Admin manages Wi-Fi networks & policies; non-Super-Admin is denied (403); super_admin policy rejected (400)', async () => {
    // Reject private IP & duplicate IP
    const privateRes = await request(app)
      .post('/api/company-wifi/networks')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ networkName: 'Local LAN', ipOrCidr: '192.168.1.10', status: 'Active' });
    expect(privateRes.status).toBe(400);

    const net = await createNetwork('HQ IPv6 Wi-Fi', HQ_IPV6);
    expect(net.ipVersion).toBe('ipv6');

    const dupRes = await request(app)
      .post('/api/company-wifi/networks')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ networkName: 'Duplicate HQ', ipOrCidr: HQ_IPV6, status: 'Active' });
    expect(dupRes.status).toBe(409);

    // Edit network
    const editRes = await request(app)
      .put(`/api/company-wifi/networks/${net.networkId}`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ networkName: 'HQ Main Fiber Wi-Fi', ipOrCidr: PLANT1_IP, status: 'Active' });
    expect(editRes.status).toBe(200);
    expect(editRes.body.network.networkName).toBe('HQ Main Fiber Wi-Fi');
    expect(editRes.body.network.publicIp).toBe(PLANT1_IP);

    // Reject configuring super_admin policy
    const superPolicyRes = await request(app)
      .put('/api/company-wifi/policies/super_admin')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ accessMode: 'RESTRICTED', allowedNetworkIds: [net.networkId] });
    expect(superPolicyRes.status).toBe(400);

    // Non-Super-Admin (ADMIN and USER) blocked from all management endpoints
    const mgmtChecks: Array<{ method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; body?: any }> = [
      { method: 'get', path: '/api/company-wifi/dashboard' },
      { method: 'get', path: '/api/company-wifi/networks' },
      { method: 'post', path: '/api/company-wifi/networks', body: { networkName: 'Rogue', ipOrCidr: '203.0.113.55' } },
      { method: 'put', path: `/api/company-wifi/networks/${net.networkId}`, body: { networkName: 'Tampered' } },
      { method: 'patch', path: `/api/company-wifi/networks/${net.networkId}/status`, body: { status: 'Inactive' } },
      { method: 'delete', path: `/api/company-wifi/networks/${net.networkId}` },
      { method: 'put', path: '/api/company-wifi/policies/admin', body: { accessMode: 'UNRESTRICTED', allowedNetworkIds: [] } },
      { method: 'put', path: '/api/company-wifi/settings', body: { enforcementEnabled: false } },
      { method: 'post', path: '/api/company-wifi/emergency-disable' },
      { method: 'get', path: '/api/company-wifi/logs' },
    ];

    for (const token of [adminToken, userToken]) {
      for (const ep of mgmtChecks) {
        const reqBuilder = (request(app) as any)[ep.method](ep.path).set('Authorization', `Bearer ${token}`);
        const res = ep.body ? await reqBuilder.send(ep.body) : await reqBuilder;
        expect(res.status, `Expected 403 on ${ep.method.toUpperCase()} ${ep.path}`).toBe(403);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Test Case 6: Immediate Enforcement on Existing Active Sessions
  // --------------------------------------------------------------------------
  it('TC6: Policy edits apply immediately to existing authenticated sessions on their very next API call', async () => {
    const plant1 = await createNetwork('Plant 1 Wi-Fi', PLANT1_IP);
    await setRolePolicy('admin', 'RESTRICTED', [plant1.networkId]);
    await enableEnforcement();

    // Existing adminToken succeeds initially
    const first = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP);
    expect(first.status).toBe(200);

    // Super Admin removes Plant 1 from ADMIN policy
    await setRolePolicy('admin', 'RESTRICTED', []);

    // Very next request using the SAME adminToken is immediately blocked (403)
    const second = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP);
    expect(second.status).toBe(403);
    expect(second.body.code).toBe(COMPANY_WIFI_DENIED_CODE);

    // Super Admin adds Plant 1 back -> very next request succeeds again (200)
    await setRolePolicy('admin', 'RESTRICTED', [plant1.networkId]);
    const third = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP);
    expect(third.status).toBe(200);
  });

  // --------------------------------------------------------------------------
  // Test Case 7: Disabling or Deleting a Wi-Fi Network Immediately Revokes Access
  // --------------------------------------------------------------------------
  it('TC7: Disabling or deleting an assigned Company Wi-Fi network immediately revokes access and cleans policy references', async () => {
    const plant1 = await createNetwork('Plant 1 Wi-Fi', PLANT1_IP);
    await setRolePolicy('user', 'RESTRICTED', [plant1.networkId]);
    await enableEnforcement();

    // Initially allowed
    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${userToken}`)
          .set('X-Forwarded-For', PLANT1_IP)
      ).status
    ).toBe(200);

    // Disable network -> immediately blocked
    const disableRes = await request(app)
      .patch(`/api/company-wifi/networks/${plant1.networkId}/status`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ status: 'Inactive' });
    expect(disableRes.status).toBe(200);

    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${userToken}`)
          .set('X-Forwarded-For', PLANT1_IP)
      ).status
    ).toBe(403);

    // Re-enable -> allowed again
    await request(app)
      .patch(`/api/company-wifi/networks/${plant1.networkId}/status`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ status: 'Active' });

    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${userToken}`)
          .set('X-Forwarded-For', PLANT1_IP)
      ).status
    ).toBe(200);

    // Delete network -> immediately blocked and removed from USER policy
    const delRes = await request(app)
      .delete(`/api/company-wifi/networks/${plant1.networkId}`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(delRes.status).toBe(200);

    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${userToken}`)
          .set('X-Forwarded-For', PLANT1_IP)
      ).status
    ).toBe(403);

    const dash = await request(app)
      .get('/api/company-wifi/dashboard')
      .set('Authorization', `Bearer ${superToken}`);
    expect(dash.body.policies.user.allowedNetworkIds).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Test Case 8: Safe 403 Response Without Exposing Allowed IPs + Audit Logs
  // --------------------------------------------------------------------------
  it('TC8: Unauthorized IP gets safe 403 message without leaking allowed IPs and writes ACCESS_BLOCKED audit log', async () => {
    const secretPlant = await createNetwork('Secret Plant HQ Fiber', PLANT1_IP);
    await setRolePolicy('admin', 'RESTRICTED', [secretPlant.networkId]);
    await enableEnforcement();

    const blocked = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', UNAUTHORIZED_IP);

    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({
      success: false,
      code: COMPANY_WIFI_DENIED_CODE,
      error: COMPANY_WIFI_DENIED_MESSAGE,
    });

    const serialized = JSON.stringify(blocked.body);
    expect(serialized).not.toContain(PLANT1_IP);
    expect(serialized).not.toContain('Secret Plant HQ Fiber');
    expect(serialized).not.toContain(secretPlant.networkId);

    // Verify ACCESS_BLOCKED log is recorded and queryable by Super Admin
    const logsRes = await request(app)
      .get('/api/company-wifi/logs?eventType=ACCESS_BLOCKED')
      .set('Authorization', `Bearer ${superToken}`);
    expect(logsRes.status).toBe(200);
    expect(logsRes.body.logs.length).toBeGreaterThanOrEqual(1);
    expect(logsRes.body.logs[0].actorLoginId).toBe('admin');
    expect(logsRes.body.logs[0].observedIp).toBe(UNAUTHORIZED_IP);
    expect(logsRes.body.logs[0].result).toBe('Blocked');
  });

  // --------------------------------------------------------------------------
  // Test Case 9: Browser / Client Cannot Spoof Observed Public IP
  // --------------------------------------------------------------------------
  it('TC9: Client cannot spoof Public IP via request body, query params, or prepended leftmost X-Forwarded-For', async () => {
    const plant1 = await createNetwork('Plant 1 Wi-Fi', PLANT1_IP);
    await setRolePolicy('admin', 'RESTRICTED', [plant1.networkId]);
    await enableEnforcement();

    // Attacker prepends allowed IP to X-Forwarded-For while trusted proxy appends real unauthorized IP at right
    const spoofedXff = await request(app)
      .get(`/api/dashboard/summary?ip=${PLANT1_IP}&publicIp=${PLANT1_IP}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', `${PLANT1_IP}, ${UNAUTHORIZED_IP}`);
    expect(spoofedXff.status).toBe(403);

    // Attacker sends allowed IP in POST body & custom headers while x-vercel-forwarded-for reports real IP
    const spoofedBody = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP)
      .set('X-Vercel-Forwarded-For', UNAUTHORIZED_IP)
      .send({
        rawPayload: 'QR_EMP001_VALID',
        scannerType: 'IN',
        ip: PLANT1_IP,
        publicIp: PLANT1_IP,
        observedIp: PLANT1_IP,
      });
    expect(spoofedBody.status).toBe(403);
  });

  // --------------------------------------------------------------------------
  // Test Case 10: Empty Restricted Role Fails Closed & Enable Requires Confirmation
  // --------------------------------------------------------------------------
  it('TC10: Default enforcement is OFF, enabling requires explicit confirmation, and empty restricted role fails closed', async () => {
    // Initially OFF -> ADMIN & USER allowed even with empty network list
    const initialDash = await request(app)
      .get('/api/company-wifi/dashboard')
      .set('Authorization', `Bearer ${superToken}`);
    expect(initialDash.status).toBe(200);
    expect(initialDash.body.settings.enforcementEnabled).toBe(false);

    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Forwarded-For', UNAUTHORIZED_IP)
      ).status
    ).toBe(200);

    // Enabling without confirmEnable: true is rejected (400)
    const unconfirmed = await request(app)
      .put('/api/company-wifi/settings')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ enforcementEnabled: true });
    expect(unconfirmed.status).toBe(400);

    // Enable with confirmEnable: true -> empty RESTRICTED role fails closed (403)
    await enableEnforcement();
    const adminBlocked = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP);
    expect(adminBlocked.status).toBe(403);

    const userBlocked = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', PLANT1_IP);
    expect(userBlocked.status).toBe(403);
  });

  // --------------------------------------------------------------------------
  // Test Case 11: Super Admin Emergency Disable Never Blocked
  // --------------------------------------------------------------------------
  it('TC11: Super Admin emergency disable works from unauthorized IP and immediately restores access', async () => {
    await enableEnforcement();

    // ADMIN is blocked while enforcement is ON
    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Forwarded-For', UNAUTHORIZED_IP)
      ).status
    ).toBe(403);

    // Super Admin calls emergency-disable from unauthorized external IP
    const emergencyRes = await request(app)
      .post('/api/company-wifi/emergency-disable')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Forwarded-For', UNAUTHORIZED_IP);
    expect(emergencyRes.status).toBe(200);
    expect(emergencyRes.body.settings.enforcementEnabled).toBe(false);

    // ADMIN access is immediately restored on the next request
    expect(
      (
        await request(app)
          .get('/api/dashboard/summary')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Forwarded-For', UNAUTHORIZED_IP)
      ).status
    ).toBe(200);

    // Verify EMERGENCY_DISABLED log was written
    const logsRes = await request(app)
      .get('/api/company-wifi/logs?eventType=EMERGENCY_DISABLED')
      .set('Authorization', `Bearer ${superToken}`);
    expect(logsRes.status).toBe(200);
    expect(logsRes.body.logs.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Test Case 12: Existing Attendance, QR Scanning, Dashboard & Auth Remain Functional
  // --------------------------------------------------------------------------
  it('TC12: Existing QR attendance scan, session verification, and dashboard summary remain fully operational', async () => {
    const plant1 = await createNetwork('Plant 1 Wi-Fi', PLANT1_IP);
    await setRolePolicy('admin', 'RESTRICTED', [plant1.networkId]);
    await setRolePolicy('user', 'RESTRICTED', [plant1.networkId]);
    await enableEnforcement();

    // Session verification succeeds for ADMIN on authorized Company Wi-Fi
    const verifyRes = await request(app)
      .post('/api/auth/verify-session')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP)
      .send({ loginId: 'admin' });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);

    // QR Punch-In via USER on authorized Company Wi-Fi
    const punchIn = await request(app)
      .post('/api/attendance/scan')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Forwarded-For', PLANT1_IP)
      .send({ rawPayload: 'QR_EMP001_VALID', scannerType: 'IN' });
    expect(punchIn.status).toBe(200);
    expect(punchIn.body.success).toBe(true);

    // Dashboard summary reflects attendance smoothly
    const dash = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Forwarded-For', PLANT1_IP);
    expect(dash.status).toBe(200);
    expect(dash.body.success).toBe(true);
  });
});
