import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server.ts';
import {
  ALL_DASHBOARD_CARD_IDS,
  ALL_DASHBOARD_SECTION_IDS,
  DASHBOARD_CARDS,
  DASHBOARD_SECTIONS,
  DASHBOARD_VISIBILITY_KEYS,
  USER_LEGACY_DASHBOARD_CARD_IDS,
  resolveDashboardVisibility,
} from '../src/config/dashboardCardsConfig.ts';
import {
  InMemoryAdminAuth,
  InMemoryFirestore,
  TEST_CANONICAL_ACCOUNTS,
  seedIsolatedTestEnvironment,
} from './helpers/inMemoryAdmin.ts';

function buildExplicitVisibilityPayload(opts: {
  cards?: string[];
  sections?: string[];
  dashboardView?: boolean;
}) {
  const cardSet = new Set(opts.cards || []);
  const sectionSet = new Set(opts.sections || []);
  const payload: Record<string, { view: boolean; add: boolean; edit: boolean; delete: boolean }> = {
    dashboard: {
      view: opts.dashboardView !== undefined ? opts.dashboardView : true,
      add: false,
      edit: false,
      delete: false,
    },
    scanner: { view: true, add: false, edit: false, delete: false },
  };
  for (const card of DASHBOARD_CARDS) {
    payload[card.permissionKey] = {
      view: cardSet.has(card.id),
      add: false,
      edit: false,
      delete: false,
    };
  }
  for (const sec of DASHBOARD_SECTIONS) {
    payload[sec.permissionKey] = {
      view: sectionSet.has(sec.id),
      add: false,
      edit: false,
      delete: false,
    };
  }
  return payload;
}

