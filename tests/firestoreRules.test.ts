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
});
