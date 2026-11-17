import type { UserRoleType } from '../types/index.ts';

export type DashboardCardId =
  | 'active_total'
  | 'total_present'
  | 'currently_inside'
  | 'currently_outside'
  | 'absent'
  | 'on_leave'
  | 'first_in'
  | 'final_out'
  | 'duty_hours'
  | 'ot_hours'
  | 'auto_closed'
  | 'missed_punch_out';

export type DashboardSectionId =
  | 'shift_banner'
  | 'line_wise'
  | 'section_wise'
  | 'department_wise'
  | 'employee_type_wise';

export type DashboardSummaryMetricKey =
  | 'activeTotal'
  | 'totalPresent'
  | 'currentlyInside'
  | 'currentlyOutside'
  | 'absent'
  | 'onLeave'
  | 'firstIn'
  | 'finalOut'
  | 'dutyHoursMins'
  | 'otHoursMins'
  | 'autoClosed'
  | 'missedPunchOut';

export interface DashboardCardDefinition {
  id: DashboardCardId;
  permissionKey: `dashboard.card.${DashboardCardId}`;
  metricKey: DashboardSummaryMetricKey;
  label: string;
  description: string;
}

export interface DashboardSectionDefinition {
  id: DashboardSectionId;
  permissionKey: `dashboard.section.${DashboardSectionId}`;
  label: string;
  description: string;
  isBreakdownReport: boolean;
}

export const DASHBOARD_CARDS: readonly DashboardCardDefinition[] = [
  {
    id: 'active_total',
    permissionKey: 'dashboard.card.active_total',
    metricKey: 'activeTotal',
    label: 'Active Total',
    description: 'Total active registered employees matching selected filters',
  },
  {
    id: 'total_present',
    permissionKey: 'dashboard.card.total_present',
    metricKey: 'totalPresent',
    label: 'Total Present',
    description: 'Employees with recorded attendance on the selected date',
  },
  {
    id: 'currently_inside',
    permissionKey: 'dashboard.card.currently_inside',
    metricKey: 'currentlyInside',
    label: 'Currently Inside',
    description: 'Employees currently inside factory without a punch out',
  },
  {
    id: 'currently_outside',
    permissionKey: 'dashboard.card.currently_outside',
    metricKey: 'currentlyOutside',
    label: 'Currently Outside',
    description: 'Employees who have punched out / exited the factory',
  },
  {
    id: 'absent',
    permissionKey: 'dashboard.card.absent',
    metricKey: 'absent',
    label: 'Absent',
    description: 'Active scheduled employees with no attendance punches',
  },
  {
    id: 'on_leave',
    permissionKey: 'dashboard.card.on_leave',
    metricKey: 'onLeave',
    label: 'On Leave',
    description: 'Employees marked on sanctioned leave in shift roster',
  },
  {
    id: 'first_in',
    permissionKey: 'dashboard.card.first_in',
    metricKey: 'firstIn',
    label: 'First In',
    description: 'Count of initial entry punches recorded for the shift',
  },
  {
    id: 'final_out',
    permissionKey: 'dashboard.card.final_out',
    metricKey: 'finalOut',
    label: 'Final Out',
    description: 'Count of actual final exit punches scanned',
  },
  {
    id: 'duty_hours',
    permissionKey: 'dashboard.card.duty_hours',
    metricKey: 'dutyHoursMins',
    label: 'Duty Hours',
    description: 'Cumulative regular duty hours (also governs Duty column in drilldown)',
  },
  {
    id: 'ot_hours',
    permissionKey: 'dashboard.card.ot_hours',
    metricKey: 'otHoursMins',
    label: 'OT Hours',
    description: 'Cumulative overtime hours beyond 08:30 (also governs OT in drilldown)',
  },
  {
    id: 'auto_closed',
    permissionKey: 'dashboard.card.auto_closed',
    metricKey: 'autoClosed',
    label: 'Auto Closed',
    description: 'Attendance records automatically closed at shift end',
  },
  {
    id: 'missed_punch_out',
    permissionKey: 'dashboard.card.missed_punch_out',
    metricKey: 'missedPunchOut',
    label: 'Missed Punch Out',
    description: 'Employees flagged for missing exit punch with zero OT',
  },
] as const;

