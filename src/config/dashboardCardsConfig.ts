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
 * ROLE 1: SUPER_ADMIN
 * Shows all 12 dashboard cards:
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
 * 
 * ROLE 2: ADMIN
 * Shows ONLY these 6 dashboard cards:
 * 1. Active Total
 * 2. Total Present
 * 3. Absent
 * 4. OT Hours
 * 5. Auto Closed
 * 6. Missed Punch Out
 * 
 * Completely hidden from Admin:
 * - Currently Inside
 * - Currently Outside
 * - On Leave
 * - First IN
 * - Final OUT
 * - Duty Hours
 * 
 * ROLE 3: USER
 * 0 dashboard cards (Redirected to Attendance Scanner)
 */
export const ROLE_CARD_VISIBILITY: Record<'SUPER_ADMIN' | 'ADMIN' | 'USER', DashboardCardId[]> = {
  SUPER_ADMIN: [
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
  ],
  ADMIN: [
    'active_total',
    'total_present',
    'absent',
    'ot_hours',
    'auto_closed',
    'missed_punch_out',
  ],
  USER: [],
};

/**
 * Normalize role strings (case-insensitive and alias safe)
 */
export function normalizeUserRole(role?: UserRoleType | string | null): 'SUPER_ADMIN' | 'ADMIN' | 'USER' {
  if (!role) return 'USER';
  const clean = String(role).trim().toUpperCase();
  if (clean === 'SUPER_ADMIN' || clean === 'SUPERADMIN') return 'SUPER_ADMIN';
  if (clean === 'ADMIN') return 'ADMIN';
  return 'USER';
}

/**
 * Check if a specific card is allowed for a user's verified role
 */
export function isDashboardCardVisible(
  role: UserRoleType | string | null | undefined, 
  cardId: DashboardCardId
): boolean {
  const normalized = normalizeUserRole(role);
  const allowedCards = ROLE_CARD_VISIBILITY[normalized] || [];
  return allowedCards.includes(cardId);
}

/**
 * Get all permitted card IDs for a role
 */
export function getPermittedCardIdsForRole(
  role: UserRoleType | string | null | undefined
): DashboardCardId[] {
  const normalized = normalizeUserRole(role);
  return ROLE_CARD_VISIBILITY[normalized] || [];
}
