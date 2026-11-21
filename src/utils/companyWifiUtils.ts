// ============================================================================
// NARID ATDC Tracker — Company Wi-Fi Access Control Utilities & Shared Types
// Pure deterministic IPv4/IPv6 + CIDR validation and matching (BigInt-safe).
// ============================================================================

export type CompanyWifiNetworkStatus = 'Active' | 'Inactive';
export type CompanyWifiAccessMode = 'RESTRICTED' | 'UNRESTRICTED';
export type CompanyWifiManagedRoleId = 'admin' | 'user';

export type CompanyWifiLogEventType =
  | 'NETWORK_ADDED'
  | 'NETWORK_UPDATED'
  | 'NETWORK_STATUS_CHANGED'
  | 'NETWORK_DELETED'
  | 'POLICY_UPDATED'
  | 'ENFORCEMENT_ENABLED'
  | 'ENFORCEMENT_DISABLED'
  | 'EMERGENCY_DISABLED'
  | 'ACCESS_BLOCKED';

export interface CompanyWifiNetwork {
  networkId: string;
  networkName: string;
  publicIp: string;
  cidrRange: string;
  ipVersion: 'ipv4' | 'ipv6';
  status: CompanyWifiNetworkStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface CompanyWifiRolePolicy {
  roleId: CompanyWifiManagedRoleId;
  allowedNetworkIds: string[];
  accessMode: CompanyWifiAccessMode;
  updatedAt: string;
  updatedBy: string;
}

export interface CompanyWifiSettings {
  enforcementEnabled: boolean;
  trustedProxyHops: number;
  policyVersion: number;
  updatedAt: string;
  updatedBy: string;
}

export interface CompanyWifiAccessLog {
  id: string;
  actorUid: string;
  actorLoginId: string;
  actorRole: string;
  eventType: CompanyWifiLogEventType;
  observedIp: string;
  networkId: string | null;
  networkName?: string | null;
  targetRole?: string | null;
  detail?: string;
  timestamp: string;
  result: 'Allowed' | 'Blocked' | 'Updated';
}

export interface CompanyWifiDashboardSummary {
  enforcementEnabled: boolean;
  totalNetworks: number;
  activeNetworks: number;
  adminAllowedCount: number;
  userAllowedCount: number;
  currentObservedIp: string;
  currentObservedIpIsPublic: boolean;
  currentNetworkMatched: boolean;
  currentMatchedNetworkId: string | null;
  currentMatchedNetworkName: string | null;
  lastPolicyUpdate: string | null;
}

export interface CompanyWifiDashboardResponse {
  success: boolean;
  settings: CompanyWifiSettings;
  summary: CompanyWifiDashboardSummary;
  networks: CompanyWifiNetwork[];
  policies: {
    admin: CompanyWifiRolePolicy;
    user: CompanyWifiRolePolicy;
  };
}

export interface CompanyWifiCheckResponse {
  success: boolean;
  allowed: boolean;
  enforcementEnabled: boolean;
  role: string;
  bypassReason?: string | null;
  matchedNetworkName?: string | null;
  error?: string;
  code?: string;
}

export const COMPANY_WIFI_DENIED_MESSAGE =
  'Access Denied: Please connect to an authorized Company Wi-Fi network.';

export const COMPANY_WIFI_DENIED_CODE = 'COMPANY_WIFI_ACCESS_DENIED';

// ============================================================================
// IPv4 / IPv6 Canonicalization, Validation & Public Range Enforcement
// ============================================================================

export function normalizeIpString(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let clean = raw.trim();
  if (!clean) return '';

  // Strip IPv6 URL brackets e.g. [2001:db8::1]:443
  if (clean.startsWith('[')) {
    const closeIdx = clean.indexOf(']');
    if (closeIdx > 1) {
      clean = clean.slice(1, closeIdx);
    }
  }

  // Strip IPv4 port e.g. 203.0.113.5:54321
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(clean)) {
    clean = clean.split(':')[0];
  }

  // Strip zone ID e.g. fe80::1%eth0
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx > 0) {
    clean = clean.slice(0, zoneIdx);
  }

  // Convert IPv4-mapped IPv6 ::ffff:203.0.113.5 -> 203.0.113.5
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(clean)) {
    clean = clean.replace(/^::ffff:/i, '');
  }

  return clean.toLowerCase();
}

export function parseIpv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    value = (value << 8n) | BigInt(num);
  }
  return value;
}

export function bigIntToIpv4(value: bigint): string {
  const a = Number((value >> 24n) & 0xffn);
  const b = Number((value >> 16n) & 0xffn);
  const c = Number((value >> 8n) & 0xffn);
  const d = Number(value & 0xffn);
  return `${a}.${b}.${c}.${d}`;
}

