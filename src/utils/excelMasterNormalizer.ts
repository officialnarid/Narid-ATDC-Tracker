/**
 * Shared Case-Insensitive & Unicode-Normalized Master Data Matcher
 *
 * Used by BOTH the Frontend Excel Import Preview and the Backend Bulk Import API
 * to guarantee identical normalization, canonical website capitalization preservation,
 * master ID resolution, and ambiguity detection.
 */

export interface MasterRecordOption {
  id: string;
  name: string;
  code?: string;
  status?: string;
}

export type MasterFieldKey =
  | 'department'
  | 'section'
  | 'floor'
  | 'employeeType'
  | 'employeeStatus'
  | 'designation';

export const MASTER_FIELD_LABELS: Record<MasterFieldKey, string> = {
  department: 'Department',
  section: 'Section',
  floor: 'Line / Floor',
  employeeType: 'Employee Type',
  employeeStatus: 'Status',
  designation: 'Designation',
};

export const CANONICAL_EMPLOYEE_TYPES: MasterRecordOption[] = [
  { id: 'type_permanent', name: 'Permanent', code: 'PERMANENT', status: 'Active' },
  { id: 'type_staff', name: 'Staff', code: 'STAFF', status: 'Active' },
  { id: 'type_offroll', name: 'Offroll', code: 'OFFROLL', status: 'Active' },
];

export const CANONICAL_EMPLOYEE_STATUSES: MasterRecordOption[] = [
  { id: 'status_active', name: 'Active', code: 'ACTIVE', status: 'Active' },
  { id: 'status_inactive', name: 'Inactive', code: 'INACTIVE', status: 'Active' },
];

export const DEFAULT_CANONICAL_FLOORS: MasterRecordOption[] = [
  { id: 'line_mi_01', name: 'MI-01', code: 'MI-01', status: 'Active' },
  { id: 'line_mi_02', name: 'MI-02', code: 'MI-02', status: 'Active' },
  { id: 'line_fatp_stb', name: 'FATP-STB', code: 'FATP-STB', status: 'Active' },
  { id: 'line_fatp_itr', name: 'FATP-ITR', code: 'FATP-ITR', status: 'Active' },
  { id: 'line_smt_01', name: 'SMT-01', code: 'SMT-01', status: 'Active' },
];

export const DEFAULT_CANONICAL_SECTIONS: MasterRecordOption[] = [
  { id: 'sec_mi', name: 'MI', code: 'MI', status: 'Active' },
  { id: 'sec_smt', name: 'SMT', code: 'SMT', status: 'Active' },
  { id: 'sec_fatp', name: 'FATP', code: 'FATP', status: 'Active' },
  { id: 'sec_store', name: 'STORE', code: 'STORE', status: 'Active' },
];

export const DEFAULT_CANONICAL_DEPARTMENTS: MasterRecordOption[] = [
  { id: 'dept_prod', name: 'Production', code: 'PROD', status: 'Active' },
  { id: 'dept_qual', name: 'Quality', code: 'QC', status: 'Active' },
  { id: 'dept_store', name: 'Store', code: 'STORE', status: 'Active' },
  { id: 'dept_ppc', name: 'PPC', code: 'PPC', status: 'Active' },
  { id: 'dept_rd', name: 'R&D', code: 'RD', status: 'Active' },
  { id: 'dept_oth', name: 'Others', code: 'OTH', status: 'Active' },
];

export interface AmbiguousMasterCandidate {
  id: string;
  name: string;
  code?: string;
}

export interface MasterMatchResult {
  status: 'MATCHED' | 'AMBIGUOUS' | 'UNMATCHED';
  originalValue: string;
  trimmedValue: string;
  canonicalValue: string | null;
  masterId: string | null;
  wasNormalized: boolean;
  caseNormalized: boolean;
  whitespaceNormalized: boolean;
  matchedBy: 'name' | 'code' | 'none';
  ambiguousCandidates: AmbiguousMasterCandidate[];
}

export interface FieldNormalizationInfo {
  field: MasterFieldKey;
  fieldLabel: string;
  originalValue: string;
  trimmedValue: string;
  canonicalValue: string;
  masterId: string | null;
  wasNormalized: boolean;
  caseNormalized: boolean;
  whitespaceNormalized: boolean;
  matchedBy: 'name' | 'code' | 'none';
}

export interface NormalizationMappingEntry {
  field: MasterFieldKey;
  fieldLabel: string;
  excelValue: string;
  canonicalValue: string;
  masterId: string | null;
  caseNormalized: boolean;
  whitespaceNormalized: boolean;
  matchStatus: 'MATCHED';
  occurrenceCount: number;
}

