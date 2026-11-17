import { UserRoleType } from '../types';

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

/**
 * REUSABLE ROLE-BASED DASHBOARD CARD VISIBILITY MATRIX
 *
 * SUPER_ADMIN, ADMIN, and USER (Read-Only) share the same 12 attendance monitoring cards:
 * 1. Active Total
 * 2. Total Present
 * 3. Currently Inside
 * 4. Currently Outside
 * 5. Absent
 * 6. On Leave
 * 7. First IN
 * 8. Final OUT
 * 9. Duty Hours
 * 10. OT Hours
 * 11. Auto Closed
 * 12. Missed Punch Out
 */
const ALL_DASHBOARD_CARDS: DashboardCardId[] = [
  'active_total',
  'total_present',
  'currently_inside',
  'currently_outside',
  'absent',
  'on_leave',
  'first_in',
  'final_out',
  'duty_hours',
  'ot_hours',
  'auto_closed',
  'missed_punch_out',
];

const USER_DASHBOARD_CARDS: DashboardCardId[] = [
  'active_total',
  'total_present',
  'absent',
  'duty_hours',
  'ot_hours',
  'missed_punch_out',
];

export const ROLE_CARD_VISIBILITY: Record<string, DashboardCardId[]> = {
  SUPER_ADMIN: ALL_DASHBOARD_CARDS,
  ADMIN: ALL_DASHBOARD_CARDS,
  USER: USER_DASHBOARD_CARDS,
};

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
 * Check if a specific card is allowed for a user's verified role and module permissions
 */
export function isDashboardCardVisible(
  role: UserRoleType | string | null | undefined,
  cardId: DashboardCardId,
  modulesAllowed?: string[] | null,
  rolePermissions?: Record<string, { view?: boolean }> | null
): boolean {
  const allowedCards = getPermittedCardIdsForRole(role, modulesAllowed, rolePermissions);
  return allowedCards.includes(cardId);
}

/**
 * Get all permitted card IDs for a role (exact legacy sets for SUPER_ADMIN, ADMIN, USER;
 * dynamic permission-aware cards for future custom roles)
 */
export function getPermittedCardIdsForRole(
  role: UserRoleType | string | null | undefined,
  modulesAllowed?: string[] | null,
  rolePermissions?: Record<string, { view?: boolean }> | null
): DashboardCardId[] {
  const normalized = normalizeUserRole(role);
  if (ROLE_CARD_VISIBILITY[normalized]) {
    return ROLE_CARD_VISIBILITY[normalized];
  }

  const mods = Array.isArray(modulesAllowed) ? modulesAllowed.map((m) => String(m).toLowerCase()) : [];
  const hasOperationalAnalytics =
    mods.includes('all') ||
    mods.includes('reports') ||
    mods.includes('history') ||
    mods.includes('employees') ||
    mods.includes('shifts') ||
    Boolean(
      rolePermissions?.reports?.view ||
        rolePermissions?.history?.view ||
        rolePermissions?.employees?.view ||
        rolePermissions?.shifts?.view
    );

  return hasOperationalAnalytics ? ALL_DASHBOARD_CARDS : USER_DASHBOARD_CARDS;
}