export function parseIpv6ToBigInt(ip: string): bigint | null {
  const clean = ip.toLowerCase();
  if (!clean.includes(':')) return null;

  let working = clean;
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4ToBigInt(tail);
    if (v4 === null) return null;
    const hi = Number((v4 >> 16n) & 0xffffn).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = working.split('::');
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
  const right =
    doubleColonParts.length === 2 && doubleColonParts[1] ? doubleColonParts[1].split(':') : [];

  const missing =
    doubleColonParts.length === 2 ? 8 - (left.length + right.length) : 8 - left.length;
  if (doubleColonParts.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }

  const groups =
    doubleColonParts.length === 2
      ? [...left, ...Array(missing).fill('0'), ...right]
      : left;

  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

export interface ParsedIpOrCidr {
  valid: boolean;
  normalized: string;
  publicIp: string;
  cidrRange: string;
  version: 'ipv4' | 'ipv6';
  isCidr: boolean;
  prefixLength: number;
  networkInt: bigint;
  error?: string;
}

export function parseIpOrCidr(rawInput: string): ParsedIpOrCidr {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      normalized: '',
      publicIp: '',
      cidrRange: '',
      version: 'ipv4',
      isCidr: false,
      prefixLength: 32,
      networkInt: 0n,
      error: 'Public IP address or CIDR range is required.',
    };
  }

  const slashParts = trimmed.split('/');
  if (slashParts.length > 2) {
    return {
      valid: false,
      normalized: '',
      publicIp: '',
      cidrRange: '',
      version: 'ipv4',
      isCidr: false,
      prefixLength: 32,
      networkInt: 0n,
      error: 'Invalid CIDR format.',
    };
  }

  const ipPart = normalizeIpString(slashParts[0]);
  const hasPrefix = slashParts.length === 2;

  const v4 = parseIpv4ToBigInt(ipPart);
  if (v4 !== null) {
    let prefix = 32;
    if (hasPrefix) {
      if (!/^\d{1,2}$/.test(slashParts[1])) {
        return {
          valid: false,
          normalized: '',
          publicIp: '',
          cidrRange: '',
          version: 'ipv4',
          isCidr: true,
          prefixLength: 32,
          networkInt: 0n,
          error: 'IPv4 CIDR prefix must be between 0 and 32.',
        };
      }
      prefix = Number(slashParts[1]);
      if (prefix < 0 || prefix > 32) {
        return {
          valid: false,
          normalized: '',
          publicIp: '',
          cidrRange: '',
          version: 'ipv4',
          isCidr: true,
          prefixLength: 32,
          networkInt: 0n,
          error: 'IPv4 CIDR prefix must be between 0 and 32.',
        };
      }
    }
    const shift = BigInt(32 - prefix);
    const maskedInt = prefix === 0 ? 0n : (v4 >> shift) << shift;
    const baseIp = hasPrefix ? bigIntToIpv4(maskedInt) : ipPart;
    return {
      valid: true,
      normalized: hasPrefix ? `${baseIp}/${prefix}` : ipPart,
      publicIp: baseIp,
      cidrRange: hasPrefix ? `${baseIp}/${prefix}` : '',
      version: 'ipv4',
      isCidr: hasPrefix,
      prefixLength: prefix,
      networkInt: maskedInt,
    };
  }

  const v6 = parseIpv6ToBigInt(ipPart);
  if (v6 !== null) {
    let prefix = 128;
    if (hasPrefix) {
      if (!/^\d{1,3}$/.test(slashParts[1])) {
        return {
          valid: false,
          normalized: '',
          publicIp: '',
          cidrRange: '',
          version: 'ipv6',
          isCidr: true,
          prefixLength: 128,
          networkInt: 0n,
          error: 'IPv6 CIDR prefix must be between 0 and 128.',
        };
      }
      prefix = Number(slashParts[1]);
      if (prefix < 0 || prefix > 128) {
        return {
          valid: false,
          normalized: '',
          publicIp: '',
          cidrRange: '',
          version: 'ipv6',
          isCidr: true,
          prefixLength: 128,
          networkInt: 0n,
          error: 'IPv6 CIDR prefix must be between 0 and 128.',
        };
      }
    }
    const shift = BigInt(128 - prefix);
    const maskedInt = prefix === 0 ? 0n : (v6 >> shift) << shift;
    return {
      valid: true,
      normalized: hasPrefix ? `${ipPart}/${prefix}` : ipPart,
      publicIp: ipPart,
      cidrRange: hasPrefix ? `${ipPart}/${prefix}` : '',
      version: 'ipv6',
      isCidr: hasPrefix,
      prefixLength: prefix,
      networkInt: maskedInt,
    };
  }

  return {
    valid: false,
    normalized: '',
    publicIp: '',
    cidrRange: '',
    version: 'ipv4',
    isCidr: false,
    prefixLength: 32,
    networkInt: 0n,
    error: 'Must be a valid public IPv4, IPv6, or CIDR range (e.g., 203.0.113.10 or 203.0.113.0/24).',
  };
}

