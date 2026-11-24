import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const rulesContent = fs.readFileSync(rulesPath, 'utf-8');

function extractMatchBlock(collectionName: string): string {
  const marker = `match /${collectionName}/`;
  const idx = rulesContent.indexOf(marker);
  expect(idx, `Missing match block for collection "${collectionName}"`).toBeGreaterThan(-1);

  const wildcardEnd = rulesContent.indexOf('}', idx);
  expect(wildcardEnd).toBeGreaterThan(idx);
  const openBrace = rulesContent.indexOf('{', wildcardEnd);
  let depth = 0;
  for (let i = openBrace; i < rulesContent.length; i++) {
    if (rulesContent[i] === '{') depth++;
    if (rulesContent[i] === '}') {
      depth--;
      if (depth === 0) {
        return rulesContent.slice(idx, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces for match /${collectionName}/`);
}

describe('Firestore Security Rules (Strict Zero-Trust UID RBAC)', () => {
  it('contains zero email-based privilege bypasses or hardcoded emails', () => {
    expect(rulesContent).not.toContain('request.auth.token.email');
    expect(rulesContent).not.toContain('officialnarid');
    expect(rulesContent).not.toContain('@narid.com');
    expect(rulesContent).not.toContain('.email ==');
  });

  it('uses UID-only user_uid_index and user_roles/$(request.auth.uid) helpers', () => {
    expect(rulesContent).toContain('user_uid_index/$(request.auth.uid)');
    expect(rulesContent).toContain('user_roles/$(request.auth.uid)');
    expect(rulesContent).toContain('function isNotLocked()');
    expect(rulesContent).toContain("lockStatus != 'LOCKED'");
  });

  it('blocks direct client writes to attendance, punch_events, punch_logs, and shift_rosters', () => {
    for (const col of ['attendance', 'punch_events', 'punch_logs', 'shift_rosters']) {
      const block = extractMatchBlock(col);
      expect(block).toMatch(/allow\s+create,\s*update,\s*delete:\s*if\s+false;/);
    }
  });

  it('blocks all direct client writes to user_uid_index, user_roles, roles, permissions, and audit/security ledgers', () => {
    const serverOnlyCollections = [
      'user_uid_index',
      'user_roles',
      'roles',
      'user_permissions',
      'role_permissions',
      'audit_logs',
      'login_history',
      'audit_archives',
      'audit_log_deletions',
      'password_reset_logs',
      'account_security',
      'login_attempts',
      'security_audit_logs',
    ];
    for (const col of serverOnlyCollections) {
      const block = extractMatchBlock(col);
      expect(block).toMatch(/allow\s+create,\s*update,\s*delete:\s*if\s+false;/);
    }
  });

  it('denies all client read and write access to ip_rate_limits and includes catch-all deny', () => {
    const rateBlock = extractMatchBlock('ip_rate_limits');
    expect(rateBlock).toMatch(/allow\s+read,\s*write:\s*if\s+false;/);
    expect(rulesContent).toMatch(/match \/\{document=\*\*\}[\s\S]*allow\s+read,\s*write:\s*if\s+false;/);
  });

  it('blocks direct client writes to all 4 Company Wi-Fi Access Control collections and restricts reads to Super Admin', () => {
    const companyWifiCollections = [
      'company_wifi_networks',
      'company_wifi_access_policies',
      'company_wifi_settings',
      'company_wifi_access_logs',
    ];
    for (const col of companyWifiCollections) {
      const block = extractMatchBlock(col);
      expect(block).toMatch(/allow\s+(?:read|list,\s*get|get,\s*list):\s*if\s+isSuperAdmin\(\);/);
      expect(block).toMatch(/allow\s+create,\s*update,\s*delete:\s*if\s+false;/);
    }
  });

  it('blocks direct client writes to technical_error_logs and restricts reads to Super Admin', () => {
    const block = extractMatchBlock('technical_error_logs');
    expect(block).toMatch(/allow\s+(?:read|list,\s*get|get,\s*list):\s*if\s+isSuperAdmin\(\);/);
    expect(block).toMatch(/allow\s+create,\s*update,\s*delete:\s*if\s+false;/);
  });

  it('supports future dynamic roles via active-role and role_permissions helpers without unapproved hardcoded future roles', () => {
    expect(rulesContent).toContain('function callerRoleId()');
    expect(rulesContent).toContain('function isRoleActive()');
    expect(rulesContent).toContain('function hasRoleModuleAction(mod, act)');
    expect(rulesContent).toContain(
      "!(mod in ['user_rights', 'audit_logs', 'security_management', 'company_wifi_access'])"
    );
    expect(rulesContent).toContain("isSystemRole(callerRoleId())");

    // Verify dynamic role module action wiring for operational master collections
    const employeesBlock = extractMatchBlock('employees');
    expect(employeesBlock).toContain("hasRoleModuleAction('employees', 'add')");
    expect(employeesBlock).toContain("hasRoleModuleAction('employees', 'edit')");
    expect(employeesBlock).toContain("hasRoleModuleAction('employees', 'delete')");

    const shiftsBlock = extractMatchBlock('shifts');
    expect(shiftsBlock).toContain("hasRoleModuleAction('shifts', 'add')");

    // Verify no unapproved future roles are hardcoded in security rules
    const lowerRules = rulesContent.toLowerCase();
    for (const unapproved of ['supervisor', 'production', 'quality']) {
      expect(lowerRules).not.toContain(`'${unapproved}'`);
    }
  });
});