export const DASHBOARD_SECTIONS: readonly DashboardSectionDefinition[] = [
  {
    id: 'shift_banner',
    permissionKey: 'dashboard.section.shift_banner',
    label: 'Automatic Shift Allocation & Auto-Closing Banner',
    description: 'Displays automatic shift timings, auto-closing status badge, and quick scanner shortcut',
    isBreakdownReport: false,
  },
  {
    id: 'line_wise',
    permissionKey: 'dashboard.section.line_wise',
    label: 'Line-Wise Manpower Availability',
    description: 'Production line breakdown table showing active, present, absent, and availability %',
    isBreakdownReport: true,
  },
  {
    id: 'section_wise',
    permissionKey: 'dashboard.section.section_wise',
    label: 'Section-Wise Manpower Availability',
    description: 'Section breakdown table (MI, SMT, FATP, STORE) with manpower availability',
    isBreakdownReport: true,
  },
  {
    id: 'department_wise',
    permissionKey: 'dashboard.section.department_wise',
    label: 'Department-Wise Manpower Availability',
    description: 'Department breakdown table (Production, Quality, PPC, R&D, etc.)',
    isBreakdownReport: true,
  },
  {
    id: 'employee_type_wise',
    permissionKey: 'dashboard.section.employee_type_wise',
    label: 'Employee-Type Manpower Availability',
    description: 'Manpower availability grouped by Permanent, Staff, and Offroll categories',
    isBreakdownReport: true,
  },
] as const;

export const ALL_DASHBOARD_CARD_IDS: DashboardCardId[] = DASHBOARD_CARDS.map((c) => c.id);

export const USER_LEGACY_DASHBOARD_CARD_IDS: DashboardCardId[] = [
  'active_total',
  'total_present',
  'absent',
  'duty_hours',
  'ot_hours',
  'missed_punch_out',
];

export const ALL_DASHBOARD_SECTION_IDS: DashboardSectionId[] = DASHBOARD_SECTIONS.map((s) => s.id);

export const DASHBOARD_CARD_PERMISSION_KEYS = new Set<string>(
  DASHBOARD_CARDS.map((c) => c.permissionKey)
);

export const DASHBOARD_SECTION_PERMISSION_KEYS = new Set<string>(
  DASHBOARD_SECTIONS.map((s) => s.permissionKey)
);

export const DASHBOARD_VISIBILITY_KEYS = new Set<string>([
  ...DASHBOARD_CARD_PERMISSION_KEYS,
  ...DASHBOARD_SECTION_PERMISSION_KEYS,
]);

export const ROLE_CARD_VISIBILITY: Record<string, DashboardCardId[]> = {
  SUPER_ADMIN: ALL_DASHBOARD_CARD_IDS,
  ADMIN: ALL_DASHBOARD_CARD_IDS,
  USER: USER_LEGACY_DASHBOARD_CARD_IDS,
};

export interface DashboardPermissionEntry {
  view?: boolean;
  add?: boolean;
  edit?: boolean;
  delete?: boolean;
}

export interface ResolveDashboardVisibilityParams {
  role?: UserRoleType | string | null;
  modulesAllowed?: string[] | null;
  rolePermissions?: Record<string, DashboardPermissionEntry> | null;
  roleDefaultPermissions?: Record<string, DashboardPermissionEntry> | null;
  userPermissionOverride?: {
    isCustomOverride?: boolean;
    permissions?: Record<string, DashboardPermissionEntry> | null;
  } | null;
}

export interface ResolvedDashboardVisibility {
  dashboardViewAllowed: boolean;
  permittedCards: DashboardCardId[];
  permittedSections: DashboardSectionId[];
  explicitCardKeys: Partial<Record<DashboardCardId, boolean>>;
  explicitSectionKeys: Partial<Record<DashboardSectionId, boolean>>;
}

/**
 * Normalize role strings (preserves custom role identifiers cleanly)
 */