export function ipMatchesCidrOrExact(clientIpRaw: string, allowEntryRaw: string): boolean {
  const clientIp = normalizeIpString(clientIpRaw);
  if (!clientIp) return false;

  const parsedEntry = parseIpOrCidr(allowEntryRaw);
  if (!parsedEntry.valid) return false;

  if (parsedEntry.version === 'ipv4') {
    const clientV4 = parseIpv4ToBigInt(clientIp);
    if (clientV4 === null) return false;
    if (parsedEntry.prefixLength === 0) return true;
    const shift = BigInt(32 - parsedEntry.prefixLength);
    return (clientV4 >> shift) === (parsedEntry.networkInt >> shift);
  }

  const clientV6 = parseIpv6ToBigInt(clientIp);
  if (clientV6 === null) return false;
  if (parsedEntry.prefixLength === 0) return true;
  const shift = BigInt(128 - parsedEntry.prefixLength);
  return (clientV6 >> shift) === (parsedEntry.networkInt >> shift);
}

const NON_PUBLIC_IPV4_RANGES: Array<{ start: bigint; end: bigint; label: string }> = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map((cidr) => {
  const p = parseIpOrCidr(cidr);
  const hostMask = (1n << BigInt(32 - p.prefixLength)) - 1n;
  return {
    start: p.networkInt,
    end: p.networkInt | hostMask,
    label: cidr,
  };
});

const NON_PUBLIC_IPV6_RANGES: Array<{ start: bigint; end: bigint; label: string }> = [
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map((cidr) => {
  const p = parseIpOrCidr(cidr);
  const hostMask = (1n << BigInt(128 - p.prefixLength)) - 1n;
  return {
    start: p.networkInt,
    end: p.networkInt | hostMask,
    label: cidr,
  };
});

export function isPrivateOrNonPublicIp(rawIp: string): boolean {
  const ip = normalizeIpString(rawIp);
  if (!ip || ip === 'unavailable' || ip === 'unknown') return true;
  const parsed = parseIpOrCidr(ip);
  if (!parsed.valid || parsed.isCidr) return true;

  const ranges = parsed.version === 'ipv4' ? NON_PUBLIC_IPV4_RANGES : NON_PUBLIC_IPV6_RANGES;
  return ranges.some((r) => parsed.networkInt >= r.start && parsed.networkInt <= r.end);
}

/**
 * Strictly validates a Company Wi-Fi entry (Public IPv4/IPv6 or Public CIDR range).
 * Rejects invalid formats, private LAN IPs, loopback IPs, link-local/multicast IPs,
 * overly broad wildcard CIDRs (e.g. /0), and any CIDR that overlaps non-public space.
 */
export function validatePublicCompanyWifiIpOrCidr(rawInput: string): ParsedIpOrCidr {
  const parsed = parseIpOrCidr(rawInput);
  if (!parsed.valid) {
    return parsed;
  }

  if (parsed.version === 'ipv4') {
    if (parsed.isCidr && parsed.prefixLength < 16) {
      return {
        ...parsed,
        valid: false,
        error: 'IPv4 CIDR range is too broad. Minimum prefix length is /16 (e.g., 203.0.113.0/24).',
      };
    }
    const hostMask = (1n << BigInt(32 - parsed.prefixLength)) - 1n;
    const rangeStart = parsed.networkInt;
    const rangeEnd = parsed.networkInt | hostMask;

    const overlapping = NON_PUBLIC_IPV4_RANGES.find(
      (r) => rangeStart <= r.end && rangeEnd >= r.start
    );
    if (overlapping) {
      return {
        ...parsed,
        valid: false,
        error: `Private, loopback, or reserved IP ranges (${overlapping.label}) are not allowed. Enter a routable Public IP or CIDR.`,
      };
    }
    return parsed;
  }

  if (parsed.isCidr && parsed.prefixLength < 32) {
    return {
      ...parsed,
      valid: false,
      error: 'IPv6 CIDR range is too broad. Minimum prefix length is /32.',
    };
  }
  const hostMask = (1n << BigInt(128 - parsed.prefixLength)) - 1n;
  const rangeStart = parsed.networkInt;
  const rangeEnd = parsed.networkInt | hostMask;

  const overlapping = NON_PUBLIC_IPV6_RANGES.find(
    (r) => rangeStart <= r.end && rangeEnd >= r.start
  );
  if (overlapping) {
    return {
      ...parsed,
      valid: false,
      error: `Private, loopback, or reserved IPv6 ranges (${overlapping.label}) are not allowed. Enter a routable Public IPv6 or CIDR.`,
    };
  }

  return parsed;
}

export function getNetworkMatchTarget(network: Pick<CompanyWifiNetwork, 'publicIp' | 'cidrRange'>): string {
  const cidr = String(network.cidrRange || '').trim();
  return cidr || String(network.publicIp || '').trim();
}

export function ipMatchesCompanyWifiNetwork(
  observedIp: string,
  network: Pick<CompanyWifiNetwork, 'publicIp' | 'cidrRange' | 'status'>
): boolean {
  if (network.status !== 'Active') return false;
  const target = getNetworkMatchTarget(network);
  if (!target) return false;
  return ipMatchesCidrOrExact(observedIp, target);
}