describe('Dynamic Role-Based Dashboard Card & Section Visibility Permissions', () => {
  let db: InMemoryFirestore;
  let auth: InMemoryAdminAuth;
  let app: ReturnType<typeof createApp>['app'];

  beforeEach(async () => {
    db = new InMemoryFirestore();
    auth = new InMemoryAdminAuth();
    await seedIsolatedTestEnvironment(db, auth);

    // Seed sample employees, attendance, and roster leave data for today's summary metrics
    const today = new Date().toISOString().substring(0, 10);
    await db.collection('employees').doc('EMP001').set({
      employeeId: 'EMP001',
      employeeName: 'ANIL KUMAR',
      employeeStatus: 'Active',
    });
    await db.collection('employees').doc('EMP002').set({
      employeeId: 'EMP002',
      employeeName: 'SUNITA DEVI',
      employeeStatus: 'Active',
    });
    await db.collection('attendance').doc(`${today}_EMP001`).set({
      employeeId: 'EMP001',
      shiftDate: today,
      firstPunchIn: '09:00',
      punchIn: '09:00',
      lastPunchOut: '20:30',
      actualPunchOut: '20:30',
      punchOutType: 'ACTUAL',
      currentState: 'OUTSIDE',
      totalDutyMinutes: 690,
      regularDutyMinutes: 510,
      overtimeMinutes: 180,
      autoClosed: false,
      missedPunchOut: false,
    });
    await db.collection('shift_rosters').doc(`${today}_EMP002`).set({
      employeeId: 'EMP002',
      shiftDate: today,
      rosterStatus: 'LEAVE',
    });

    app = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    }).app;
  });

  it('preserves default built-in roles (zero extra seeded roles) and exact legacy visibility when unconfigured', async () => {
    const rolesSnap = await db.collection('roles').get();
    expect(rolesSnap.docs.filter((d) => !['super_admin', 'admin', 'user'].includes(d.id))).toEqual([]);

    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    const rolesListRes = await request(app)
      .get('/api/admin/roles')
      .set('Authorization', `Bearer ${superToken}`);
    expect(rolesListRes.status).toBe(200);
    expect(rolesListRes.body.roles.map((r: any) => r.roleId).sort()).toEqual([
      'admin',
      'super_admin',
      'user',
    ]);

    const [superDash, adminDash, userDash] = await Promise.all([
      request(app).get('/api/dashboard/summary').set('Authorization', `Bearer ${superToken}`),
      request(app).get('/api/dashboard/summary').set('Authorization', `Bearer ${adminToken}`),
      request(app).get('/api/dashboard/summary').set('Authorization', `Bearer ${userToken}`),
    ]);

    expect(superDash.status).toBe(200);
    expect(superDash.body.permittedCards).toEqual(ALL_DASHBOARD_CARD_IDS);
    expect(superDash.body.permittedSections).toEqual(ALL_DASHBOARD_SECTION_IDS);
    expect(Object.keys(superDash.body.metrics)).toHaveLength(12);

    expect(adminDash.status).toBe(200);
    expect(adminDash.body.permittedCards).toEqual(ALL_DASHBOARD_CARD_IDS);
    expect(adminDash.body.permittedSections).toEqual(ALL_DASHBOARD_SECTION_IDS);
    expect(Object.keys(adminDash.body.metrics)).toHaveLength(12);

    expect(userDash.status).toBe(200);
    expect(userDash.body.permittedCards).toEqual(USER_LEGACY_DASHBOARD_CARD_IDS);
    expect(userDash.body.permittedSections).toEqual(ALL_DASHBOARD_SECTION_IDS);
    expect(Object.keys(userDash.body.metrics).sort()).toEqual(
      ['absent', 'activeTotal', 'dutyHoursMins', 'missedPunchOut', 'otHoursMins', 'totalPresent'].sort()
    );
    expect(userDash.body.metrics.currentlyInside).toBeUndefined();
    expect(userDash.body.metrics.onLeave).toBeUndefined();
  });

  it('tests every single one of the 12 KPI cards enabled and disabled independently (resolver + API metrics filtering)', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    for (const targetCard of DASHBOARD_CARDS) {
      // 1. Enable ONLY targetCard (other 11 cards false)
      const singleCardPerms = buildExplicitVisibilityPayload({
        cards: [targetCard.id],
        sections: ALL_DASHBOARD_SECTION_IDS,
      });

      const resolvedOnly = resolveDashboardVisibility({
        role: 'admin',
        rolePermissions: singleCardPerms,
      });
      expect(resolvedOnly.permittedCards).toEqual([targetCard.id]);

      const saveOnlyRes = await request(app)
        .post('/api/admin/role-permissions')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ roleId: 'admin', modulePermissions: singleCardPerms });
      expect(saveOnlyRes.status).toBe(200);

      const dashOnlyRes = await request(app)
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(dashOnlyRes.status).toBe(200);
      expect(dashOnlyRes.body.permittedCards).toEqual([targetCard.id]);
      expect(Object.keys(dashOnlyRes.body.metrics)).toEqual([targetCard.metricKey]);
      expect(typeof dashOnlyRes.body.metrics[targetCard.metricKey]).toBe('number');

      // 2. Disable ONLY targetCard (other 11 cards true)
      const exceptCardIds = ALL_DASHBOARD_CARD_IDS.filter((id) => id !== targetCard.id);
      const exceptCardPerms = buildExplicitVisibilityPayload({
        cards: exceptCardIds,
        sections: ALL_DASHBOARD_SECTION_IDS,
      });

      const saveExceptRes = await request(app)
        .post('/api/admin/role-permissions')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ roleId: 'admin', modulePermissions: exceptCardPerms });
      expect(saveExceptRes.status).toBe(200);

      const dashExceptRes = await request(app)
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(dashExceptRes.status).toBe(200);
      expect(dashExceptRes.body.permittedCards).not.toContain(targetCard.id);
      expect(dashExceptRes.body.permittedCards).toHaveLength(11);
      expect(dashExceptRes.body.metrics[targetCard.metricKey]).toBeUndefined();
      expect(Object.keys(dashExceptRes.body.metrics)).toHaveLength(11);
    }
  });

  it('tests every single one of the 5 Dashboard sections enabled and disabled independently', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    for (const targetSection of DASHBOARD_SECTIONS) {
      // 1. Enable ONLY targetSection
      const singleSecPerms = buildExplicitVisibilityPayload({
        cards: USER_LEGACY_DASHBOARD_CARD_IDS,
        sections: [targetSection.id],
      });

      const resolvedOnly = resolveDashboardVisibility({
        role: 'user',
        rolePermissions: singleSecPerms,
      });
      expect(resolvedOnly.permittedSections).toEqual([targetSection.id]);

      const saveOnlyRes = await request(app)
        .post('/api/admin/role-permissions')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ roleId: 'user', modulePermissions: singleSecPerms });
      expect(saveOnlyRes.status).toBe(200);

      const dashOnlyRes = await request(app)
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${userToken}`);
      expect(dashOnlyRes.status).toBe(200);
      expect(dashOnlyRes.body.permittedSections).toEqual([targetSection.id]);

      // 2. Disable ONLY targetSection
      const exceptSectionIds = ALL_DASHBOARD_SECTION_IDS.filter((id) => id !== targetSection.id);
      const exceptSecPerms = buildExplicitVisibilityPayload({
        cards: USER_LEGACY_DASHBOARD_CARD_IDS,
        sections: exceptSectionIds,
      });

      const saveExceptRes = await request(app)
        .post('/api/admin/role-permissions')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ roleId: 'user', modulePermissions: exceptSecPerms });
      expect(saveExceptRes.status).toBe(200);

      const dashExceptRes = await request(app)
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${userToken}`);
      expect(dashExceptRes.status).toBe(200);
      expect(dashExceptRes.body.permittedSections).not.toContain(targetSection.id);
      expect(dashExceptRes.body.permittedSections).toHaveLength(4);
    }
  });

  it('supports Select All, Deselect All, parent Dashboard View cascade, and does not pollute user_roles.modulesAllowed', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);

    // 1. Deselect All (cards=[], sections=[], dashboard.view=true) -> 200 with zero cards, zero sections, empty metrics
    const deselectAllPerms = buildExplicitVisibilityPayload({
      cards: [],
      sections: [],
      dashboardView: true,
    });
    const deselectRes = await request(app)
      .post('/api/admin/role-permissions')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ roleId: 'admin', modulePermissions: deselectAllPerms });
    expect(deselectRes.status).toBe(200);

    const adminRoleAfter = await db.collection('user_roles').doc('role_admin').get();
    const modulesAllowed: string[] = adminRoleAfter.data()?.modulesAllowed || [];
    expect(modulesAllowed).toContain('dashboard');
    for (const visKey of DASHBOARD_VISIBILITY_KEYS) {
      expect(modulesAllowed).not.toContain(visKey);
    }

    const emptyDashRes = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(emptyDashRes.status).toBe(200);
    expect(emptyDashRes.body.permittedCards).toEqual([]);
    expect(emptyDashRes.body.permittedSections).toEqual([]);
    expect(emptyDashRes.body.metrics).toEqual({});

    // 2. Select All -> restores all 12 cards and 5 sections
    const selectAllPerms = buildExplicitVisibilityPayload({
      cards: ALL_DASHBOARD_CARD_IDS,
      sections: ALL_DASHBOARD_SECTION_IDS,
      dashboardView: true,
    });
    await request(app)
      .post('/api/admin/role-permissions')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ roleId: 'admin', modulePermissions: selectAllPerms })
      .expect(200);

    const fullDashRes = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(fullDashRes.status).toBe(200);
    expect(fullDashRes.body.permittedCards).toEqual(ALL_DASHBOARD_CARD_IDS);
    expect(fullDashRes.body.permittedSections).toEqual(ALL_DASHBOARD_SECTION_IDS);
    expect(Object.keys(fullDashRes.body.metrics)).toHaveLength(12);

    // 3. Parent dashboard.view = false cascades to deny /api/dashboard/summary with 403
    const deniedDashPerms = buildExplicitVisibilityPayload({
      cards: ALL_DASHBOARD_CARD_IDS,
      sections: ALL_DASHBOARD_SECTION_IDS,
      dashboardView: false,
    });
    await request(app)
      .post('/api/admin/role-permissions')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ roleId: 'admin', modulePermissions: deniedDashPerms })
      .expect(200);

    const deniedSummary = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deniedSummary.status).toBe(403);
    expect(deniedSummary.body.metrics).toBeUndefined();
  });

  it('persists visibility policies across logout/login, server restart, and per-user overrides without affecting Super Admin', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);

    // Configure distinct role defaults: User sees active_total + line_wise only
    await request(app)
      .post('/api/admin/role-permissions')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        roleId: 'user',
        modulePermissions: buildExplicitVisibilityPayload({
          cards: ['active_total'],
          sections: ['line_wise'],
        }),
      })
      .expect(200);

    // Simulate logout & fresh login + fresh Express app instance against the same Firestore store
    const freshApp = createApp({
      db,
      auth,
      projectId: 'narid-atdc-tracker',
      databaseId: 'ai-studio-manpowertracker-9b87a863-5c0d-4126-accb-7a3be802b10b',
      credentialMode: 'ADC',
      disableBackgroundBoot: true,
    }).app;

    const userLogin = await request(freshApp)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.88')
      .send({ loginId: 'user', password: TEST_CANONICAL_ACCOUNTS.user.password });
    expect(userLogin.status).toBe(200);

    const freshUserToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);
    const persistedUserDash = await request(freshApp)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${freshUserToken}`);
    expect(persistedUserDash.status).toBe(200);
    expect(persistedUserDash.body.permittedCards).toEqual(['active_total']);
    expect(persistedUserDash.body.permittedSections).toEqual(['line_wise']);
    expect(Object.keys(persistedUserDash.body.metrics)).toEqual(['activeTotal']);

    // Individual user override takes precedence cleanly over role defaults
    await request(freshApp)
      .post('/api/admin/set-user-permissions')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        targetId: 'role_user',
        permissions: buildExplicitVisibilityPayload({
          cards: ['total_present', 'currently_inside'],
          sections: ['shift_banner', 'department_wise'],
        }),
      })
      .expect(200);

    const overrideDash = await request(freshApp)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${freshUserToken}`);
    expect(overrideDash.status).toBe(200);
    expect(overrideDash.body.permittedCards).toEqual(['total_present', 'currently_inside']);
    expect(overrideDash.body.permittedSections).toEqual(['shift_banner', 'department_wise']);
    expect(Object.keys(overrideDash.body.metrics).sort()).toEqual(['currentlyInside', 'totalPresent']);

    // Super Admin cannot have visibility restricted
    const superBlocked = await request(freshApp)
      .post('/api/admin/role-permissions')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        roleId: 'super_admin',
        modulePermissions: buildExplicitVisibilityPayload({ cards: [], sections: [] }),
      });
    expect(superBlocked.status).toBe(400);

    const superDash = await request(freshApp)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${superToken}`);
    expect(superDash.status).toBe(200);
    expect(superDash.body.permittedCards).toEqual(ALL_DASHBOARD_CARD_IDS);
    expect(superDash.body.permittedSections).toEqual(ALL_DASHBOARD_SECTION_IDS);
  });

  it('blocks unauthorized role/user permission tampering (403) and preserves data isolation', async () => {
    const adminToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.admin.uid);
    const userToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.user.uid);

    for (const rogueToken of [adminToken, userToken]) {
      const r1 = await request(app)
        .post('/api/admin/role-permissions')
        .set('Authorization', `Bearer ${rogueToken}`)
        .send({
          roleId: 'user',
          modulePermissions: buildExplicitVisibilityPayload({
            cards: ALL_DASHBOARD_CARD_IDS,
            sections: ALL_DASHBOARD_SECTION_IDS,
          }),
        });
      expect(r1.status).toBe(403);

      const r2 = await request(app)
        .post('/api/admin/set-user-permissions')
        .set('Authorization', `Bearer ${rogueToken}`)
        .send({
          targetId: 'role_user',
          permissions: buildExplicitVisibilityPayload({
            cards: ALL_DASHBOARD_CARD_IDS,
            sections: ALL_DASHBOARD_SECTION_IDS,
          }),
        });
      expect(r2.status).toBe(403);

      const r3 = await request(app)
        .post('/api/admin/roles')
        .set('Authorization', `Bearer ${rogueToken}`)
        .send({
          roleId: 'custom_hacker',
          roleName: 'Hacker',
          description: 'Unauthorized role attempt',
        });
      expect(r3.status).toBe(403);
    }
  });

  it('supports future custom roles dynamically with independent Dashboard Card & Section visibility', async () => {
    const superToken = auth.issueToken(TEST_CANONICAL_ACCOUNTS.superadmin.uid);

    // 1. Create custom role with explicit subset of cards and sections
    const customDefaultPerms = {
      ...buildExplicitVisibilityPayload({
        cards: ['active_total', 'currently_inside', 'duty_hours'],
        sections: ['line_wise', 'section_wise'],
      }),
      reports: { view: true, add: false, edit: false, delete: false },
    };

    const createRoleRes = await request(app)
      .post('/api/admin/roles')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        roleName: 'Quality Supervisor',
        description: 'Isolated test fixture role for quality floor visibility',
        isActive: true,
        defaultPermissions: customDefaultPerms,
      });
    expect(createRoleRes.status).toBe(200);
    expect(createRoleRes.body.role.roleId).toBe('quality_supervisor');

    // 2. Create user bound to custom role and verify Dashboard Visibility works without code changes
    const createUserRes = await request(app)
      .post('/api/admin/create-user')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        loginId: 'qa_sup1',
        name: 'QA Supervisor One',
        email: 'qa_sup1@narid.com',
        role: 'quality_supervisor',
        password: 'QaSupStrong#2026',
        mustChangePassword: false,
      });
    expect(createUserRes.status).toBe(200);
    const qaUid = createUserRes.body.profile.authUid;
    expect(createUserRes.body.profile.modulesAllowed).toContain('dashboard');
    expect(createUserRes.body.profile.modulesAllowed).not.toContain('dashboard.card.active_total');

    const qaToken = auth.issueToken(qaUid);
    const qaDash = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${qaToken}`);
    expect(qaDash.status).toBe(200);
    expect(qaDash.body.role).toBe('QUALITY_SUPERVISOR');
    expect(qaDash.body.permittedCards).toEqual(['active_total', 'currently_inside', 'duty_hours']);
    expect(qaDash.body.permittedSections).toEqual(['line_wise', 'section_wise']);
    expect(Object.keys(qaDash.body.metrics).sort()).toEqual([
      'activeTotal',
      'currentlyInside',
      'dutyHoursMins',
    ]);
    expect(qaDash.body.metrics.otHoursMins).toBeUndefined();
    expect(qaDash.body.metrics.absent).toBeUndefined();
  });
});
