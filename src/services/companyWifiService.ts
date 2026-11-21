import { apiFetchJson, registerCompanyWifiBlockedHandler } from '../config/api';
import { getAuthHeaders } from './auditService';
import {
  COMPANY_WIFI_DENIED_CODE,
  COMPANY_WIFI_DENIED_MESSAGE,
  type CompanyWifiAccessLog,
  type CompanyWifiAccessMode,
  type CompanyWifiCheckResponse,
  type CompanyWifiDashboardResponse,
  type CompanyWifiManagedRoleId,
  type CompanyWifiNetwork,
  type CompanyWifiNetworkStatus,
  type CompanyWifiRolePolicy,
  type CompanyWifiSettings,
} from '../utils/companyWifiUtils';

export interface CompanyWifiBlockedState {
  code: string;
  message: string;
  receivedAtMs: number;
}

type BlockedListener = (state: CompanyWifiBlockedState | null) => void;
const listeners = new Set<BlockedListener>();
let currentBlockedState: CompanyWifiBlockedState | null = null;

export function notifyCompanyWifiBlocked(payload?: Record<string, any>): void {
  const next: CompanyWifiBlockedState = {
    code: String(payload?.code || COMPANY_WIFI_DENIED_CODE),
    message: String(payload?.error || payload?.message || COMPANY_WIFI_DENIED_MESSAGE),
    receivedAtMs: Date.now(),
  };
  currentBlockedState = next;
  listeners.forEach((fn) => {
    try {
      fn(next);
    } catch {
      // Ignore subscriber errors
    }
  });
}

export function clearCompanyWifiBlocked(): void {
  currentBlockedState = null;
  listeners.forEach((fn) => {
    try {
      fn(null);
    } catch {
      // Ignore subscriber errors
    }
  });
}

export function subscribeCompanyWifiBlocked(listener: BlockedListener): () => void {
  listeners.add(listener);
  if (currentBlockedState) {
    listener(currentBlockedState);
  }
  return () => {
    listeners.delete(listener);
  };
}

registerCompanyWifiBlockedHandler((payload) => {
  notifyCompanyWifiBlocked(payload);
});

export async function checkMyCompanyWifiAccess(options?: {
  dry?: boolean;
}): Promise<CompanyWifiCheckResponse> {
  const headers = await getAuthHeaders();
  const query = options?.dry ? '?dry=1' : '';
  try {
    return await apiFetchJson<CompanyWifiCheckResponse>(
      `/api/company-wifi/check${query}`,
      { headers },
      'Failed to verify Company Wi-Fi access.'
    );
  } catch (err: any) {
    if (err?.status === 403 && err?.code === COMPANY_WIFI_DENIED_CODE) {
      return {
        success: false,
        allowed: false,
        enforcementEnabled: true,
        role: String(err?.data?.role || ''),
        code: COMPANY_WIFI_DENIED_CODE,
        error: String(err?.message || COMPANY_WIFI_DENIED_MESSAGE),
      };
    }
    throw err;
  }
}

export async function fetchCompanyWifiDashboard(): Promise<CompanyWifiDashboardResponse> {
  const headers = await getAuthHeaders();
  return apiFetchJson<CompanyWifiDashboardResponse>(
    '/api/company-wifi/dashboard',
    { headers },
    'Failed to load Company Wi-Fi Access Control dashboard.'
  );
}

export async function createCompanyWifiNetwork(payload: {
  networkName: string;
  ipOrCidr: string;
  status: CompanyWifiNetworkStatus;
}): Promise<CompanyWifiNetwork> {
  const headers = await getAuthHeaders();
  const res = await apiFetchJson<{ success: boolean; network: CompanyWifiNetwork }>(
    '/api/company-wifi/networks',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to add Company Wi-Fi network.'
  );
  return res.network;
}

export async function updateCompanyWifiNetwork(
  networkId: string,
  payload: {
    networkName?: string;
    ipOrCidr?: string;
    status?: CompanyWifiNetworkStatus;
  }
): Promise<CompanyWifiNetwork> {
  const headers = await getAuthHeaders();
  const res = await apiFetchJson<{ success: boolean; network: CompanyWifiNetwork }>(
    `/api/company-wifi/networks/${encodeURIComponent(networkId)}`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to update Company Wi-Fi network.'
  );
  return res.network;
}

export async function toggleCompanyWifiNetworkStatus(
  networkId: string,
  status: CompanyWifiNetworkStatus
): Promise<CompanyWifiNetwork> {
  const headers = await getAuthHeaders();
  const res = await apiFetchJson<{ success: boolean; network: CompanyWifiNetwork }>(
    `/api/company-wifi/networks/${encodeURIComponent(networkId)}/status`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status }),
    },
    'Failed to update network status.'
  );
  return res.network;
}

export async function deleteCompanyWifiNetwork(networkId: string): Promise<void> {
  const headers = await getAuthHeaders();
  await apiFetchJson(
    `/api/company-wifi/networks/${encodeURIComponent(networkId)}`,
    {
      method: 'DELETE',
      headers,
    },
    'Failed to delete Company Wi-Fi network.'
  );
}

export async function saveRoleCompanyWifiPolicy(
  roleId: CompanyWifiManagedRoleId,
  payload: {
    accessMode: CompanyWifiAccessMode;
    allowedNetworkIds: string[];
  }
): Promise<CompanyWifiRolePolicy> {
  const headers = await getAuthHeaders();
  const res = await apiFetchJson<{ success: boolean; policy: CompanyWifiRolePolicy }>(
    `/api/company-wifi/policies/${encodeURIComponent(roleId)}`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    },
    `Failed to save ${roleId.toUpperCase()} Wi-Fi access policy.`
  );
  return res.policy;
}

export async function updateCompanyWifiSettings(payload: {
  enforcementEnabled: boolean;
  confirmEnable?: boolean;
  trustedProxyHops?: number;
}): Promise<CompanyWifiSettings> {
  const headers = await getAuthHeaders();
  const res = await apiFetchJson<{ success: boolean; settings: CompanyWifiSettings }>(
    '/api/company-wifi/settings',
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to update enforcement settings.'
  );
  return res.settings;
}

export async function emergencyDisableCompanyWifi(): Promise<CompanyWifiSettings> {
  const headers = await getAuthHeaders();
  const res = await apiFetchJson<{ success: boolean; settings: CompanyWifiSettings }>(
    '/api/company-wifi/emergency-disable',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    },
    'Failed to disable Company Wi-Fi enforcement.'
  );
  return res.settings;
}

export async function fetchCompanyWifiLogs(filters?: {
  eventType?: string;
  result?: string;
  search?: string;
  limit?: number;
}): Promise<{ total: number; logs: CompanyWifiAccessLog[] }> {
  const params = new URLSearchParams();
  if (filters?.eventType && filters.eventType !== 'ALL') params.set('eventType', filters.eventType);
  if (filters?.result && filters.result !== 'all') params.set('result', filters.result);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.limit) params.set('limit', String(filters.limit));

  const headers = await getAuthHeaders();
  const res = await apiFetchJson<{
    success: boolean;
    total: number;
    logs: CompanyWifiAccessLog[];
  }>(
    `/api/company-wifi/logs${params.toString() ? `?${params.toString()}` : ''}`,
    { headers },
    'Failed to load Company Wi-Fi access history.'
  );
  return { total: res.total || 0, logs: res.logs || [] };
}