export function normalizeUserRole(role?: UserRoleType | string | null): string {
  if (!role) return 'USER';
  const clean = String(role).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (clean === 'SUPER_ADMIN' || clean === 'SUPERADMIN') return 'SUPER_ADMIN';
  if (clean === 'ADMIN') return 'ADMIN';
  if (clean === 'USER') return 'USER';
  return clean || 'USER';
}

/**
 * Authoritative dynamic resolver for Dashboard KPI Card & Section visibility.
 * Precedence order (identical on frontend and backend):
 * 1. SUPER_ADMIN -> all 12 cards and all 5 sections enabled unconditionally
 * 2. Parent `dashboard.view` check (user override -> role permissions -> modulesAllowed -> legacy role)
 * 3. Per-key explicit check: user_permissions override -> role_permissions[role] -> role.defaultPermissions
 * 4. Unconfigured legacy fallback per role (preserves existing Admin 12-card / User 6-card / all-5-sections behavior)
 */
export function resolveDashboardVisibility(
  params: ResolveDashboardVisibilityParams
): ResolvedDashboardVisibility {
  const {
    role,
    modulesAllowed,
    rolePermissions,
    roleDefaultPermissions,
    userPermissionOverride,
  } = params;

  const normalized = normalizeUserRole(role);
  if (normalized === 'SUPER_ADMIN') {
    const explicitCardKeys: Partial<Record<DashboardCardId, boolean>> = {};
    ALL_DASHBOARD_CARD_IDS.forEach((id) => {
      explicitCardKeys[id] = true;
    });
    const explicitSectionKeys: Partial<Record<DashboardSectionId, boolean>> = {};
    ALL_DASHBOARD_SECTION_IDS.forEach((id) => {
      explicitSectionKeys[id] = true;
    });
    return {
      dashboardViewAllowed: true,
      permittedCards: [...ALL_DASHBOARD_CARD_IDS],
      permittedSections: [...ALL_DASHBOARD_SECTION_IDS],
      explicitCardKeys,
      explicitSectionKeys,
    };
  }

  const hasUserOverride =
    Boolean(userPermissionOverride) && userPermissionOverride?.isCustomOverride !== false;
  const userPerms = hasUserOverride ? userPermissionOverride?.permissions || {} : null;
  const effectiveRolePerms = rolePermissions || roleDefaultPermissions || null;
  const mods = Array.isArray(modulesAllowed)
    ? modulesAllowed.map((m) => String(m).trim().toLowerCase())
    : [];

  let dashboardViewAllowed: boolean;
  if (userPerms?.dashboard && typeof userPerms.dashboard.view === 'boolean') {
    dashboardViewAllowed = userPerms.dashboard.view;
  } else if (
    effectiveRolePerms?.dashboard &&
    typeof effectiveRolePerms.dashboard.view === 'boolean'
  ) {
    dashboardViewAllowed = effectiveRolePerms.dashboard.view;
  } else if (mods.length > 0) {
    dashboardViewAllowed = mods.includes('all') || mods.includes('dashboard');
  } else {
    dashboardViewAllowed = normalized === 'ADMIN' || normalized === 'USER';
  }

  if (!dashboardViewAllowed) {
    return {
      dashboardViewAllowed: false,
      permittedCards: [],
      permittedSections: [],
      explicitCardKeys: {},
      explicitSectionKeys: {},
    };
  }

  let fallbackCardIds: DashboardCardId[];
  if (normalized === 'ADMIN') {
    fallbackCardIds = ALL_DASHBOARD_CARD_IDS;
  } else if (normalized === 'USER') {
    fallbackCardIds = USER_LEGACY_DASHBOARD_CARD_IDS;
  } else {
    const hasOperationalAnalytics =
      mods.includes('all') ||
      mods.includes('reports') ||
      mods.includes('history') ||
      mods.includes('employees') ||
      mods.includes('shifts') ||
      Boolean(
        effectiveRolePerms?.reports?.view ||
          effectiveRolePerms?.history?.view ||
          effectiveRolePerms?.employees?.view ||
          effectiveRolePerms?.shifts?.view ||
          userPerms?.reports?.view ||
          userPerms?.history?.view ||
          userPerms?.employees?.view ||
          userPerms?.shifts?.view
      );
    fallbackCardIds = hasOperationalAnalytics
      ? ALL_DASHBOARD_CARD_IDS
      : USER_LEGACY_DASHBOARD_CARD_IDS;
  }

  const fallbackCardSet = new Set<DashboardCardId>(fallbackCardIds);
  const permittedCards: DashboardCardId[] = [];
  const explicitCardKeys: Partial<Record<DashboardCardId, boolean>> = {};

  for (const card of DASHBOARD_CARDS) {
    const userEntry = userPerms?.[card.permissionKey];
    const roleEntry = effectiveRolePerms?.[card.permissionKey];

    let allowed: boolean;
    if (userEntry && typeof userEntry.view === 'boolean') {
      allowed = userEntry.view;
      explicitCardKeys[card.id] = true;
    } else if (roleEntry && typeof roleEntry.view === 'boolean') {
      allowed = roleEntry.view;
      explicitCardKeys[card.id] = true;
    } else {
      allowed = fallbackCardSet.has(card.id);
    }

    if (allowed) {
      permittedCards.push(card.id);
    }
  }

  const permittedSections: DashboardSectionId[] = [];
  const explicitSectionKeys: Partial<Record<DashboardSectionId, boolean>> = {};

  for (const section of DASHBOARD_SECTIONS) {
    const userEntry = userPerms?.[section.permissionKey];
    const roleEntry = effectiveRolePerms?.[section.permissionKey];

    let allowed: boolean;
    if (userEntry && typeof userEntry.view === 'boolean') {
      allowed = userEntry.view;
      explicitSectionKeys[section.id] = true;
    } else if (roleEntry && typeof roleEntry.view === 'boolean') {
      allowed = roleEntry.view;
      explicitSectionKeys[section.id] = true;
    } else {
      allowed = true;
    }

    if (allowed) {
      permittedSections.push(section.id);
    }
  }

  return {
    dashboardViewAllowed: true,
    permittedCards,
    permittedSections,
    explicitCardKeys,
    explicitSectionKeys,
  };
}