export interface AmbiguousMasterConflict {
  field: MasterFieldKey;
  fieldLabel: string;
  excelValue: string;
  rowNumbers: number[];
  candidates: AmbiguousMasterCandidate[];
}

/**
 * Normalizes whitespace and applies canonical Unicode NFC normalization WITHOUT changing
 * character casing (used for preserving free-text fields like Employee Name and display labels).
 */
export function normalizeWhitespaceAndUnicode(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .normalize('NFC')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produces a deterministic, case-insensitive, whitespace-normalized, Unicode NFKC lookup key
 * for comparing controlled master-data values (Department, Section, Line/Floor, Designation, Type, Status).
 */
export function normalizeMasterLookupKey(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .normalize('NFKC')
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

/**
 * Converts either full MasterRecordOption[] or legacy string[] into MasterRecordOption[]
 * without collapsing distinct duplicate entries (preserving ambiguity detection!).
 */
export function toMasterRecordOptions(
  records: ReadonlyArray<MasterRecordOption | string>
): MasterRecordOption[] {
  const out: MasterRecordOption[] = [];
  const seenExactIds = new Set<string>();

  records.forEach((item, idx) => {
    if (typeof item === 'string') {
      const cleanName = normalizeWhitespaceAndUnicode(item);
      if (!cleanName) return;
      out.push({
        id: `legacy_${idx}_${cleanName}`,
        name: cleanName,
      });
      return;
    }

    if (!item || typeof item !== 'object') return;
    const cleanName = normalizeWhitespaceAndUnicode(item.name);
    if (!cleanName) return;
    const cleanId = String(item.id || `master_${idx}`).trim();
    if (seenExactIds.has(cleanId)) return;
    seenExactIds.add(cleanId);

    out.push({
      id: cleanId,
      name: cleanName,
      code: item.code ? normalizeWhitespaceAndUnicode(item.code) : undefined,
      status: item.status ? String(item.status) : undefined,
    });
  });

  return out;
}

export interface MasterLookupIndex {
  options: MasterRecordOption[];
  byNormalizedName: Map<string, MasterRecordOption[]>;
  byNormalizedCode: Map<string, MasterRecordOption[]>;
}

/**
 * Builds an in-memory case-insensitive lookup index for a master-data collection.
 * Preserves ALL colliding records under the same normalized key so ambiguity is explicitly flagged.
 */
export function buildMasterLookupIndex(
  records: ReadonlyArray<MasterRecordOption | string>
): MasterLookupIndex {
  const options = toMasterRecordOptions(records);
  const byNormalizedName = new Map<string, MasterRecordOption[]>();
  const byNormalizedCode = new Map<string, MasterRecordOption[]>();

  for (const opt of options) {
    const nameKey = normalizeMasterLookupKey(opt.name);
    if (nameKey) {
      const bucket = byNormalizedName.get(nameKey);
      if (bucket) {
        bucket.push(opt);
      } else {
        byNormalizedName.set(nameKey, [opt]);
      }
    }

    if (opt.code) {
      const codeKey = normalizeMasterLookupKey(opt.code);
      if (codeKey) {
        const bucket = byNormalizedCode.get(codeKey);
        if (bucket) {
          bucket.push(opt);
        } else {
          byNormalizedCode.set(codeKey, [opt]);
        }
      }
    }
  }

  return { options, byNormalizedName, byNormalizedCode };
}

/**
 * Resolves a raw uploaded Excel/API value against an indexed master-data collection.
 *
 * Rules:
 * 1. Trims leading/trailing spaces & collapses repeated whitespace.
 * 2. Performs Unicode NFKC + case-insensitive matching.
 * 3. Preserves the EXISTING website master capitalization & record ID.
 * 4. If multiple existing master records collide on the same normalized key, returns AMBIGUOUS
 *    (never guesses which record to use).
 */
export function matchCanonicalMasterValue(
  rawInput: unknown,
  indexOrRecords: MasterLookupIndex | ReadonlyArray<MasterRecordOption | string>
): MasterMatchResult {
  const index = Array.isArray(indexOrRecords)
    ? buildMasterLookupIndex(indexOrRecords)
    : (indexOrRecords as MasterLookupIndex);

  const originalValue = rawInput === null || rawInput === undefined ? '' : String(rawInput);
  const trimmedValue = normalizeWhitespaceAndUnicode(originalValue);
  const lookupKey = normalizeMasterLookupKey(originalValue);

  if (!lookupKey) {
    return {
      status: 'UNMATCHED',
      originalValue,
      trimmedValue,
      canonicalValue: null,
      masterId: null,
      wasNormalized: false,
      caseNormalized: false,
      whitespaceNormalized: originalValue !== trimmedValue,
      matchedBy: 'none',
      ambiguousCandidates: [],
    };
  }

  // Step 1: Match by normalized master display name (primary)
  const nameMatches = index.byNormalizedName.get(lookupKey) || [];
  if (nameMatches.length > 1) {
    return {
      status: 'AMBIGUOUS',
      originalValue,
      trimmedValue,
      canonicalValue: null,
      masterId: null,
      wasNormalized: false,
      caseNormalized: false,
      whitespaceNormalized: originalValue !== trimmedValue,
      matchedBy: 'none',
      ambiguousCandidates: nameMatches.map((m) => ({
        id: m.id,
        name: m.name,
        code: m.code,
      })),
    };
  }

  if (nameMatches.length === 1) {
    const matched = nameMatches[0];
    const whitespaceNormalized = originalValue !== trimmedValue;
    const caseNormalized = trimmedValue !== matched.name;
    return {
      status: 'MATCHED',
      originalValue,
      trimmedValue,
      canonicalValue: matched.name,
      masterId: matched.id.startsWith('legacy_') ? null : matched.id,
      wasNormalized: whitespaceNormalized || caseNormalized,
      caseNormalized,
      whitespaceNormalized,
      matchedBy: 'name',
      ambiguousCandidates: [],
    };
  }

  // Step 2: Match by normalized master code (fallback when code uniquely identifies master)
  const codeMatches = index.byNormalizedCode.get(lookupKey) || [];
  if (codeMatches.length > 1) {
    return {
      status: 'AMBIGUOUS',
      originalValue,
      trimmedValue,
      canonicalValue: null,
      masterId: null,
      wasNormalized: false,
      caseNormalized: false,
      whitespaceNormalized: originalValue !== trimmedValue,
      matchedBy: 'none',
      ambiguousCandidates: codeMatches.map((m) => ({
        id: m.id,
        name: m.name,
        code: m.code,
      })),
    };
  }

  if (codeMatches.length === 1) {
    const matched = codeMatches[0];
    const whitespaceNormalized = originalValue !== trimmedValue;
    const caseNormalized = trimmedValue !== matched.name;
    return {
      status: 'MATCHED',
      originalValue,
      trimmedValue,
      canonicalValue: matched.name,
      masterId: matched.id.startsWith('legacy_') ? null : matched.id,
      wasNormalized: whitespaceNormalized || caseNormalized,
      caseNormalized,
      whitespaceNormalized,
      matchedBy: 'code',
      ambiguousCandidates: [],
    };
  }

  return {
    status: 'UNMATCHED',
    originalValue,
    trimmedValue,
    canonicalValue: null,
    masterId: null,
    wasNormalized: false,
    caseNormalized: false,
    whitespaceNormalized: originalValue !== trimmedValue,
    matchedBy: 'none',
    ambiguousCandidates: [],
  };
}

/**
 * Checks whether a candidate master record name collides case-insensitively with any
 * other existing master record (used to prevent duplicate master records like STORE / store / Store).
 */
export function findCaseInsensitiveMasterDuplicate(
  candidateName: string,
  candidateId: string | null | undefined,
  existingRecords: ReadonlyArray<MasterRecordOption>
): MasterRecordOption | null {
  const targetKey = normalizeMasterLookupKey(candidateName);
  if (!targetKey) return null;
  for (const rec of existingRecords) {
    if (candidateId && String(rec.id) === String(candidateId)) continue;
    if (normalizeMasterLookupKey(rec.name) === targetKey) {
      return rec;
    }
  }
  return null;
}

/**
 * Builds an unambiguous canonical designation map from existing employees when no dedicated
 * `designations` master collection is configured in Firestore.
 * If existing employees contain conflicting casings for the same designation (e.g. "Operator" & "OPERATOR"),
 * that key is excluded from auto-mapping so free-text values are never guessed.
 */
export function buildUnambiguousDesignationMapFromEmployees(
  employees: ReadonlyArray<{ designation?: string | null }>
): Map<string, string> {
  const variantsByKey = new Map<string, Set<string>>();
  for (const emp of employees) {
    const clean = normalizeWhitespaceAndUnicode(emp.designation);
    if (!clean) continue;
    const key = normalizeMasterLookupKey(clean);
    let set = variantsByKey.get(key);
    if (!set) {
      set = new Set();
      variantsByKey.set(key, set);
    }
    set.add(clean);
  }

  const canonicalMap = new Map<string, string>();
  for (const [key, variants] of variantsByKey.entries()) {
    if (variants.size === 1) {
      canonicalMap.set(key, Array.from(variants)[0]);
    }
  }
  return canonicalMap;
}
