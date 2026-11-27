import { Employee, EmployeeStatus, EmployeeType } from '../types';
import { apiFetchJson } from '../config/api';
import { getAuthHeaders } from './auditService';

export interface EmployeeFilters {
  search?: string;
  floor?: string;
  section?: string;
  department?: string;
  employeeType?: EmployeeType | 'All';
  employeeStatus?: EmployeeStatus | 'All';
}

export interface RenderedQrCardItem {
  qrDataUrl: string;
  qrTokenReference: string;
  hasQrToken: boolean;
}

export interface RegenerateQrResult {
  employeeId: string;
  hasQrToken: boolean;
  qrTokenReference: string;
  qrDataUrl: string;
}

/**
 * Legacy helper retained only for local unit tests / non-authoritative preview models.
 * Authoritative QR tokens are ALWAYS generated server-side via CSPRNG and never returned raw.
 */
export function generateQrToken(employeeId: string): string {
  const rand = Math.random().toString(36).substring(2, 9).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `QR_${employeeId}_${ts}_${rand}`;
}

export async function getEmployees(filters?: EmployeeFilters): Promise<Employee[]> {
  const headers = await getAuthHeaders();
  const params = new URLSearchParams();
  if (filters) {
    if (filters.search && filters.search.trim() !== '') params.set('search', filters.search.trim());
    if (filters.floor && filters.floor !== 'All') params.set('floor', filters.floor);
    if (filters.section && filters.section !== 'All') params.set('section', filters.section);
    if (filters.department && filters.department !== 'All') params.set('department', filters.department);
    if (filters.employeeType && filters.employeeType !== 'All') params.set('employeeType', filters.employeeType);
    if (filters.employeeStatus && filters.employeeStatus !== 'All') params.set('employeeStatus', filters.employeeStatus);
  }
  const qs = params.toString();
  const data = await apiFetchJson<{ success: boolean; employees?: Employee[] }>(
    `/api/employees${qs ? `?${qs}` : ''}`,
    { method: 'GET', headers },
    'Failed to load employees.',
    { preferSameOriginInPreview: true }
  );
  const list = Array.isArray(data.employees) ? data.employees : [];
  return list.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
}

export async function getEmployeeById(employeeId: string): Promise<Employee | null> {
  const cleanId = employeeId.trim().toUpperCase();
  if (!cleanId) return null;
  const headers = await getAuthHeaders();
  try {
    const data = await apiFetchJson<{ success: boolean; employee?: Employee }>(
      `/api/employees/${encodeURIComponent(cleanId)}`,
      { method: 'GET', headers },
      'Failed to load employee.',
      { preferSameOriginInPreview: true }
    );
    return data.employee || null;
  } catch (err: any) {
    if (err?.status === 404 || String(err?.message || '').toLowerCase().includes('not found')) {
      return null;
    }
    throw err;
  }
}

export async function saveEmployee(employee: Partial<Employee>, isNew: boolean): Promise<Employee> {
  if (!employee.employeeId || employee.employeeId.trim() === '') {
    throw new Error('Employee ID is required.');
  }
  const cleanId = employee.employeeId.trim().toUpperCase();
  const headers = await getAuthHeaders();

  const payload = {
    employeeId: cleanId,
    employeeName: (employee.employeeName || '').trim().toUpperCase(),
    employeeType: employee.employeeType || 'Permanent',
    section: employee.section || 'MI',
    department: employee.department || 'Production',
    floor: employee.floor || 'MI-01',
    designation: (employee.designation || 'Operator').trim(),
    employeeStatus: employee.employeeStatus || 'Active',
  };

  if (isNew) {
    const data = await apiFetchJson<{ success: boolean; employee: Employee }>(
      '/api/employees',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
      'Failed to create employee.',
      { preferSameOriginInPreview: true }
    );
    return data.employee;
  }

  const data = await apiFetchJson<{ success: boolean; employee: Employee }>(
    `/api/employees/${encodeURIComponent(cleanId)}`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    },
    'Failed to update employee.',
    { preferSameOriginInPreview: true }
  );
  return data.employee;
}

export async function toggleEmployeeStatus(employeeId: string, newStatus: EmployeeStatus): Promise<void> {
  const cleanId = employeeId.trim().toUpperCase();
  const headers = await getAuthHeaders();
  await apiFetchJson<{ success: boolean }>(
    `/api/employees/${encodeURIComponent(cleanId)}/status`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ employeeStatus: newStatus }),
    },
    'Failed to update employee status.',
    { preferSameOriginInPreview: true }
  );
}

export async function deleteEmployee(employeeId: string): Promise<void> {
  const cleanId = employeeId.trim().toUpperCase();
  const headers = await getAuthHeaders();
  await apiFetchJson<{ success: boolean }>(
    `/api/employees/${encodeURIComponent(cleanId)}`,
    {
      method: 'DELETE',
      headers,
    },
    'Failed to delete employee.',
    { preferSameOriginInPreview: true }
  );
}

/**
 * Manually rotates a single employee's QR token server-side (requires qr_codes.edit).
 * Never returns raw qrCodeToken — returns only qrTokenReference and server-rendered QR PNG data URL.
 */
export async function regenerateQrToken(employeeId: string): Promise<RegenerateQrResult> {
  const cleanId = employeeId.trim().toUpperCase();
  const headers = await getAuthHeaders();
  const data = await apiFetchJson<{
    success: boolean;
    employeeId: string;
    hasQrToken: boolean;
    qrTokenReference: string;
    qrDataUrl: string;
  }>(
    `/api/employees/${encodeURIComponent(cleanId)}/regenerate-qr`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    },
    'Failed to regenerate QR security token.',
    { preferSameOriginInPreview: true }
  );
  return {
    employeeId: data.employeeId || cleanId,
    hasQrToken: Boolean(data.hasQrToken),
    qrTokenReference: data.qrTokenReference || '',
    qrDataUrl: data.qrDataUrl || '',
  };
}

/**
 * Fetches server-rendered scannable QR PNG data URLs for authorized qr_codes.view users.
 * Raw qrCodeToken secrets stay strictly on the server.
 */
export async function fetchEmployeeQrDataUrls(
  employeeIds: string[],
  size = 240
): Promise<Record<string, RenderedQrCardItem>> {
  const cleanIds = Array.from(
    new Set(employeeIds.map((id) => String(id || '').trim().toUpperCase()).filter(Boolean))
  );
  if (cleanIds.length === 0) return {};

  const headers = await getAuthHeaders();
  const clampedSize = Math.max(120, Math.min(600, Math.round(size)));
  const merged: Record<string, RenderedQrCardItem> = {};

  // Server accepts up to 100 IDs per request
  const BATCH = 100;
  for (let i = 0; i < cleanIds.length; i += BATCH) {
    const chunk = cleanIds.slice(i, i + BATCH);
    const data = await apiFetchJson<{
      success: boolean;
      items?: Record<string, RenderedQrCardItem>;
    }>(
      '/api/employees/qr-cards/render',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ employeeIds: chunk, size: clampedSize }),
      },
      'Failed to render employee QR codes.',
      { preferSameOriginInPreview: true }
    );
    if (data.items && typeof data.items === 'object') {
      Object.assign(merged, data.items);
    }
  }

  return merged;
}