/**
 * Check if a specific card is allowed for a user's verified role and permissions
 */
export function isDashboardCardVisible(
  role: UserRoleType | string | null | undefined,
  cardId: DashboardCardId,
  modulesAllowed?: string[] | null,
  rolePermissions?: Record<string, DashboardPermissionEntry> | null,
  userPermissionOverride?: {
    isCustomOverride?: boolean;
    permissions?: Record<string, DashboardPermissionEntry> | null;
  } | null
): boolean {
  const { permittedCards } = resolveDashboardVisibility({
    role,
    modulesAllowed,
    rolePermissions,
    userPermissionOverride,
  });
  return permittedCards.includes(cardId);
}

/**
 * Check if a specific dashboard section is allowed for a user's verified role and permissions
 */
export function isDashboardSectionVisible(
  role: UserRoleType | string | null | undefined,
  sectionId: DashboardSectionId,
  modulesAllowed?: string[] | null,
  rolePermissions?: Record<string, DashboardPermissionEntry> | null,
  userPermissionOverride?: {
    isCustomOverride?: boolean;
    permissions?: Record<string, DashboardPermissionEntry> | null;
  } | null
): boolean {
  const { permittedSections } = resolveDashboardVisibility({
    role,
    modulesAllowed,
    rolePermissions,
    userPermissionOverride,
  });
  return permittedSections.includes(sectionId);
}

/**
 * Get all permitted card IDs for a role using explicit Dashboard Visibility permissions
 * with clean backward-compatible fallback when keys are unconfigured.
 */
export function getPermittedCardIdsForRole(
  role: UserRoleType | string | null | undefined,
  modulesAllowed?: string[] | null,
  rolePermissions?: Record<string, DashboardPermissionEntry> | null,
  userPermissionOverride?: {
    isCustomOverride?: boolean;
    permissions?: Record<string, DashboardPermissionEntry> | null;
  } | null
): DashboardCardId[] {
  return resolveDashboardVisibility({
    role,
    modulesAllowed,
    rolePermissions,
    userPermissionOverride,
  }).permittedCards;
}
